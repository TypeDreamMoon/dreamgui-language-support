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

/**
 * The id this extension had up to 0.9.1. The Marketplace had the name reserved, so 0.9.2 took a new
 * one, and VS Code sees a copy installed under the old id as a different extension: two of them
 * register `.dui` and every diagnostic, completion and hover comes twice.
 */
const OLD_ID = 'typedreammoon.dreamui-language-support';

function warnAboutOldCopy(): void {
    if (!vscode.extensions.getExtension(OLD_ID)) {
        return;
    }
    const uninstall = 'Uninstall the old copy';
    void vscode.window.showWarningMessage(
        `DreamUI: an older copy of this extension is installed under its previous id (${OLD_ID}); `
        + 'with both enabled, .dui files get every diagnostic and suggestion twice.',
        uninstall,
    ).then(async (choice) => {
        if (choice !== uninstall) {
            return;
        }
        await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', OLD_ID);
        const reload = 'Reload Window';
        if (await vscode.window.showInformationMessage('DreamUI: the old copy is uninstalled.', reload) === reload) {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    });
}

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

    // The index first: completion, hover and semantic tokens read what a file borrows through its `use` lines.
    const workspaceHost = registerWorkspaceIndex(context);
    registerFeatures(context, store, workspaceHost);
    registerDiagnostics(context, store, workspaceHost);
    registerColors(context);
    registerSemanticTokens(context, workspaceHost);
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
    warnAboutOldCopy();
}

export function deactivate(): void {}
