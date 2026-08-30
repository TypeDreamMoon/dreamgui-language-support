/**
 * DreamUI language support: activation and wiring only. The substance is elsewhere -- symbols.ts
 * for what the plugin exported, docmodel.ts for what the open file declares, features.ts and
 * diagnostics.ts for what the editor does with the two.
 */
import * as vscode from 'vscode';
import { SymbolStore } from './symbols';
import { registerFeatures } from './features';
import { registerDiagnostics } from './diagnostics';
import { registerColors } from './colors';
import { registerSemanticTokens } from './semanticTokens';
import { registerEditing } from './editing';
import { registerNewFile } from './newFile';
import { registerStatusBar } from './statusBar';
import { registerQuickfixes } from './quickfix';
import { registerExplain } from './explain';
import { registerWorkspaceIndex } from './workspace';
import { registerNavigation } from './navigation';
import { registerRename } from './renameProvider';

export function activate(context: vscode.ExtensionContext): void {
    const store = new SymbolStore();
    context.subscriptions.push(store);

    store.ensureLoadedFor(vscode.window.activeTextEditor?.document.uri.fsPath);

    context.subscriptions.push(vscode.commands.registerCommand('dreamui.reloadSymbols', () => {
        store.reload();
        vscode.window.showInformationMessage(store.sourcePath
            ? `DreamUI: symbols reloaded from ${store.sourcePath}`
            : 'DreamUI: no .dui-symbols.json found. Open the Unreal editor once (or run DreamUI.ExportSymbols in its console) with a DUI/ directory in the project.');
    }));

    registerFeatures(context, store);
    registerDiagnostics(context, store);
    registerColors(context);
    registerSemanticTokens(context);
    registerEditing(context);
    registerNewFile(context);
    registerStatusBar(context, store);
    registerQuickfixes(context);
    registerExplain(context);
    const workspaceHost = registerWorkspaceIndex(context);
    registerNavigation(context, workspaceHost);
    registerRename(context);
}

export function deactivate(): void {}
