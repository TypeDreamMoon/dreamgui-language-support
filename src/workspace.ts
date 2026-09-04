/**
 * The vscode host for the workspace index: discovers every .dui the window can see, keeps the
 * index current from four feeds (a workspace file watcher, edits to open documents, files opened
 * from outside the workspace, and a filesystem scan of the roots those files belong to), and hands
 * the core index to whichever provider asks.
 *
 * Open documents win over the disk: an unsaved edit is what the author means right now.
 *
 * The fourth feed exists because `vscode.workspace.findFiles` sees nothing at all in a window with
 * no folder open, and opening one .dui on its own -- double-clicked from Explorer, opened from the
 * Unreal editor's "reveal" -- is how this language is most often read. In such a window the index
 * was permanently empty, which is not a missing feature but a wrong answer: an empty index makes
 * every `use` resolve to nothing, and every style an import brings in reports DUI3004. So the host
 * finds the DUI root the file belongs to and reads it itself.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceIndex } from './core/workspaceIndex';

/**
 * What makes a directory a DUI root, in the order a walk upwards meets them. The name `DUI` is the
 * convention the plugin's own path resolution uses; the three files are what a root that has been
 * lived in leaves behind, and any of them is better evidence than the name.
 */
const ROOT_MARKERS = ['.dui-symbols.json', 'DreamUI.code-workspace', '.dui-diagnostics.json'];

/** Far enough to climb out of `DUI/Styles/Buttons/`, short enough never to reach the drive root. */
const MAX_ROOT_HOPS = 12;

/** A root is a hand-written tree, not a repository: this depth is a runaway, not a deep project. */
const MAX_SCAN_DEPTH = 16;

/**
 * fs.watch says "something changed" more than once for one save, and on Windows it can say it
 * before the writer has closed the file. Long enough to coalesce a save, short enough that the
 * squiggles move while the author is still looking at them.
 */
const WATCH_DEBOUNCE_MS = 120;

function isDuiDocument(document: vscode.TextDocument): boolean {
    return document.languageId === 'dui' && document.uri.scheme === 'file';
}

