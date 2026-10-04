/**
 * The cross-file layer: one summary per .dui, queries over all of them. Text-level on purpose --
 * ids, styles, resources, class lines, nested-class uses -- never semantics; the compiler stays
 * the authority on meaning, this layer only answers "where is the word".
 *
 * The host (vscode, an LSP server, anything) owns file discovery and watching; it feeds text in
 * through update()/remove() and this class never touches a filesystem. No vscode import here.
 *
 * Since `use … as`, "where is the word" crosses files in a way it did not before: a name a file
 * writes may have been given by a library two `use`s away (`Row`, re-exported), or entered under a
 * namespace (`nier.Label`). The rules for that are ParseUseDeclaration's in DreamUISourceFile.cpp,
 * and importScopeOf is their mirror -- computed per question from the summaries, never stored, so a
 * summary stays one file's facts and summarizeFile stays one parse.
 */

import { buildStructure, StructNode, UseDirective } from './structure';

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
    /** No id written; `id` is the compiler's made-up one and the site is the node's type token. */
    anonymous?: boolean;
}

/** One `use … as Name` line of a file: the name, and what it names as written. */
export interface AliasSymbol extends NamedSymbol {
    /** The path after `use`, as written (unquoted). */
    target: string;
    targetKind: 'file' | 'class';
}

/** What an alias (or `@Name`, or a namespaced `ns.Row`) used as a node type comes to. */
export interface ResolvedComponent {
    /** The alias as looked up. */
    name: string;
    /** The component's source file, when the alias names a .dui that resolved uniquely. */
    file?: string;
    /** The class it compiles into: that file's `class` line, or the /Game or /Script path a class alias names. */
    classPath?: string;
    /** Where the alias was declared (possibly in an imported library). */
    declaredAt?: AliasSymbol;
}

export interface NamedSymbol extends SymbolSite {
    name: string;
}

/** One `use` line the compiler honours (not one it refuses), as the index needs it to follow imports. */
export interface UseSummary {
    /** As written, unquoted. */
    path: string;
    targetKind: 'file' | 'class';
    /** The name after `as`, when there is one. */
    alias?: string;
}

export interface FileSummary {
    file: string;
    classPath?: NamedSymbol;
    /**
     * Widget ids and slot declarations, the unnamed widgets included (with their made ids, `anonymous`, sited at the
     * type). Not a host's `slot Detail { … }` fill: its name is the component's slot, not an id of this class.
     */
    nodes: NodeSymbol[];
    /** Style declarations, and every wearing/base use (a namespaced one as written: `nier.Label`). */
    styles: NamedSymbol[];
    styleUses: NamedSymbol[];
    /** Resource declarations -- with the value as written, which is what an `@Row` node type resolves through -- and every @use. */
    resources: (NamedSymbol & { type: string; value?: string })[];
    resourceUses: NamedSymbol[];
    /** Node tags that are asset paths: this file nests that class. */
    nestedClasses: NamedSymbol[];
    /**
     * Every `use "…"` spelling, as written -- plain, component and namespace alike, never a class path.
     *
     * Here because an import is TRANSITIVE and only this layer can follow one: ParseUseDeclaration
     * (DreamUISourceFile.cpp) merges the imported file's own ImportedStyles and ImportedResources
     * into the importer as well as its local ones, so a style library that layers -- A uses B, B
     * uses C -- puts C's styles in A's scope. Spellings rather than resolved paths, because resolution is
     * WorkspaceIndex.resolveImportSpelling's answer and it can change as files appear. What each one
     * BRINGS depends on its `as` and on the file it names; `uses` keeps that, and importScopeOf reads it.
     */
    imports: string[];
    /** Every `use` line the compiler honours, in order, with its `as`. */
    uses: UseSummary[];
    /**
     * `use … as Name` lines -- a component's name or a namespace, which only the named file can tell apart. A plain
     * `use` of a library brings that library's aliases too (re-export): see WorkspaceIndex.aliasesVisibleFrom.
     */
    aliases: AliasSymbol[];
    /** A file with a root node is a component (or a screen); one without is a library. */
    hasRoot: boolean;
    /** `props` entries: what a host may set on an instance of this file's class. An Enum's type carries its path. */
    props: (NamedSymbol & { type: string; defaultText?: string })[];
    /** `events` entries, with their parameter list as written (`Number Index`), for a host's completion and hover. */
    events: (NamedSymbol & { params: string })[];
    /** Slot declarations (not fills): what a host may fill, and which one nesting goes to. */
    slots: (NamedSymbol & { isDefault: boolean })[];
}

