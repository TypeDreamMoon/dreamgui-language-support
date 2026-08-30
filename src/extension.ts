/**
 * DreamUI language support: activation and wiring only. The substance is elsewhere -- symbols.ts
 * for what the plugin exported, docmodel.ts for what the open file declares, features.ts and
 * diagnostics.ts for what the editor does with the two.
 */
import * as vscode from 'vscode';
import { SymbolStore } from './symbols';
import { registerFeatures } from './features';
import { registerDiagnostics } from './diagnostics';

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
}

export function deactivate(): void {}
