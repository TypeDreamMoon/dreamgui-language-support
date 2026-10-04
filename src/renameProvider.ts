/**
 * F2 over the core's rename planner. The one piece of UX that lives here: after a rename the
 * author is told, once, what the rename could not reach --
 *
 *   - an id: localization keys changed with it, and '@key' can pin the old ones ('(was:)' migrates
 *     references, it cannot migrate translations);
 *   - an unnamed node given its first id: the same for the keys its made-up id carried, and no
 *     '(was:)', since nothing could reference a hidden member;
 *   - an alias, a prop or an event: other files spell it too (a library's re-export, a host's
 *     `Label = …` or `Picked -> …`), and this rename only edits this one.
 */
import * as vscode from 'vscode';
import { buildModel } from './docmodel';
import { renameTargetAt, planRename } from './core/rename';

export function registerRename(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.languages.registerRenameProvider({ language: 'dui' }, {
        prepareRename(document, position) {
            const model = buildModel(document);
            const target = renameTargetAt(model.structure, document.offsetAt(position));
            if (!target) {
                throw new Error('这里没有可改名的东西 —— id、未命名节点的类型、样式名、资源名、循环变量、'
                    + 'use … as 的名字、prop 和 event 可以改。');
            }
            if (target.kind === 'slotFill') {
                // Refused up front, with the reason: the name is the component's, not this file's.
                const plan = planRename(model.structure, target, target.name);
                throw new Error('error' in plan ? plan.error : '这个名字不能在这里改。');
            }
            return {
                range: new vscode.Range(document.positionAt(target.start), document.positionAt(target.end)),
                placeholder: target.name,
            };
        },
        provideRenameEdits(document, position, newName) {
            const model = buildModel(document);
            const target = renameTargetAt(model.structure, document.offsetAt(position));
            if (!target) {
                return undefined;
            }
            const plan = planRename(model.structure, target, newName.trim());
            if ('error' in plan) {
                throw new Error(plan.error);
            }

            const edit = new vscode.WorkspaceEdit();
            for (const change of plan.edits) {
                edit.replace(document.uri,
                    new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)),
                    change.newText);
            }

            const name = newName.trim();
            if (target.kind === 'anonymousNode') {
                void vscode.window.showInformationMessage(
                    `未命名节点有了 id:${name}。本地化 key 从 ${target.name}.* 变为 ${name}.*,已有译文会成孤儿;`
                    + '它原来的 id 是隐藏成员,没有任何引用,所以不写 (was:)。');
            } else if (plan.localizationKeysChange) {
                void vscode.window.showInformationMessage(
                    `id 改名会连带改变本地化 key(${target.name}.* → ${name}.*),已有译文会成孤儿。`
                    + `要钉住旧 key,在对应文本属性行写 @key("${target.name}.属性名")。`
                    + `下次编译时 (was:) 会迁移图引用、绑定和动画。`);
            } else if (target.kind === 'alias') {
                void vscode.window.showInformationMessage(
                    `只改了本文件里的 ${target.name}。如果这是库的 use … as,`
                    + '通过 use 这个库来使用它的其他文件需要各自改。');
            } else if (target.kind === 'prop' || target.kind === 'event') {
                void vscode.window.showInformationMessage(
                    `只改了本文件里的 ${target.name}。实例化这个组件的其他文件里`
                    + `${target.kind === 'prop' ? `设置 ${target.name} 的行` : `路由 ${target.name} 的 -> 行`}需要各自改。`);
            }
            return edit;
        },
    }));
}
