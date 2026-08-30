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

    constructor() {
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.dui');
        this.disposables.push(watcher);
        this.disposables.push(watcher.onDidCreate((uri) => void this.updateFromDisk(uri)));
        this.disposables.push(watcher.onDidChange((uri) => void this.updateFromDisk(uri)));
        this.disposables.push(watcher.onDidDelete((uri) => this.index.remove(uri.fsPath)));

        this.disposables.push(vscode.workspace.onDidOpenTextDocument((document) => {
            if (document.languageId === 'dui' && document.uri.scheme === 'file') {
                this.index.update(document.uri.fsPath, document.getText());
            }
        }));
        this.disposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.languageId === 'dui' && event.document.uri.scheme === 'file') {
                this.index.update(event.document.uri.fsPath, event.document.getText());
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
                    this.index.update(document.uri.fsPath, document.getText());
                }
            }
        })();
        return this.scanned;
    }

    private async updateFromDisk(uri: vscode.Uri): Promise<void> {
        const open = vscode.workspace.textDocuments.find(
            (document) => document.uri.toString() === uri.toString());
        if (open) {
            this.index.update(uri.fsPath, open.getText());
            return;
        }
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            this.index.update(uri.fsPath, Buffer.from(bytes).toString('utf8'));
        } catch {
            this.index.remove(uri.fsPath);
        }
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}

export function registerWorkspaceIndex(context: vscode.ExtensionContext): WorkspaceIndexHost {
    const host = new WorkspaceIndexHost();
    context.subscriptions.push(host);
    return host;
}
