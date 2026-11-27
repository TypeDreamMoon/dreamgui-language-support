/**
 * Pours the compiler's verdicts into a second diagnostic collection, 'dui-compiler' -- beside the
 * extension's own live checks, never mixed: two collections cannot fight over one squiggle, and
 * codes the extension already raises locally are dropped from the mailbox side (the local one is
 * fresher than any compile).
 *
 * The verdicts come from the `diagnostics` table of `Intermediate/DreamSource/ui.db` (DreamSource
 * layout), or from the `DUI/.dui-diagnostics.json` an older plugin writes, found by walking up from
 * the open file exactly as the symbols file is. Both are turned into the same version-1 mailbox,
 * so everything past reading is one code path.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseMailbox, mailboxDiagnosticsToShow, Mailbox } from './core/mailbox';
import { formatCode } from './core/scanner';
import { readMailboxText } from './core/sourceDatabase';
import { linkedCode } from './codeLinks';
import { DreamSourceHost } from './dreamSourceHost';

const LEGACY_MAILBOX_FILE = '.dui-diagnostics.json';

interface MailboxSource {
    kind: 'database' | 'json';
    path: string;
}

export class MailboxWatcher implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('dui-compiler');
    private watcher: fs.FSWatcher | undefined;
    private watched: MailboxSource | undefined;
    private loadedRevision: number | undefined;
    private readonly subscriptions: vscode.Disposable[] = [];
    /** The last good read; kept through half-written files. */
    private mailbox: Mailbox | undefined;
    lastLoadedAt: Date | undefined;

    constructor(private readonly host: DreamSourceHost) {
        this.subscriptions.push(host.onDidChangeDatabase((change) => {
            if (this.watched?.kind === 'database' && this.watched.path === change.databasePath
                && change.revisions.diagnostics !== this.loadedRevision) {
                this.load(this.watched);
            }
        }));
    }

    dispose(): void {
        this.watcher?.close();
        this.subscriptions.forEach((subscription) => subscription.dispose());
        this.collection.dispose();
    }

    get isConnected(): boolean {
        return this.mailbox !== undefined;
    }

    /** Where the verdicts were read from, for the status bar. */
    get sourcePath(): string | undefined {
        return this.watched?.path;
    }

    /** Finds (or re-finds) the mailbox near a .dui, then loads and watches it. */
    ensureWatchingFor(documentPath: string | undefined): void {
        const found = this.locate(documentPath);
        if (!found || found.path === this.watched?.path) {
            return;
        }
        this.watched = found;
        this.load(found);
        this.watcher?.close();
        this.watcher = undefined;
        if (found.kind === 'database') {
            this.host.watchDatabase(found.path);
            return;
        }
        try {
            this.watcher = fs.watch(found.path, { persistent: false }, () => {
                // The editor writes beside-then-rename; a small delay lets the rename land.
                setTimeout(() => this.load(found), 100);
            });
        } catch {
            this.watcher = undefined;
        }
    }

    /** Drop what is watched and look again: the folders just moved. */
    relocate(documentPath: string | undefined): void {
        this.watched = undefined;
        this.ensureWatchingFor(documentPath);
    }

    private locate(documentPath: string | undefined): MailboxSource | undefined {
        const projectDir = this.host.projectDirFor(documentPath);
        if (projectDir) {
            // A database is watched even before its editor delivers any verdicts (load() then holds back): the old
            // JSON beside it is a previous plugin's and says nothing about this session.
            const database = this.host.databaseFor(projectDir);
            if (database) {
                return { kind: 'database', path: database };
            }
        }
        if (documentPath) {
            let directory = path.dirname(documentPath);
            for (let hops = 0; hops < 12; hops++) {
                const candidate = path.join(directory, LEGACY_MAILBOX_FILE);
                if (fs.existsSync(candidate)) {
                    return { kind: 'json', path: candidate };
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
                path.join(folder.uri.fsPath, 'DUI', LEGACY_MAILBOX_FILE),
                path.join(folder.uri.fsPath, LEGACY_MAILBOX_FILE),
            ]) {
                if (fs.existsSync(candidate)) {
                    return { kind: 'json', path: candidate };
                }
            }
        }
        return undefined;
    }

    private load(source: MailboxSource): void {
        let parsed: Mailbox | undefined;
        let revision: number | undefined;
        try {
            if (source.kind === 'database') {
                revision = this.host.revisionsOf(source.path)?.diagnostics;
                if (revision === undefined) {
                    return; // no compile has delivered yet: "nothing seen", as a missing file was
                }
                const text = readMailboxText(source.path);
                parsed = text !== undefined ? parseMailbox(text) : undefined;
            } else {
                parsed = parseMailbox(fs.readFileSync(source.path, 'utf8'));
            }
        } catch {
            parsed = undefined;
        }
        if (!parsed) {
            // A half-written or foreign file, or a database mid-write: keep showing the last good read.
            return;
        }
        this.mailbox = parsed;
        this.loadedRevision = revision;
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
                const range = open?.getWordRangeAtPosition(position, /[@#\w. -￿]+/u)
                    ?? new vscode.Range(position, position.translate(0, 1));
                const diagnostic = new vscode.Diagnostic(range,
                    `${formatCode(source.code)}: ${source.message}`,
                    source.severity === 'error'
                        ? vscode.DiagnosticSeverity.Error
                        : vscode.DiagnosticSeverity.Warning);
                diagnostic.code = linkedCode(source.code);
                diagnostic.source = 'dui-compiler';
                return diagnostic;
            });
            this.collection.set(uri, diagnostics);
        }
    }
}

export function registerMailbox(context: vscode.ExtensionContext, host: DreamSourceHost): MailboxWatcher {
    const watcher = new MailboxWatcher(host);
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
