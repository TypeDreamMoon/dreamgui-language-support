/**
 * Quickfixes for the two diagnostics whose fix is mechanical: an unknown resource gets declared,
 * an unknown style gets created. Both are pure insertions planned in core; nothing existing moves.
 */
import * as vscode from 'vscode';
import { buildModel } from './docmodel';
import { planDeclareResource, planCreateStyle, EditPlan } from './core/quickfixes';

export function registerQuickfixes(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ language: 'dui' }, {
        provideCodeActions(document, _range, actionContext) {
            const actions: vscode.CodeAction[] = [];
            const model = buildModel(document);

            const toAction = (title: string, plan: EditPlan, diagnostic: vscode.Diagnostic): vscode.CodeAction => {
                const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                action.diagnostics = [diagnostic];
                action.isPreferred = true;
                action.edit = new vscode.WorkspaceEdit();
                action.edit.insert(document.uri, document.positionAt(plan.offset), plan.text);
                return action;
            };

            for (const diagnostic of actionContext.diagnostics) {
                if (diagnostic.code === 'DUI4007') {
                    // The range covers '@Name'; the name is the text minus its '@'.
                    const name = document.getText(diagnostic.range).replace(/^@/, '');
                    if (name) {
                        actions.push(toAction(`Declare resource '${name}'`,
                            planDeclareResource(model.structure, name, document.getText().length), diagnostic));
                    }
                } else if (diagnostic.code === 'DUI3004') {
                    // The range covers the style name, at a wearing site or a base clause alike.
                    const name = document.getText(diagnostic.range);
                    if (/^[^\s{}():=]+$/.test(name)) {
                        actions.push(toAction(`Create style '${name}'`,
                            planCreateStyle(model.structure, name, document.getText().length), diagnostic));
                    }
                }
            }
            return actions;
        },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
}
