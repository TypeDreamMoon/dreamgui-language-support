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
import { registerRefactors } from './refactorActions';
import { registerMailbox } from './mailboxWatcher';
import { registerBridge } from './bridge';
import { registerBridgeCompletion } from './bridgeCompletion';
import { registerBridgeCommands } from './bridgeCommands';
import { registerFormatting } from './formatting';
import { registerBindingIntel } from './bindingIntel';
import { registerDocumentLinks } from './documentLinks';
import { registerRevealWatcher } from './revealWatcher';

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
    const workspaceHost = registerWorkspaceIndex(context);
    registerDiagnostics(context, store, workspaceHost);
    registerColors(context);
    registerSemanticTokens(context);
    registerEditing(context);
    registerFormatting(context);
    registerNewFile(context);
    const mailbox = registerMailbox(context);
    registerStatusBar(context, store, mailbox);
    registerQuickfixes(context, workspaceHost);
    registerExplain(context);
    registerNavigation(context, workspaceHost);
    registerRename(context);
    registerRefactors(context);
    const bridge = registerBridge(context);
    const bridgeCache = registerBridgeCompletion(context, bridge, workspaceHost);
    registerBridgeCommands(context, bridge);
    // After completion: signature help, hover and `Item.` members share its per-class caches.
    registerBindingIntel(context, bridge, bridgeCache, workspaceHost);
    registerDocumentLinks(context, workspaceHost);
    registerRevealWatcher(context, bridge);
    context.subscriptions.push(vscode.commands.registerCommand('dreamui.clearBridgeCache', () => {
        bridgeCache.clear();
        vscode.window.showInformationMessage('DreamUI: bridge caches cleared.');
    }));
}

export function deactivate(): void {}
