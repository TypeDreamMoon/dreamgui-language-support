/**
 * The vscode host for the workspace index: discovers every .dui the window can see, keeps the
 * index current from three feeds (a filesystem watcher, edits to open documents, files opened
 * from outside the workspace), and hands the core index to whichever provider asks.
 *
 * Open documents win over the disk: an unsaved edit is what the author means right now.
 */
import * as vscode from 'vscode';
import { WorkspaceIndex } from './core/workspaceIndex';

export class WorkspaceIndexHost implements vscode.Disposable {
    readonly index = new WorkspaceIndex();
    private scanned: Promise<void> | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly changed = new vscode.EventEmitter<string>();
    /**
     * Fires with the path of every file the index just took in or dropped. Anything that judged a
     * file against the index (the import exemptions in diagnostics, above all) is stale the moment
     * a library it imports arrives, changes or leaves, and this is how it finds out.
     */
    readonly onDidChange = this.changed.event;

    constructor() {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.dui');
        this.disposables.push(watcher);
        this.disposables.push(watcher.onDidCreate((uri) => void this.updateFromDisk(uri)));
        this.disposables.push(watcher.onDidChange((uri) => void this.updateFromDisk(uri)));
        this.disposables.push(watcher.onDidDelete((uri) => this.drop(uri.fsPath)));

        this.disposables.push(vscode.workspace.onDidOpenTextDocument((document) => {
            if (document.languageId === 'dui' && document.uri.scheme === 'file') {
                this.apply(document.uri.fsPath, document.getText());
            }
        }));
        this.disposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.languageId === 'dui' && event.document.uri.scheme === 'file') {
                this.apply(event.document.uri.fsPath, event.document.getText());
            }
        }));
    }

    /** One workspace sweep, run lazily on first use and shared by every later caller. */
    ensureScanned(): Promise<void> {
        this.scanned ??= (async () => {
            const files = await vscode.workspace.findFiles('**/*.dui');
            await Promise.all(files.map((uri) => this.updateFromDisk(uri)));
            for (const document of vscode.workspace.textDocuments) {
                if (document.languageId === 'dui' && document.uri.scheme === 'file') {
                    this.apply(document.uri.fsPath, document.getText());
                }
            }
        })();
        return this.scanned;
    }

    private async updateFromDisk(uri: vscode.Uri): Promise<void> {
        const open = vscode.workspace.textDocuments.find(
            (document) => document.uri.toString() === uri.toString());
        if (open) {
            this.apply(uri.fsPath, open.getText());
            return;
        }
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            this.apply(uri.fsPath, Buffer.from(bytes).toString('utf8'));
        } catch {
            this.drop(uri.fsPath);
        }
    }

    /** The one door into the index, so every change -- sweep, watcher, edit -- is announced. */
    private apply(file: string, text: string): void {
        this.index.update(file, text);
        this.changed.fire(file);
    }

    private drop(file: string): void {
        this.index.remove(file);
        this.changed.fire(file);
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.changed.dispose();
    }
}

export function registerWorkspaceIndex(context: vscode.ExtensionContext): WorkspaceIndexHost {
    const host = new WorkspaceIndexHost();
    context.subscriptions.push(host);
    return host;
}
