/**
 * F2 over the core's rename planner. The one piece of UX that lives here: after an id rename the
 * author is told, once, that localization keys changed with the id and '@key' can pin the old
 * ones -- '(was:)' migrates references, it cannot migrate translations.
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
                throw new Error('这里没有可改名的东西 —— id、样式名、资源名和循环变量可以改。');
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

            if (plan.localizationKeysChange) {
                void vscode.window.showInformationMessage(
                    `id 改名会连带改变本地化 key(${target.name}.* → ${newName}.*),已有译文会成孤儿。`
                    + `要钉住旧 key,在对应文本属性行写 @key("${target.name}.属性名")。`
                    + `下次编译时 (was:) 会迁移图引用、绑定和动画。`);
            }
            return edit;
        },
    }));
}
