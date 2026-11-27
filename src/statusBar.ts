/**
 * The symbols' visibility. Without this, missing symbols (no ui.db, no .dui-symbols.json) are a silent downgrade:
 * completion quietly shrinks to grammar-only and the author never learns why. One status bar item,
 * shown while a .dui is active: what is loaded, or what to do about nothing being loaded. Click =
 * reload.
 */
import * as vscode from 'vscode';
import { SymbolStore } from './symbols';
import { MailboxWatcher } from './mailboxWatcher';

export function registerStatusBar(context: vscode.ExtensionContext, store: SymbolStore,
    mailbox: MailboxWatcher): void {
    const item = vscode.window.createStatusBarItem('dreamui.symbols', vscode.StatusBarAlignment.Right, 90);
    item.name = 'DreamUI Symbols';
    item.command = 'dreamui.reloadSymbols';
    context.subscriptions.push(item);

    const refresh = (): void => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'dui') {
            item.hide();
            return;
        }
        store.ensureLoadedFor(editor.document.uri.fsPath);
        const compilerLine = mailbox.isConnected
            ? `Compiler diagnostics: connected (last delivery ${mailbox.lastLoadedAt?.toLocaleTimeString() ?? '—'}).`
            : 'Compiler diagnostics: none delivered yet — semantic checks need the Unreal editor running; '
            + 'what you see here is the grammar-level truth only.';
        if (store.symbols) {
            const tags = Object.keys(store.symbols.tags ?? {}).length;
            const components = Object.keys(store.symbols.components ?? {}).length;
            item.text = '$(symbol-color) DUI';
            item.tooltip = new vscode.MarkdownString(
                `**DreamUI symbols loaded** — ${tags} tags, ${components} components\n\n`
                + `\`${store.sourcePath}\`\n\n${compilerLine}\n\nClick to reload.`);
            item.backgroundColor = undefined;
        } else {
            item.text = '$(warning) DUI';
            item.tooltip = new vscode.MarkdownString(
                '**No symbols found** — completion is running on grammar alone.\n\n'
                + 'Open the project in the Unreal editor once (or run `DreamUI.ExportSymbols` in its '
                + 'console) with a `DreamSource/UI/` folder present; it writes '
                + '`Intermediate/DreamSource/ui.db`. Then click to reload.');
            item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
        item.show();
    };

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(refresh));
    context.subscriptions.push(store.onDidChange(refresh));
    refresh();
}