/** '/Game/UI/WBP_X.WBP_X_C' and '/Game/UI/WBP_X' name the same package. */
export function packagePathOf(assetPath: string): string {
    const dot = assetPath.indexOf('.');
    return (dot >= 0 ? assetPath.slice(0, dot) : assetPath).toLowerCase();
}

const fold = (name: string): string => name.toLowerCase();

/** The `use` lines of a parse that the compiler honours, as the index keeps them. */
export function usesOf(imports: readonly UseDirective[]): UseSummary[] {
    return imports.filter((directive) => !directive.refused).map((directive) => ({
        path: directive.path,
        targetKind: directive.target === 'class' ? 'class' : 'file',
        ...(directive.alias !== undefined ? { alias: directive.alias } : {}),
    }));
}

export function summarizeFile(file: string, text: string): FileSummary {
    const structure = buildStructure(text);
    const summary: FileSummary = {
        file, nodes: [], styles: [], styleUses: [], resources: [], resourceUses: [], nestedClasses: [],
        imports: structure.imports
            .filter((directive) => directive.target !== 'class' && !directive.refused)
            .map((directive) => directive.path),
        uses: usesOf(structure.imports),
        aliases: [], hasRoot: structure.roots.length > 0, props: [], events: [], slots: [],
    };

    if (structure.classPath) {
        summary.classPath = {
            file, name: structure.classPath.path,
            start: structure.classPath.start, end: structure.classPath.end,
            line: structure.classPath.line, column: structure.classPath.column,
        };
    }

    const visit = (node: StructNode): void => {
        const declares = node.kind === 'node' || (node.kind === 'namedSlot' && !node.fillsSlot);
        if (declares && node.id && node.idStart !== undefined) {
            summary.nodes.push({
                file, id: node.id, kind: node.kind === 'namedSlot' ? 'namedSlot' : 'node', tag: node.tag,
                start: node.idStart, end: node.idStart + node.id.length,
                line: node.idLine!, column: node.idColumn!,
                wasId: node.wasId,
            });
        } else if (node.kind === 'node' && node.anonymous && node.id) {
            // No token spells a made id; the type is the word the author wrote for the node, and where a jump lands.
            summary.nodes.push({
                file, id: node.id, kind: 'node', tag: node.tag, anonymous: true,
                start: node.start, end: node.tagEnd ?? node.start + node.tag.length,
                line: node.line, column: node.column,
            });
        }
        if (node.kind === 'namedSlot' && !node.fillsSlot && node.idStart !== undefined) {
            summary.slots.push({
                file, name: node.id, isDefault: node.defaultSlot === true,
                start: node.idStart, end: node.idStart + node.id.length,
                line: node.idLine!, column: node.idColumn!,
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

    for (const directive of structure.imports) {
        if (directive.refused || directive.alias === undefined || directive.aliasStart === undefined) {
            continue;
        }
        summary.aliases.push({
            file, name: directive.alias,
            start: directive.aliasStart, end: directive.aliasStart + directive.alias.length,
            line: directive.aliasLine!, column: directive.aliasColumn!,
            target: directive.path, targetKind: directive.target === 'class' ? 'class' : 'file',
        });
    }

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
            file, name: resource.name, type: resource.type, value: resource.valueText,
            start: resource.nameStart, end: resource.nameStart + resource.name.length,
            line: resource.line, column: resource.column,
        });
    }
    for (const ref of structure.resourceRefs) {
        summary.resourceUses.push({
            file, name: ref.name,
            start: ref.start, end: ref.end ?? ref.start + ref.name.length + 1, // includes the '@'
            line: ref.line, column: ref.column,
        });
    }
    for (const prop of structure.props) {
        summary.props.push({
            file, name: prop.name, type: prop.enumPath ? `${prop.type} ${prop.enumPath}` : prop.type,
            ...(prop.defaultText !== undefined ? { defaultText: prop.defaultText } : {}),
            start: prop.nameStart, end: prop.nameStart + prop.name.length,
            line: prop.line, column: prop.column,
        });
    }
    for (const event of structure.events) {
        summary.events.push({
            file, name: event.name,
            params: event.params.map((param) => `${param.type}${param.enumPath ? ` ${param.enumPath}` : ''} ${param.name}`).join(', '),
            start: event.nameStart, end: event.nameStart + event.name.length,
            line: event.line, column: event.column,
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

export interface ReferenceAnswer {
    declaration?: NamedSymbol;
    /** Use sites, declaration not included. */
    uses: NamedSymbol[];
}

/**
 * What the word at `offset` in `file` refers to, and everywhere it is used. Styles and resources
 * are file-local by language rule, so their uses stay in-file; a class path (the class line or a
 * nested tag) crosses files: its uses are every nesting site in the workspace.
 * Node ids get no answer -- nothing in the TEXT can reference an id; its references live in
 * Blueprints, where this layer has no business guessing.
 */
export function referencesAt(index: WorkspaceIndex, file: string, offset: number): ReferenceAnswer | undefined {
    const summary = index.summaryOf(file);
    if (!summary) {
        return undefined;
    }
    const covers = (site: SymbolSite): boolean => site.start <= offset && offset <= site.end;

    const classHit = (summary.classPath && covers(summary.classPath) ? summary.classPath : undefined)
        ?? summary.nestedClasses.find(covers);
    if (classHit) {
        const declaring = index.fileForClass(classHit.name);
        return { declaration: declaring?.classPath, uses: index.nestingSitesOf(classHit.name) };
    }

    const styleHit = summary.styles.find(covers) ?? summary.styleUses.find(covers);
    if (styleHit) {
        const wanted = fold(styleHit.name);
        return {
            declaration: summary.styles.find((style) => fold(style.name) === wanted),
            uses: summary.styleUses.filter((use) => fold(use.name) === wanted),
        };
    }

    const resourceHit = summary.resources.find(covers) ?? summary.resourceUses.find(covers);
    if (resourceHit) {
        const wanted = fold(resourceHit.name);
        return {
            declaration: summary.resources.find((entry) => fold(entry.name) === wanted),
            uses: summary.resourceUses.filter((use) => fold(use.name) === wanted),
        };
    }
    return undefined;
}

/** A resource as an importer sees it: under the name it was entered as, and where it was declared. */
export interface ScopedResource {
    /** The name the importer writes after '@': `Ink`, or `nier.Ink`. */
    name: string;
    type: string;
    value?: string;
    declaredAt: NamedSymbol;
}

/**
 * Everything a file's `use` lines bring into it, as ParseUseDeclaration would merge it: the styles, resources and
 * component aliases of every library used plainly (and of the libraries THEY use, transitively), those of a library
 * used `as ns` entered under `ns.`, and the namespaces declared or carried in. A component (`use "Row.dui" as Row` on
 * a file with a root) brings nothing but its name, which is the file's own alias and not in here.
 */
export interface ImportScope {
    /** Folded, as the importer spells them: `label`, `nier.label`. */
    styles: Set<string>;
    /** By folded name, the first of a name kept. */
    resources: Map<string, ScopedResource>;
    /** Visible names (`Row`, `nier.Row`) in lookup order, the first of a name kept; sited where each was declared. */
    aliases: AliasSymbol[];
    /** Folded. */
    namespaces: Set<string>;
    /**
     * True when every `use` followed to assemble this resolved to exactly one indexed file, and no chain came back
     * around. Only then does "not in here" mean "the compiler will not find it among the imports either": an import
     * this layer could not follow may bring anything.
     */
    complete: boolean;
}

/** What a library contributes to whoever uses it: its own declarations, plus everything it imported itself. */
interface LibraryExports {
    styles: { name: string }[];
    resources: ScopedResource[];
    aliases: AliasSymbol[];
    /** The namespaces it declares and carries: what a PLAIN use of it adds to the importer's. */
    namespaces: string[];
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

    allSummaries(): IterableIterator<FileSummary> {
        return this.files.values();
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

    /**
     * Every alias a file can use as a node type: its own `use … as` lines, and -- through each plain `use`, followed
     * transitively -- the aliases its libraries declare, plus `ns.X` for each alias a `use "Lib.dui" as ns` library
     * brings. The file's own win over imported ones of the same name (case-insensitive). Contract for the editor
     * features; implemented by the core layer.
     *
     * An own `as` line counts as an alias unless its file resolves, uniquely, to one with no root -- that is a
     * namespace, and its name is a prefix rather than a type. One whose file cannot be found is kept: it may well be
     * a component, and a name withheld here would read as an unknown type.
     */
    aliasesVisibleFrom(file: string): AliasSymbol[] {
        const summary = this.files.get(file);
        if (!summary) {
            return [];
        }
        const own = summary.aliases.filter((alias) => this.classifyAlias(alias) !== 'namespace');
        return dedupeAliases([...own, ...this.importScopeOf(summary.uses, file).aliases]);
    }

    /**
     * What `name` used as a node type in `file` comes to, or undefined when it is no alias visible there. `@Row`
     * resolves through the resource entry it names, the file's own or one an import brought, when that entry is an
     * Asset; `declaredAt` is then absent, there being no `as` line.
     */
    resolveComponent(file: string, name: string): ResolvedComponent | undefined {
        const summary = this.files.get(file);
        if (!summary) {
            return undefined;
        }
        if (name.startsWith('@')) {
            const wanted = fold(name.slice(1));
            const own = summary.resources.find((entry) => fold(entry.name) === wanted);
            const resource = own
                ? { type: own.type, value: own.value }
                : this.importScopeOf(summary.uses, file).resources.get(wanted);
            if (!resource || fold(resource.type) !== 'asset' || !resource.value) {
                return undefined;
            }
            const classPath = resource.value.replace(/^"|"$/g, '');
            return { name, classPath, file: this.fileForClass(classPath)?.file };
        }

        const alias = this.aliasesVisibleFrom(file).find((candidate) => fold(candidate.name) === fold(name));
        if (!alias) {
            return undefined;
        }
        if (alias.targetKind === 'class') {
            return { name, classPath: alias.target, file: this.fileForClass(alias.target)?.file, declaredAt: alias };
        }
        const matches = this.resolveImportSpelling(alias.target);
        const target = matches.length === 1 ? this.files.get(matches[0]) : undefined;
        return { name, file: target?.file, classPath: target?.classPath?.name, declaredAt: alias };
    }

    /**
     * What one `as` line names, as far as the index can tell: a class path is always a component; a file is a
     * component when it has a root and a namespace when it has none -- and 'unresolved' when the spelling does not
     * resolve to exactly one indexed file, which leaves the question open.
     */
    classifyAlias(alias: { target: string; targetKind: 'file' | 'class' }): 'component' | 'namespace' | 'unresolved' {
        if (alias.targetKind === 'class') {
            return 'component';
        }
        const matches = this.resolveImportSpelling(alias.target);
        if (matches.length !== 1) {
            return 'unresolved';
        }
        return this.files.get(matches[0])!.hasRoot ? 'component' : 'namespace';
    }

    /**
     * Everything `uses` bring into the file that writes them: see ImportScope. Asked with the uses of a LIVE parse by
     * the judge (the buffer may be ahead of the index), so it takes the lines rather than a file name; `selfFile`, when
     * given, is where a chain that comes back around is caught.
     */
    importScopeOf(uses: readonly UseSummary[], selfFile?: string): ImportScope {
        const scope: ImportScope = {
            styles: new Set(), resources: new Map(), aliases: [], namespaces: new Set(), complete: true,
        };
        const ancestors = new Set<string>(selfFile ? [fold(selfFile)] : []);
        const imported = this.importsOf(uses, ancestors, new Map(), scope);
        for (const style of imported.styles) {
            scope.styles.add(fold(style.name));
        }
        for (const resource of imported.resources) {
            if (!scope.resources.has(fold(resource.name))) {
                scope.resources.set(fold(resource.name), resource);
            }
        }
        scope.aliases = dedupeAliases(imported.aliases);
        // A namespace this file declares itself: an `as` on a library with no root. One whose file cannot be found is
        // not counted, and makes the scope incomplete, which is what keeps it from being called unknown.
        for (const use of uses) {
            if (use.alias !== undefined && use.targetKind === 'file'
                && this.classifyAlias({ target: use.path, targetKind: 'file' }) === 'namespace') {
                scope.namespaces.add(fold(use.alias));
            }
        }
        for (const namespace of imported.namespaces) {
            scope.namespaces.add(fold(namespace));
        }
        return scope;
    }

    /**
     * The merged imports of one set of `use` lines: per line, a plain library's exports as they are, a namespace
     * library's under its prefix, a component's nothing. `ancestors` is the chain being imported along (a file met
     * again on it is the compiler's cycle, DUI2012); `memo` keeps a diamond from being walked twice.
     */
    private importsOf(uses: readonly UseSummary[], ancestors: Set<string>, memo: Map<string, LibraryExports>,
        scope: ImportScope): LibraryExports {
        const out: LibraryExports = { styles: [], resources: [], aliases: [], namespaces: [] };
        for (const use of uses) {
            if (use.targetKind === 'class') {
                continue;
            }
            const matches = this.resolveImportSpelling(use.path);
            if (matches.length !== 1) {
                scope.complete = false;
                continue;
            }
            const library = this.files.get(matches[0])!;
            if (use.alias !== undefined && library.hasRoot) {
                continue; // a component: its class is all an importer takes from it
            }
            if (ancestors.has(fold(library.file))) {
                scope.complete = false;
                continue;
            }
            const exported = this.exportsOf(library, ancestors, memo, scope);
            if (use.alias === undefined) {
                out.styles.push(...exported.styles);
                out.resources.push(...exported.resources);
                out.aliases.push(...exported.aliases);
                // A plain `use` brings the library's namespaces along, so `@pal.Ink` resolves here as it did there.
                out.namespaces.push(...exported.namespaces);
            } else {
                const prefix = `${use.alias}.`;
                out.styles.push(...exported.styles.map((style) => ({ name: prefix + style.name })));
                out.resources.push(...exported.resources.map((resource) => ({ ...resource, name: prefix + resource.name })));
                out.aliases.push(...exported.aliases.map((alias) => ({ ...alias, name: prefix + alias.name })));
            }
        }
        return out;
    }

    /** What a library gives whoever uses it: its own styles, resources and component aliases, then what it imported. */
    private exportsOf(library: FileSummary, ancestors: Set<string>, memo: Map<string, LibraryExports>,
        scope: ImportScope): LibraryExports {
        const key = fold(library.file);
        const known = memo.get(key);
        if (known) {
            return known;
        }
        const chain = new Set(ancestors);
        chain.add(key);
        const imported = this.importsOf(library.uses, chain, memo, scope);

        const ownAliases: AliasSymbol[] = [];
        const ownNamespaces: string[] = [];
        for (const alias of library.aliases) {
            const kind = this.classifyAlias(alias);
            if (kind === 'namespace') {
                ownNamespaces.push(alias.name);
            } else {
                if (kind === 'unresolved') {
                    scope.complete = false;
                }
                ownAliases.push(alias);
            }
        }
        const exported: LibraryExports = {
            styles: [...library.styles.map((style) => ({ name: style.name })), ...imported.styles],
            resources: [
                ...library.resources.map((resource) => ({
                    name: resource.name, type: resource.type, value: resource.value, declaredAt: resource,
                })),
                ...imported.resources,
            ],
            aliases: [...ownAliases, ...imported.aliases],
            namespaces: [...ownNamespaces, ...imported.namespaces],
        };
        memo.set(key, exported);
        return exported;
    }

    /**
     * The files whose paths end with an authored `use` spelling, path-segment aligned. The
     * compiler resolves against DUI roots this index cannot know, but a suffix landing on a
     * segment boundary agrees with it whenever the workspace holds the tree the roots point
     * into -- and a caller acting only on a UNIQUE match keeps a wrong jump impossible.
     */
    resolveImportSpelling(spelling: string): string[] {
        const wanted = spelling.replace(/\\/g, '/').toLowerCase();
        if (wanted.length === 0) {
            return [];
        }
        const out: string[] = [];
        for (const summary of this.files.values()) {
            const file = summary.file.replace(/\\/g, '/').toLowerCase();
            if (file === wanted || file.endsWith('/' + wanted)) {
                out.push(summary.file);
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

/**
 * First of a visible name wins, case-insensitively -- FindComponentAlias's rule. One declaration reached twice (a
 * diamond) is the same name twice, so this is also MergeDeclarations' dedupe.
 */
function dedupeAliases(aliases: readonly AliasSymbol[]): AliasSymbol[] {
    const seen = new Set<string>();
    const out: AliasSymbol[] = [];
    for (const alias of aliases) {
        if (!seen.has(fold(alias.name))) {
            seen.add(fold(alias.name));
            out.push(alias);
        }
    }
    return out;
}
