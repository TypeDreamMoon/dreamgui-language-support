/**
 * The DreamSource layout, wired to the disk and the window: which project a file belongs to,
 * where its UI sources are (core/dreamSource.ts decides), and the editor's `ui.db` -- whether it
 * can be read here, and when it changes.
 *
 * One instance per window, shared by the symbols store, the compiler-diagnostics mailbox, the
 * new-file command and the migration prompt, so they agree on every answer.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    DREAM_UI, DatabaseRevisions, PluginSourceRoot, ProjectSourceRoot, SUPPORTED_SCHEMA, SourceFs,
    databasePath, findProjectRoot, pluginSourceRoots, resolveProjectSourceRoot,
} from './core/dreamSource';
import { isSqliteAvailable, isSupportedSchema, readRevisions } from './core/sourceDatabase';

export const nodeFs: SourceFs = {
    isDirectory(target) {
        try {
            return fs.statSync(target).isDirectory();
        } catch {
            return false;
        }
    },
    isFile(target) {
        try {
            return fs.statSync(target).isFile();
        } catch {
            return false;
        }
    },
    readText(target) {
        try {
            return fs.readFileSync(target, 'utf8');
        } catch {
            return undefined;
        }
    },
    list(target) {
        try {
            return fs.readdirSync(target);
        } catch {
            return [];
        }
    },
};

export interface DatabaseChange {
    databasePath: string;
    revisions: DatabaseRevisions;
}

/**
 * fs.watch reports one commit as several events (the -wal file, then the database at a
 * checkpoint), and on Windows before the writer is done. One read per burst.
 */
const DATABASE_DEBOUNCE_MS = 150;

/** How long "is there a readable ui.db here" is believed: it is asked on every completion. */
const DATABASE_MEMO_MS = 1000;

interface DatabaseWatch {
    watcher: fs.FSWatcher | undefined;
    timer: ReturnType<typeof setTimeout> | undefined;
    last: DatabaseRevisions | undefined;
}

export class DreamSourceHost implements vscode.Disposable {
    readonly sqliteAvailable = isSqliteAvailable();
    private readonly projectDirCache = new Map<string, string | undefined>();
    private readonly databaseMemo = new Map<string, { at: number; path: string | undefined }>();
    private readonly watches = new Map<string, DatabaseWatch>();
    private readonly warnedSchema = new Set<string>();
    private readonly changed = new vscode.EventEmitter<DatabaseChange>();
    /** Fires when a watched ui.db's revisions moved; consumers compare the part they hold. */
    readonly onDidChangeDatabase = this.changed.event;

    dispose(): void {
        for (const watch of this.watches.values()) {
            watch.watcher?.close();
            if (watch.timer) {
                clearTimeout(watch.timer);
            }
        }
        this.watches.clear();
        this.changed.dispose();
    }

    /**
     * The project a file belongs to (the nearest .uproject above it), or with no file the first
     * workspace folder that is in (or under) a project.
     */
    projectDirFor(documentPath?: string): string | undefined {
        if (documentPath) {
            const directory = path.dirname(documentPath);
            if (!this.projectDirCache.has(directory)) {
                this.projectDirCache.set(directory, findProjectRoot(directory, nodeFs, path.dirname));
            }
            const found = this.projectDirCache.get(directory);
            if (found) {
                return found;
            }
        }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (folder.uri.scheme !== 'file') {
                continue;
            }
            const directory = folder.uri.fsPath;
            if (!this.projectDirCache.has(directory)) {
                this.projectDirCache.set(directory, findProjectRoot(directory, nodeFs, path.dirname));
            }
            const found = this.projectDirCache.get(directory);
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    /** Where the project's UI sources are, read fresh: the folders move under us when a migration runs. */
    sourceRoot(projectDir: string): ProjectSourceRoot {
        return resolveProjectSourceRoot(projectDir, DREAM_UI, nodeFs, path.join);
    }

    pluginRoots(projectDir: string): PluginSourceRoot[] {
        return pluginSourceRoots(projectDir, DREAM_UI, nodeFs, path.join);
    }

    /**
     * The project's ui.db when it can be read here -- `node:sqlite` present, the file there, its
     * schema the one this extension knows -- else undefined, and the callers read the old JSON.
     */
    databaseFor(projectDir: string): string | undefined {
        if (!this.sqliteAvailable) {
            return undefined;
        }
        const memo = this.databaseMemo.get(projectDir);
        const now = Date.now();
        if (memo && now - memo.at < DATABASE_MEMO_MS) {
            return memo.path;
        }
        const candidate = databasePath(projectDir, DREAM_UI, path.join);
        let answer: string | undefined;
        if (nodeFs.isFile(candidate)) {
            const revisions = readRevisions(candidate);
            if (isSupportedSchema(revisions)) {
                answer = candidate;
            } else if (revisions && !this.warnedSchema.has(candidate)) {
                this.warnedSchema.add(candidate);
                void vscode.window.showWarningMessage(
                    `DreamUI: ${candidate} has schema ${revisions.schema ?? '?'}, this extension reads schema `
                    + `${SUPPORTED_SCHEMA}. Update the extension or the DreamGUI plugin so the two match.`);
            }
        }
        this.databaseMemo.set(projectDir, { at: now, path: answer });
        return answer;
    }

    /** The revisions last seen for a watched database. */
    revisionsOf(databaseFile: string): DatabaseRevisions | undefined {
        return this.watches.get(databaseFile)?.last ?? readRevisions(databaseFile);
    }

    /**
     * Watches a database's directory for the database and its -wal file. The directory, not the
     * files: the -wal comes and goes with checkpoints, and a watch on a file that is not there yet
     * hears nothing.
     */
    watchDatabase(databaseFile: string): void {
        if (this.watches.has(databaseFile)) {
            return;
        }
        const watch: DatabaseWatch = { watcher: undefined, timer: undefined, last: readRevisions(databaseFile) };
        this.watches.set(databaseFile, watch);
        const base = path.basename(databaseFile).toLowerCase();
        try {
            watch.watcher = fs.watch(path.dirname(databaseFile), { persistent: false }, (_event, fileName) => {
                const name = fileName?.toString().toLowerCase();
                if (name && name !== base && name !== `${base}-wal`) {
                    return;
                }
                if (watch.timer) {
                    clearTimeout(watch.timer);
                }
                watch.timer = setTimeout(() => {
                    watch.timer = undefined;
                    const revisions = readRevisions(databaseFile);
                    if (!revisions) {
                        return;
                    }
                    const last = watch.last;
                    watch.last = revisions;
                    if (!last || last.revision !== revisions.revision || last.symbols !== revisions.symbols
                        || last.diagnostics !== revisions.diagnostics || last.schema !== revisions.schema) {
                        this.databaseMemo.clear();
                        this.changed.fire({ databasePath: databaseFile, revisions });
                    }
                }, DATABASE_DEBOUNCE_MS);
            });
        } catch {
            watch.watcher = undefined;
        }
    }

    /** Forget cached answers; a migration just moved the folders. */
    invalidate(): void {
        this.projectDirCache.clear();
        this.databaseMemo.clear();
    }
}
