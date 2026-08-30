/**
 * The symbols file the Unreal plugin writes: `DUI/.dui-symbols.json`.
 *
 * This extension never guesses at the language. Every tag, property, enum value and component name
 * it offers comes from this file, which the plugin regenerates from the compiler's own tables on
 * editor startup -- so what completion offers is exactly what the compiler accepts. No file means
 * degraded mode: grammar and structure features keep working, symbol-driven ones quietly wait.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface PropertyInfo {
    name: string;
    type: string;
    enum?: string;
    literal?: string;
    /** The UPROPERTY tooltip, as the details panel shows it. */
    tooltip?: string;
    /** The class default, spelled the way this language reads it back. */
    default?: string;
}

export interface ClassInfo {
    class?: string;
    tooltip?: string;
    properties?: PropertyInfo[];
    events?: string[];
}

export interface SymbolData {
    version: number;
    tags: Record<string, ClassInfo>;
    widgetProperties: PropertyInfo[];
    widgetEvents: string[];
    slotProperties: PropertyInfo[];
    components: Record<string, ClassInfo>;
    enums: Record<string, { values: string[] }>;
    resourceTypes: string[];
}

const SYMBOLS_FILE = '.dui-symbols.json';

export class SymbolStore {
    private data: SymbolData | undefined;
    private loadedFrom: string | undefined;
    private watcher: fs.FSWatcher | undefined;
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;

    get symbols(): SymbolData | undefined {
        return this.data;
    }

    get sourcePath(): string | undefined {
        return this.loadedFrom;
    }

    dispose(): void {
        this.watcher?.close();
        this.changed.dispose();
    }

    /** Finds and loads the symbols file for a document (or any workspace folder). */
    ensureLoadedFor(documentPath?: string): void {
        const found = this.locate(documentPath);
        if (!found) {
            return;
        }
        if (found !== this.loadedFrom) {
            this.loadFile(found);
        }
    }

    reload(): void {
        if (this.loadedFrom && fs.existsSync(this.loadedFrom)) {
            this.loadFile(this.loadedFrom);
        } else {
            this.loadedFrom = undefined;
            this.ensureLoadedFor(vscode.window.activeTextEditor?.document.uri.fsPath);
        }
    }

    private locate(documentPath?: string): string | undefined {
        const configured = vscode.workspace.getConfiguration('dreamui').get<string>('symbolsPath');
        if (configured && fs.existsSync(configured)) {
            return configured;
        }
        // Walk up from the file: a .dui lives somewhere under a DUI/ root, and the symbols file
        // sits at that root. Capped so a file outside any project cannot walk to the drive root
        // finding nothing forever.
        if (documentPath) {
            let dir = path.dirname(documentPath);
            for (let hops = 0; hops < 12; hops++) {
                const candidate = path.join(dir, SYMBOLS_FILE);
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
                const parent = path.dirname(dir);
                if (parent === dir) {
                    break;
                }
                dir = parent;
            }
        }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            for (const candidate of [
                path.join(folder.uri.fsPath, 'DUI', SYMBOLS_FILE),
                path.join(folder.uri.fsPath, SYMBOLS_FILE),
            ]) {
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }
        return undefined;
    }

    private loadFile(filePath: string): void {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SymbolData;
            this.data = parsed;
            this.loadedFrom = filePath;
            this.watch(filePath);
            this.changed.fire();
        } catch (error) {
            // A half-written file (the plugin saves atomically enough, but editors happen): keep
            // whatever was loaded before rather than degrade mid-session.
            console.warn(`DreamUI: could not read ${filePath}:`, error);
        }
    }

    private watch(filePath: string): void {
        this.watcher?.close();
        try {
            // The plugin rewrites this on every editor startup; picking that up live is what keeps a
            // long VSCode session in step with a recompiled plugin.
            this.watcher = fs.watch(filePath, { persistent: false }, () => {
                setTimeout(() => this.loadFile(filePath), 200);
            });
        } catch {
            this.watcher = undefined;
        }
    }

    // ---- lookups the providers share -----------------------------------------------------------

    /** Properties addressable by a bare name on a node of this tag: the tag's visual + the widget. */
    propertiesForTag(tag: string | undefined): PropertyInfo[] {
        if (!this.data) {
            return [];
        }
        const out: PropertyInfo[] = [];
        if (tag && this.data.tags[tag]?.properties) {
            out.push(...this.data.tags[tag].properties!);
        }
        out.push(...(this.data.widgetProperties ?? []));
        return out;
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
