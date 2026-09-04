/**
 * The bridge's other direction: the Unreal designer asking VS Code to jump to a widget's line.
 *
 * It is a watched FILE rather than a request, because the asymmetry is real -- the editor can be
 * polled and VS Code cannot -- and because a jump is idempotent: the editor overwrites one file
 * (beside-then-rename, as everything on this bridge does) and only its newest stamp matters. A
 * message that arrives while VS Code is closed is a message about a session that is over, so a
 * stamp older than the protocol's staleness budget is read once at startup and thrown away; a
 * stamp already acted on is never acted on twice, which is what makes an overwrite safe.
 *
 * Two watchers, not one. `createFileSystemWatcher` over an absolute RelativePattern does reach
 * outside the workspace -- the project's Saved/ folder rarely is inside it -- but it is a
 * platform watcher with a platform's exclusions, and this file lives under a directory some
 * setups tell their watcher to ignore wholesale. `fs.watchFile` is a one-file stat poll: it costs
 * a stat a second per project and it cannot be configured away. Both funnel into one handler,
 * which the stamp check makes duplicate-proof.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BridgeClient } from './bridge';
import {
    bridgePaths, parseRevealToEditor, revealToEditorPath,
    REVEAL_TO_EDITOR_FILE, REVEAL_TO_EDITOR_STALE_MS,
} from './core/bridgeProtocol';

const POLL_INTERVAL_MS = 1000;

class RevealWatcher implements vscode.Disposable {
    /** Keyed by the reveal file's path: one project, one watch pair. */
    private readonly watching = new Map<string, vscode.Disposable[]>();
    /** The last stamp acted on (or deliberately skipped) per file. */
    private readonly handled = new Map<string, string>();

    constructor(private readonly bridge: BridgeClient) {}

    /** Starts watching the project a .dui belongs to, if it is not watched already. */
    ensureWatchingFor(documentPath: string | undefined): void {
        const projectDir = this.bridge.resolveProjectDir(documentPath);
        if (!projectDir) {
            return;
        }
        const filePath = revealToEditorPath(projectDir, path.join);
        if (this.watching.has(filePath)) {
            return;
        }
        const disposables: vscode.Disposable[] = [];
        this.watching.set(filePath, disposables);

        const directory = bridgePaths(projectDir, path.join).root;
        try {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(directory), REVEAL_TO_EDITOR_FILE));
            disposables.push(watcher);
            disposables.push(watcher.onDidCreate(() => void this.handle(filePath, false)));
            disposables.push(watcher.onDidChange(() => void this.handle(filePath, false)));
        } catch {
            // A pattern the host refuses (an unmounted drive, say): the poll below still works.
        }
        try {
            const listener = (): void => void this.handle(filePath, false);
            fs.watchFile(filePath, { persistent: false, interval: POLL_INTERVAL_MS }, listener);
            disposables.push(new vscode.Disposable(() => fs.unwatchFile(filePath, listener)));
        } catch {
            // Nothing to undo: watchFile either registered or it did not.
        }

        // The file that is already there belongs to whatever ran before this window did.
        void this.handle(filePath, true);
    }

    private async handle(filePath: string, atStartup: boolean): Promise<void> {
        let message;
        try {
            message = parseRevealToEditor(fs.readFileSync(filePath, 'utf8'));
        } catch {
            return; // not written yet, or half-written: the next event carries the whole of it
        }
        if (!message || this.handled.get(filePath) === message.stampUtc) {
            return;
        }
        // Recorded either way: a stamp declined as stale must not be reconsidered when the
        // platform watcher reports the very same file a moment later.
        this.handled.set(filePath, message.stampUtc);
        if (atStartup && Date.now() - Date.parse(message.stampUtc) > REVEAL_TO_EDITOR_STALE_MS) {
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(message.file));
            const editor = await vscode.window.showTextDocument(document, { preview: false });
            const line = Math.min(Math.max(0, message.line - 1), Math.max(0, document.lineCount - 1));
            const text = document.lineAt(line).text;
            // The id is what the designer had in mind; the column is where it thinks it starts.
            // Selecting the id itself survives a file the editor has not re-read since an edit,
            // which is the common case for a message that arrives while the author is typing.
            const found = message.widgetId ? text.indexOf(message.widgetId) : -1;
            const range = found >= 0
                ? new vscode.Range(line, found, line, found + message.widgetId.length)
                : new vscode.Range(line, Math.min(message.column - 1, text.length),
                    line, Math.min(message.column - 1, text.length));
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        } catch {
            // The designer named a file this window cannot open. Said once, because the author
            // just clicked something over there and silence would look like a broken button.
            void vscode.window.showWarningMessage(
                `DreamUI: the Unreal designer asked for '${message.file}', which could not be opened.`);
        }
    }

    dispose(): void {
        for (const disposables of this.watching.values()) {
            for (const disposable of disposables) {
                disposable.dispose();
            }
        }
        this.watching.clear();
    }
}

export function registerRevealWatcher(context: vscode.ExtensionContext, bridge: BridgeClient): void {
    const watcher = new RevealWatcher(bridge);
    context.subscriptions.push(watcher);

    watcher.ensureWatchingFor(vscode.window.activeTextEditor?.document.uri.fsPath);
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === 'dui') {
            watcher.ensureWatchingFor(editor.document.uri.fsPath);
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => {
        if (document.languageId === 'dui') {
            watcher.ensureWatchingFor(document.uri.fsPath);
        }
    }));
}
