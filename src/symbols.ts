/**
 * The symbols the Unreal plugin exports: the `symbols` table of `Intermediate/DreamSource/ui.db`
 * (DreamSource layout), or the `DUI/.dui-symbols.json` an older plugin writes.
 *
 * This extension never guesses at the language. Every tag, property, enum value and component name
 * it offers comes from this dump, which the plugin regenerates from the compiler's own tables on
 * editor startup -- so what completion offers is exactly what the compiler accepts. No dump means
 * degraded mode: grammar and structure features keep working, symbol-driven ones quietly wait.
 *
 * The database and the file hold the same object (core/dreamSource.reassembleSymbols puts the rows
 * back together), so everything past loading is the same code for both.
 *
 * One exception, and a bounded one: a dump an OLDER plugin wrote lacks the tables the component
 * grammar added (keywords, prop types, container node types, `Shown`). Those are supplied from the
 * language reference by core/symbolFacts until the editor rewrites the file -- never in place of
 * what a dump does say.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    PropertyInfo, ClassInfo, SymbolData, TagKind, normalizeSymbols, nodeTypeNames, isContainerType,
    propertiesForTag as corePropertiesForTag,
} from './core/symbolFacts';
import { readSymbolsObject } from './core/sourceDatabase';
import { DreamSourceHost } from './dreamSourceHost';

// The dump's shape and what it means live in core, where an old dump and a new one are tested side by side; these
// names are re-exported so every provider keeps importing them from here.
export type { PropertyInfo, ClassInfo, SymbolData, TagKind } from './core/symbolFacts';

const LEGACY_SYMBOLS_FILE = '.dui-symbols.json';

/** Where the symbols come from: the editor's database, or a JSON dump (an older plugin's, or a configured path). */
interface SymbolSource {
    kind: 'database' | 'json';
    path: string;
}

export class SymbolStore {
    private data: SymbolData | undefined;
    private loadedFrom: SymbolSource | undefined;
    /** The database's symbols revision the loaded data came from. */
    private loadedRevision: number | undefined;
    private watcher: fs.FSWatcher | undefined;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;

    constructor(private readonly host: DreamSourceHost) {
        this.subscriptions.push(host.onDidChangeDatabase((change) => {
            if (this.loadedFrom?.kind === 'database' && this.loadedFrom.path === change.databasePath
                && change.revisions.symbols !== this.loadedRevision) {
                this.load(this.loadedFrom);
            }
        }));
    }

    get symbols(): SymbolData | undefined {
        return this.data;
    }

    /** The database or file the symbols were read from. */
    get sourcePath(): string | undefined {
        return this.loadedFrom?.path;
    }

    dispose(): void {
        this.watcher?.close();
        this.subscriptions.forEach((subscription) => subscription.dispose());
        this.changed.dispose();
    }

    /** Finds and loads the symbols for a document (or any workspace folder). */
    ensureLoadedFor(documentPath?: string): void {
        const found = this.locate(documentPath);
        if (!found) {
            return;
        }
        if (found.path !== this.loadedFrom?.path) {
            this.load(found);
        }
    }

    reload(): void {
        this.host.invalidate();
        const current = this.loadedFrom;
        this.loadedFrom = undefined;
        this.ensureLoadedFor(vscode.window.activeTextEditor?.document.uri.fsPath);
        if (!this.loadedFrom && current && fs.existsSync(current.path)) {
            this.load(current);
        }
    }

    private locate(documentPath?: string): SymbolSource | undefined {
        const configured = vscode.workspace.getConfiguration('dreamui').get<string>('symbolsPath');
        if (configured && fs.existsSync(configured)) {
            return { kind: 'json', path: configured };
        }
        // The editor's database first: it is what a DreamSource-era plugin writes, and nothing else.
        const projectDir = this.host.projectDirFor(documentPath);
        if (projectDir) {
            const database = this.host.databaseFor(projectDir);
            if (database && this.host.revisionsOf(database)?.symbols !== undefined) {
                return { kind: 'database', path: database };
            }
        }
        return this.locateLegacyFile(documentPath, projectDir);
    }

