/**
 * Watches `DUI/.dui-diagnostics.json` and pours it into a second diagnostic collection,
 * 'dui-compiler' -- the compiler's verdicts beside the extension's own live checks, never mixed:
 * two collections cannot fight over one squiggle, and codes the extension already raises locally
 * are dropped from the mailbox side (the local one is fresher than any compile).
 *
 * Locating the mailbox walks up from the open file exactly as the symbols file does: both live at
 * the DUI/ root the plugin owns.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseMailbox, mailboxDiagnosticsToShow, Mailbox } from './core/mailbox';
import { formatCode } from './core/scanner';

const MAILBOX_FILE = '.dui-diagnostics.json';

export class MailboxWatcher implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('dui-compiler');
    private watcher: fs.FSWatcher | undefined;
    private watchedPath: string | undefined;
    /** The last good read; kept through half-written files. */
    private mailbox: Mailbox | undefined;
    lastLoadedAt: Date | undefined;

    dispose(): void {
        this.watcher?.close();
        this.collection.dispose();
    }

    get isConnected(): boolean {
        return this.mailbox !== undefined;
    }

    /** Finds (or re-finds) the mailbox near a .dui, then loads and watches it. */
    ensureWatchingFor(documentPath: string | undefined): void {
        const found = this.locate(documentPath);
        if (!found || found === this.watchedPath) {
            return;
        }
        this.watchedPath = found;
        this.load(found);
        this.watcher?.close();
        try {
            this.watcher = fs.watch(found, { persistent: false }, () => {
                // The editor writes beside-then-rename; a small delay lets the rename land.
                setTimeout(() => this.load(found), 100);
            });
        } catch {
            this.watcher = undefined;
        }
    }

    private locate(documentPath: string | undefined): string | undefined {
        if (documentPath) {
            let directory = path.dirname(documentPath);
            for (let hops = 0; hops < 12; hops++) {
                const candidate = path.join(directory, MAILBOX_FILE);
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
                const parent = path.dirname(directory);
                if (parent === directory) {
                    break;
                }
                directory = parent;
            }
        }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            for (const candidate of [
                path.join(folder.uri.fsPath, 'DUI', MAILBOX_FILE),
                path.join(folder.uri.fsPath, MAILBOX_FILE),
            ]) {
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }
        return undefined;
    }

    private load(filePath: string): void {
        let parsed: Mailbox | undefined;
        try {
            parsed = parseMailbox(fs.readFileSync(filePath, 'utf8'));
        } catch {
            parsed = undefined;
        }
        if (!parsed) {
            // A half-written or foreign file: keep showing the last good read.
            return;
        }
        this.mailbox = parsed;
        this.lastLoadedAt = new Date();
        this.publish();
    }

    private publish(): void {
        this.collection.clear();
        if (!this.mailbox) {
            return;
        }
        for (const [file, entry] of Object.entries(this.mailbox.files)) {
            const uri = vscode.Uri.file(file);
            const open = vscode.workspace.textDocuments.find(
                (document) => document.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase());
            const diagnostics = mailboxDiagnosticsToShow(entry).map((source) => {
                const position = new vscode.Position(Math.max(0, source.line - 1), Math.max(0, source.column - 1));
                // With the document at hand the squiggle covers the word; blind, one character.
                const range = open?.getWordRangeAtPosition(position, /[@#\w. -￿]+/u)
                    ?? new vscode.Range(position, position.translate(0, 1));
                const diagnostic = new vscode.Diagnostic(range,
                    `${formatCode(source.code)}: ${source.message}`,
                    source.severity === 'error'
                        ? vscode.DiagnosticSeverity.Error
                        : vscode.DiagnosticSeverity.Warning);
                diagnostic.code = formatCode(source.code);
                diagnostic.source = 'dui-compiler';
                return diagnostic;
            });
            this.collection.set(uri, diagnostics);
        }
    }
}

export function registerMailbox(context: vscode.ExtensionContext): MailboxWatcher {
    const watcher = new MailboxWatcher();
    context.subscriptions.push(watcher);

    watcher.ensureWatchingFor(vscode.window.activeTextEditor?.document.uri.fsPath);
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === 'dui') {
            watcher.ensureWatchingFor(editor.document.uri.fsPath);
        }
    }));
    // Re-anchor ranges when a mailbox-known file gets opened.
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => {
        if (document.languageId === 'dui') {
            watcher.ensureWatchingFor(document.uri.fsPath);
        }
    }));
    return watcher;
}