export class WorkspaceIndexHost implements vscode.Disposable {
    readonly index = new WorkspaceIndex();
    private sweep: Promise<void> | undefined;
    /** One entry per adopted root, keyed by comparable path; the value is its one and only scan. */
    private readonly rootScans = new Map<string, Promise<void>>();
    private readonly watchers: fs.FSWatcher[] = [];
    private readonly debounced = new Map<string, ReturnType<typeof setTimeout>>();
    private disposed = false;
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
            if (isDuiDocument(document)) {
                this.apply(document.uri.fsPath, document.getText());
                // Adopted, not awaited: this handler owes the caller nothing, and whoever needs the
                // root read before judging says so by calling ensureScannedFor.
                this.adoptRootFor(document.uri.fsPath);
            }
        }));
        this.disposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
            if (isDuiDocument(event.document)) {
                this.apply(event.document.uri.fsPath, event.document.getText());
            }
        }));
    }

    /**
     * Everything the index can currently know: one workspace sweep, plus every root adopted for a
     * file open outside the workspace. Run lazily on first use, and each root read exactly once.
     */
    ensureScanned(): Promise<void> {
        return this.ensureScannedFor(undefined);
    }

    /**
     * The same wait, with the root that `documentPath` belongs to guaranteed to be among the ones
     * waited for -- which matters on the very first keystroke in a file the open handler has not
     * been called for (a document restored with the window is never "opened").
     */
    ensureScannedFor(documentPath: string | undefined): Promise<void> {
        this.sweep ??= this.sweepWorkspace();
        if (documentPath) {
            this.adoptRootFor(documentPath);
        }
        return this.settle();
    }

    private async settle(): Promise<void> {
        await this.sweep;
        // Documents already open before anything asked: each one outside every workspace folder
        // brings a root of its own.
        for (const document of vscode.workspace.textDocuments) {
            if (isDuiDocument(document)) {
                this.adoptRootFor(document.uri.fsPath);
            }
        }
        // Roots adopted while an earlier root was being read are waited for too. The loop ends
        // because a root is adopted at most once and a scan adopts none.
        let awaited = 0;
        while (this.rootScans.size > awaited) {
            const pending = [...this.rootScans.values()];
            awaited = pending.length;
            await Promise.all(pending);
        }
    }

    private async sweepWorkspace(): Promise<void> {
        const files = await vscode.workspace.findFiles('**/*.dui');
        await Promise.all(files.map((uri) => this.updateFromDisk(uri)));
        for (const document of vscode.workspace.textDocuments) {
            if (isDuiDocument(document)) {
                this.apply(document.uri.fsPath, document.getText());
            }
        }
    }

    // ---- roots -------------------------------------------------------------------------------

    /**
     * The DUI root a file outside the workspace belongs to: the nearest ancestor named `DUI` or
     * carrying one of the marker files, and failing both the file's own directory.
     *
     * A file INSIDE a workspace folder gets none: findFiles already covers it, and adopting a
     * second reader for the same tree would only mean scanning it twice and watching it twice.
     */
    private rootFor(documentPath: string): string | undefined {
        if (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(documentPath))) {
            return undefined;
        }
        const own = path.dirname(documentPath);
        if (path.dirname(own) === own) {
            // The file sits at a drive root, or the path is not a real one at all (an untitled
            // buffer's). Either way the fallback below would hand a whole volume to the scanner.
            return undefined;
        }
        let directory = own;
        for (let hop = 0; hop < MAX_ROOT_HOPS; hop++) {
            if (path.basename(directory).toLowerCase() === 'dui') {
                return directory;
            }
            for (const marker of ROOT_MARKERS) {
                if (existsQuietly(path.join(directory, marker))) {
                    return directory;
                }
            }
            const parent = path.dirname(directory);
            if (parent === directory) {
                break;
            }
            directory = parent;
        }
        // No evidence of a root anywhere above: the file's own directory is the honest guess, and
        // a wrong-but-small guess costs one directory read.
        return own;
    }

    private adoptRootFor(documentPath: string): void {
        if (this.disposed) {
            return;
        }
        const root = this.rootFor(documentPath);
        if (!root) {
            return;
        }
        const key = comparablePath(root);
        for (const known of this.rootScans.keys()) {
            // Already read, or read as part of a wider root. The reverse -- a wider root adopted
            // after a narrower one -- reads the narrow tree twice, which costs a directory walk and
            // changes no answer, so it is left alone rather than bookkept.
            if (key === known || key.startsWith(known + path.sep)) {
                return;
            }
        }
        this.rootScans.set(key, this.scanRoot(root));
        this.watchRoot(root);
    }

    /** Never rejects: a root that cannot be read leaves the index as it was, not the host broken. */
    private async scanRoot(root: string): Promise<void> {
        const found: string[] = [];
        const walk = async (directory: string, depth: number): Promise<void> => {
            if (depth > MAX_SCAN_DEPTH) {
                return;
            }
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(directory, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                // Dot-directories and node_modules hold no .dui and can hold a great many files.
                if (entry.isDirectory()) {
                    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
                        continue;
                    }
                    await walk(path.join(directory, entry.name), depth + 1);
                } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dui')) {
                    found.push(path.join(directory, entry.name));
                }
            }
        };
        await walk(root, 0);
        await Promise.all(found.map((file) => this.updateFromDisk(vscode.Uri.file(file))));
    }

    private watchRoot(root: string): void {
        try {
            // Recursive is supported on Windows and macOS, which is where this path is used at all;
            // where it is not, the throw lands in the catch and the root stays a one-shot read.
            const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
                if (!filename) {
                    // Windows occasionally reports a change with no name. Nothing to re-read, and
                    // re-walking the tree on every such event would be a scan per keystroke.
                    return;
                }
                const relative = String(filename);
                if (!relative.toLowerCase().endsWith('.dui')) {
                    return;
                }
                this.queueDiskUpdate(path.resolve(root, relative));
            });
            // A watched tree that is unplugged (a network share, a deleted folder) must not take
            // the extension host with it.
            watcher.on('error', () => watcher.close());
            this.watchers.push(watcher);
        } catch {
            // No watcher: the root was still read once, which is the difference that matters.
        }
    }

    /** One re-read per file per burst: fs.watch fires several times for one save. */
    private queueDiskUpdate(file: string): void {
        const key = comparablePath(file);
        const existing = this.debounced.get(key);
        if (existing !== undefined) {
            clearTimeout(existing);
        }
        this.debounced.set(key, setTimeout(() => {
            this.debounced.delete(key);
            if (!this.disposed) {
                // Deletion arrives here too: updateFromDisk drops what it cannot read.
                void this.updateFromDisk(vscode.Uri.file(file));
            }
        }, WATCH_DEBOUNCE_MS));
    }

    // ---- the index -----------------------------------------------------------------------------

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
        this.disposed = true;
        for (const timer of this.debounced.values()) {
            clearTimeout(timer);
        }
        this.debounced.clear();
        for (const watcher of this.watchers) {
            try {
                watcher.close();
            } catch {
                // Already closed by its own error handler.
            }
        }
        this.watchers.length = 0;
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.changed.dispose();
    }
}

/** Windows compares paths case insensitively and this map is keyed on the answer, not the spelling. */
function comparablePath(target: string): string {
    const resolved = path.resolve(target);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function existsQuietly(target: string): boolean {
    try {
        return fs.existsSync(target);
    } catch {
        return false;
    }
}

export function registerWorkspaceIndex(context: vscode.ExtensionContext): WorkspaceIndexHost {
    const host = new WorkspaceIndexHost();
    context.subscriptions.push(host);
    return host;
}
