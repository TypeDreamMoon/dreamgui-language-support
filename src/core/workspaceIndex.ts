/**
 * The cross-file layer: one summary per .dui, queries over all of them. Text-level on purpose --
 * ids, styles, resources, class lines, nested-class uses -- never semantics; the compiler stays
 * the authority on meaning, this layer only answers "where is the word".
 *
 * The host (vscode, an LSP server, anything) owns file discovery and watching; it feeds text in
 * through update()/remove() and this class never touches a filesystem. No vscode import here.
 */

import { buildStructure, StructNode } from './structure';

export interface SymbolSite {
    /** Absolute path (an opaque key as far as this layer cares). */
    file: string;
    start: number;
    end: number;
    /** 1-based, as the diagnostics count. */
    line: number;
    column: number;
}

export interface NodeSymbol extends SymbolSite {
    id: string;
    kind: 'node' | 'namedSlot';
    tag: string;
    wasId?: string;
}

export interface NamedSymbol extends SymbolSite {
    name: string;
}

export interface FileSummary {
    file: string;
    classPath?: NamedSymbol;
    nodes: NodeSymbol[];
    /** Style declarations, and every wearing/base use. */
    styles: NamedSymbol[];
    styleUses: NamedSymbol[];
    /** Resource declarations and every @use. */
    resources: (NamedSymbol & { type: string })[];
    resourceUses: NamedSymbol[];
    /** Node tags that are asset paths: this file nests that class. */
    nestedClasses: NamedSymbol[];
}

/** '/Game/UI/WBP_X.WBP_X_C' and '/Game/UI/WBP_X' name the same package. */
export function packagePathOf(assetPath: string): string {
    const dot = assetPath.indexOf('.');
    return (dot >= 0 ? assetPath.slice(0, dot) : assetPath).toLowerCase();
}

const fold = (name: string): string => name.toLowerCase();

export function summarizeFile(file: string, text: string): FileSummary {
    const structure = buildStructure(text);
    const summary: FileSummary = {
        file, nodes: [], styles: [], styleUses: [], resources: [], resourceUses: [], nestedClasses: [],
    };

    if (structure.classPath) {
        summary.classPath = {
            file, name: structure.classPath.path,
            start: structure.classPath.start, end: structure.classPath.end,
            line: structure.classPath.line, column: structure.classPath.column,
        };
    }

    const visit = (node: StructNode): void => {
        if (node.kind !== 'loop' && node.id && node.idStart !== undefined) {
            summary.nodes.push({
                file, id: node.id, kind: node.kind === 'namedSlot' ? 'namedSlot' : 'node', tag: node.tag,
                start: node.idStart, end: node.idStart + node.id.length,
                line: node.idLine!, column: node.idColumn!,
                wasId: node.wasId,
            });
        }
        if (node.kind === 'node' && node.tag.startsWith('/')) {
            summary.nestedClasses.push({
                file, name: node.tag,
                start: node.start, end: node.start + node.tag.length,
                line: node.line, column: node.column,
            });
        }
        if (node.styleName && node.styleNameStart !== undefined) {
            summary.styleUses.push({
                file, name: node.styleName,
                start: node.styleNameStart, end: node.styleNameStart + node.styleName.length,
                line: node.styleNameLine!, column: node.styleNameColumn!,
            });
        }
        node.children.forEach(visit);
    };
    structure.roots.forEach(visit);

    for (const style of structure.styles) {
        summary.styles.push({
            file, name: style.name,
            start: style.nameStart, end: style.nameStart + style.name.length,
            line: style.line, column: style.column,
        });
        if (style.base && style.baseStart !== undefined) {
            summary.styleUses.push({
                file, name: style.base,
                start: style.baseStart, end: style.baseStart + style.base.length,
                line: style.baseLine!, column: style.baseColumn!,
            });
        }
    }
    for (const resource of structure.resources) {
        summary.resources.push({
            file, name: resource.name, type: resource.type,
            start: resource.nameStart, end: resource.nameStart + resource.name.length,
            line: resource.line, column: resource.column,
        });
    }
    for (const ref of structure.resourceRefs) {
        summary.resourceUses.push({
            file, name: ref.name,
            start: ref.start, end: ref.start + ref.name.length + 1, // includes the '@'
            line: ref.line, column: ref.column,
        });
    }
    return summary;
}

export interface WorkspaceSymbolHit {
    kind: 'id' | 'style' | 'resource';
    name: string;
    /** The container: a tag for ids, a type for resources. */
    detail: string;
    site: SymbolSite;
}

export class WorkspaceIndex {
    private readonly files = new Map<string, FileSummary>();

    update(file: string, text: string): void {
        this.files.set(file, summarizeFile(file, text));
    }

    remove(file: string): void {
        this.files.delete(file);
    }

    has(file: string): boolean {
        return this.files.has(file);
    }

    get size(): number {
        return this.files.size;
    }

    summaryOf(file: string): FileSummary | undefined {
        return this.files.get(file);
    }

    /** The file whose class line declares this asset (package-path comparison, case-insensitive). */
    fileForClass(assetPath: string): FileSummary | undefined {
        const wanted = packagePathOf(assetPath);
        for (const summary of this.files.values()) {
            if (summary.classPath && packagePathOf(summary.classPath.name) === wanted) {
                return summary;
            }
        }
        return undefined;
    }

    /** Every place any file nests the class this asset path names. */
    nestingSitesOf(assetPath: string): NamedSymbol[] {
        const wanted = packagePathOf(assetPath);
        const out: NamedSymbol[] = [];
        for (const summary of this.files.values()) {
            for (const site of summary.nestedClasses) {
                if (packagePathOf(site.name) === wanted) {
                    out.push(site);
                }
            }
        }
        return out;
    }

    /** Fuzzy-lite: every symbol whose name contains the query, case-insensitively. */
    findSymbols(query: string): WorkspaceSymbolHit[] {
        const needle = fold(query);
        const out: WorkspaceSymbolHit[] = [];
        for (const summary of this.files.values()) {
            for (const node of summary.nodes) {
                if (fold(node.id).includes(needle)) {
                    out.push({ kind: 'id', name: node.id, detail: node.tag, site: node });
                }
            }
            for (const style of summary.styles) {
                if (fold(style.name).includes(needle)) {
                    out.push({ kind: 'style', name: style.name, detail: 'style', site: style });
                }
            }
            for (const resource of summary.resources) {
                if (fold(resource.name).includes(needle)) {
                    out.push({ kind: 'resource', name: resource.name, detail: resource.type, site: resource });
                }
            }
        }
        return out;
    }
}
