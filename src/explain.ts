/**
 * "Explain DUInnnn": a code action on any diagnostic that carries a code, opening the bundled
 * explanation as a rendered markdown preview (virtual document -- nothing touches disk). The
 * offline stand-in for the docs site's DUInnnn pages.
 */
import * as vscode from 'vscode';
import { explainCode } from './core/codes';

const SCHEME = 'dreamui-code';

export function registerExplain(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        provideTextDocumentContent(uri) {
            const code = Number.parseInt(uri.path.replace(/\D/g, ''), 10);
            return explainCode(code) ?? `# ${uri.path}\n\n这个码不在内置码表里。`;
        },
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dreamui.explainCode', async (code: number) => {
        const uri = vscode.Uri.parse(`${SCHEME}:DUI${code}.md`);
        await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
    }));

    context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ language: 'dui' }, {
        provideCodeActions(_document, _range, actionContext) {
            const actions: vscode.CodeAction[] = [];
            const seen = new Set<number>();
            for (const diagnostic of actionContext.diagnostics) {
                const match = /^DUI(\d{4})$/.exec(String(diagnostic.code ?? ''));
                if (!match) {
                    continue;
                }
                const code = Number.parseInt(match[1], 10);
                if (seen.has(code) || !explainCode(code)) {
                    continue;
                }
                seen.add(code);
                const action = new vscode.CodeAction(`解释 DUI${code}`, vscode.CodeActionKind.QuickFix);
                action.diagnostics = [diagnostic];
                action.command = { command: 'dreamui.explainCode', title: 'Explain', arguments: [code] };
                actions.push(action);
            }
            return actions;
        },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
}
