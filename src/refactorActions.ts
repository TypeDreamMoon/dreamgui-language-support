/**
 * The refactor entries: lightbulbs decide what is offerable, the commands collect the one thing
 * the planner cannot know (the new name) and apply. All judgement lives in core/refactors.
 */
import * as vscode from 'vscode';
import { buildModel } from './docmodel';
import {
    extractableLiteralAt, countMatchingLiterals, planExtractResource,
    planExtractStyle, wornStyleAt, planInlineStyle, RefactorPlan,
} from './core/refactors';
import { RenameEdit } from './core/rename';

async function applyPlan(document: vscode.TextDocument, plan: RefactorPlan): Promise<void> {
    if ('error' in plan) {
        void vscode.window.showErrorMessage(`DreamUI: ${plan.error}`);
        return;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const change of plan.edits as RenameEdit[]) {
        edit.replace(document.uri,
            new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)),
            change.newText);
    }
    await vscode.workspace.applyEdit(edit);
}

async function askName(prompt: string): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({ prompt, validateInput: (value) => value.trim() ? undefined : '名字不能为空。' });
    return name?.trim();
}

export function registerRefactors(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand('dreamui.extractResource',
        async (uri: vscode.Uri, offset: number, replaceAll: boolean) => {
            const document = await vscode.workspace.openTextDocument(uri);
            const model = buildModel(document);
            const source = document.getText();
            const literal = extractableLiteralAt(model.structure, source, offset);
            if (!literal) {
                return;
            }
            const name = await askName(`把 ${literal.text} 提取为 ${literal.resourceType} 资源,叫什么名字?`);
            if (!name) {
                return;
            }
            await applyPlan(document, planExtractResource(model.structure, source, literal, name, replaceAll));
        }));

    context.subscriptions.push(vscode.commands.registerCommand('dreamui.extractStyle',
        async (uri: vscode.Uri, start: number, end: number) => {
            const document = await vscode.workspace.openTextDocument(uri);
            const model = buildModel(document);
            const name = await askName('提取为样式,叫什么名字?');
            if (!name) {
                return;
            }
            await applyPlan(document, planExtractStyle(model.structure, document.getText(), start, end, name));
        }));

    context.subscriptions.push(vscode.commands.registerCommand('dreamui.inlineStyle',
        async (uri: vscode.Uri, offset: number) => {
            const document = await vscode.workspace.openTextDocument(uri);
            const model = buildModel(document);
            const node = wornStyleAt(model.structure, offset);
            if (!node) {
                return;
            }
            await applyPlan(document, planInlineStyle(model.structure, document.getText(), node));
        }));

    context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ language: 'dui' }, {
        provideCodeActions(document, range) {
            const model = buildModel(document);
            const source = document.getText();
            const actions: vscode.CodeAction[] = [];
            const offset = document.offsetAt(range.start);

            const literal = extractableLiteralAt(model.structure, source, offset);
            if (literal) {
                const one = new vscode.CodeAction(
                    `提取 ${literal.text} 为资源...`, vscode.CodeActionKind.RefactorExtract);
                one.command = {
                    command: 'dreamui.extractResource', title: 'extract',
                    arguments: [document.uri, offset, false],
                };
                actions.push(one);
                const matches = countMatchingLiterals(model.structure, source, literal);
                if (matches > 1) {
                    const all = new vscode.CodeAction(
                        `提取 ${literal.text} 为资源并替换全部 ${matches} 处...`, vscode.CodeActionKind.RefactorExtract);
                    all.command = {
                        command: 'dreamui.extractResource', title: 'extract all',
                        arguments: [document.uri, offset, true],
                    };
                    actions.push(all);
                }
            }

            if (!range.isEmpty) {
                const action = new vscode.CodeAction('提取选中的属性为样式...', vscode.CodeActionKind.RefactorExtract);
                action.command = {
                    command: 'dreamui.extractStyle', title: 'extract style',
                    arguments: [document.uri, document.offsetAt(range.start), document.offsetAt(range.end)],
                };
                actions.push(action);
            }

            // Only a style this file declares can be inlined: one a `use` brought in (or `: ns.Label`) lives in
            // another file, and offering the action only to refuse it is a lightbulb that lies.
            const worn = wornStyleAt(model.structure, offset);
            const declaredHere = worn !== undefined && model.structure.styles.some(
                (style) => style.name.toLowerCase() === worn.styleName!.toLowerCase());
            if (worn && declaredHere) {
                const action = new vscode.CodeAction(
                    `内联样式 '${worn.styleName}'`, vscode.CodeActionKind.RefactorInline);
                action.command = {
                    command: 'dreamui.inlineStyle', title: 'inline style',
                    arguments: [document.uri, offset],
                };
                actions.push(action);
            }
            return actions;
        },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.RefactorExtract, vscode.CodeActionKind.RefactorInline] }));
}