    /**
     * An older plugin's `.dui-symbols.json`: at the root of the DUI/ tree, found by walking up from
     * the file. Capped so a file outside any project cannot walk to the drive root finding nothing
     * forever.
     */
    private locateLegacyFile(documentPath: string | undefined, projectDir: string | undefined): SymbolSource | undefined {
        if (documentPath) {
            let dir = path.dirname(documentPath);
            for (let hops = 0; hops < 12; hops++) {
                const candidate = path.join(dir, LEGACY_SYMBOLS_FILE);
                if (fs.existsSync(candidate)) {
                    return { kind: 'json', path: candidate };
                }
                const parent = path.dirname(dir);
                if (parent === dir) {
                    break;
                }
                dir = parent;
            }
        }
        const candidates: string[] = [];
        if (projectDir) {
            const root = this.host.sourceRoot(projectDir);
            if (root.activeDir) {
                candidates.push(path.join(root.activeDir, LEGACY_SYMBOLS_FILE));
            }
        }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            candidates.push(path.join(folder.uri.fsPath, 'DUI', LEGACY_SYMBOLS_FILE));
            candidates.push(path.join(folder.uri.fsPath, LEGACY_SYMBOLS_FILE));
        }
        const found = candidates.find((candidate) => fs.existsSync(candidate));
        return found ? { kind: 'json', path: found } : undefined;
    }

    private load(source: SymbolSource): void {
        try {
            let raw: unknown;
            let revision: number | undefined;
            if (source.kind === 'database') {
                // The revision first: a write landing between the two reads is then picked up by the next change.
                revision = this.host.revisionsOf(source.path)?.symbols;
                raw = readSymbolsObject(source.path);
                if (raw === undefined) {
                    return; // unreadable this instant (a write in flight); the change event brings it back
                }
            } else {
                raw = JSON.parse(fs.readFileSync(source.path, 'utf8'));
            }
            // Normalized on the way in: an older plugin's dump has no keywords, no container entries and no `Shown`,
            // and every lookup below is written against the shape the current plugin writes.
            this.data = normalizeSymbols(raw);
            this.loadedFrom = source;
            this.loadedRevision = revision;
            this.watch(source);
            this.changed.fire();
        } catch (error) {
            // A half-written file (the plugin saves atomically enough, but editors happen): keep
            // whatever was loaded before rather than degrade mid-session.
            console.warn(`DreamUI: could not read ${source.path}:`, error);
        }
    }

    private watch(source: SymbolSource): void {
        this.watcher?.close();
        this.watcher = undefined;
        if (source.kind === 'database') {
            // The host watches the database; its change event reloads us (constructor).
            this.host.watchDatabase(source.path);
            return;
        }
        try {
            // The plugin rewrites this on every editor startup; picking that up live is what keeps a
            // long VSCode session in step with a recompiled plugin.
            this.watcher = fs.watch(source.path, { persistent: false }, () => {
                setTimeout(() => this.load(source), 200);
            });
        } catch {
            this.watcher = undefined;
        }
    }

    // ---- lookups the providers share -----------------------------------------------------------

    /**
     * Properties addressable by a bare name on a node of this tag: the widget's, then the tag's visual's -- or, for a
     * container-typed node (`VerticalBox Column`), its container's. See core/symbolFacts for the order.
     */
    propertiesForTag(tag: string | undefined): PropertyInfo[] {
        return corePropertiesForTag(this.data, tag);
    }

    /** Every node type the dump knows -- visuals, registered widgets, containers -- with its kind. */
    nodeTypes(): { name: string; kind: TagKind }[] {
        return nodeTypeNames(this.data);
    }

    isContainer(tag: string): boolean {
        return isContainerType(this.data, tag);
    }

    /**
     * The property face of a style body. A style can be worn by a node of ANY tag, so its lines
     * can land on any visual: the honest completion set is the union of every tag's properties
     * plus the widget's, first spelling wins on a name shared across tags.
     */
    propertiesForStyle(): PropertyInfo[] {
        if (!this.data) {
            return [];
        }
        const seen = new Map<string, PropertyInfo>();
        for (const info of Object.values(this.data.tags)) {
            for (const property of info.properties ?? []) {
                if (!seen.has(property.name)) {
                    seen.set(property.name, property);
                }
            }
        }
        for (const property of this.data.widgetProperties ?? []) {
            if (!seen.has(property.name)) {
                seen.set(property.name, property);
            }
        }
        return [...seen.values()];
    }

    eventsForTag(tag: string | undefined): string[] {
        if (!this.data) {
            return [];
        }
        const out: string[] = [];
        if (tag && this.data.tags[tag]?.events) {
            out.push(...this.data.tags[tag].events!);
        }
        out.push(...(this.data.widgetEvents ?? []));
        return out;
    }

    componentInfo(name: string): ClassInfo | undefined {
        if (!this.data) {
            return undefined;
        }
        if (this.data.components[name]) {
            return this.data.components[name];
        }
        // `+ /Script/Module.Class` spells the class in full; match on the class half.
        const leaf = name.split('.').pop();
        for (const info of Object.values(this.data.components)) {
            if (info.class === leaf) {
                return info;
            }
        }
        return undefined;
    }

    findProperty(list: PropertyInfo[], name: string): PropertyInfo | undefined {
        return list.find((p) => p.name === name);
    }

    enumValues(enumName: string | undefined): string[] {
        if (!enumName || !this.data) {
            return [];
        }
        return this.data.enums[enumName]?.values ?? [];
    }
}
