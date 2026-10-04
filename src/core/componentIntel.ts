/**
 * What the editor knows about the names one file borrows from others: component aliases (`Row`, `nier.Row`), the
 * namespaces a `use … as nier` opens (`: nier.Label`, `@nier.Ink`), the styles and resources a plain `use` merges in --
 * and, inside the file, what its own `props` and `events` mean to the bindings that read and raise them.
 *
 * The rules are the compiler's (ParseUseDeclaration in DreamUISourceFile.cpp), mirrored only as far as navigation and
 * hover need them:
 *
 *   - a plain `use` merges a library's styles, resources and aliases, and the library's own plain `use` lines come
 *     with it -- libraries layer, so the walk is transitive;
 *   - `use "…" as X` on a file WITH a root names that file's class and takes nothing else from it;
 *   - `use "…" as X` on a file with NO root is a namespace: everything the library declares or brought in becomes
 *     `X.Name`;
 *   - a plain `use` of a library carries the library's namespaces along with its entries.
 *
 * Every answer here is a jump or a tooltip, never a verdict: resolution goes through WorkspaceIndex's path-suffix
 * mirror of the DUI roots, and only a spelling that resolves to exactly ONE file is followed -- a wrong jump is worse
 * than none. Component aliases themselves are resolved by WorkspaceIndex (aliasesVisibleFrom / resolveComponent);
 * this file reads its answers and adds the namespace walk, which has no such query of its own.
 *
 * No vscode import here: src/core/ is the seam a future LSP server or another IDE reuses.
 */

import {
    WorkspaceIndex, FileSummary, SymbolSite, NamedSymbol, AliasSymbol, ResolvedComponent,
} from './workspaceIndex';
import { StructureResult, StructNode, PropDecl, EventDecl, BindingRef, UseDirective } from './structure';

const fold = (name: string): string => name.toLowerCase();

/** One past a node's type: `nier.Row` and `Native.Toggle` are three tokens, and the parser says where they end. */
export const tagEndOf = (node: StructNode): number => node.tagEnd ?? node.start + node.tag.length;
const normSpelling = (spelling: string): string => spelling.replace(/\\/g, '/').toLowerCase();

/** The one file a `use` spelling names, or nothing when the workspace holds none or several. */
export function resolveUnique(index: WorkspaceIndex, spelling: string): string | undefined {
    const matches = index.resolveImportSpelling(spelling);
    return matches.length === 1 ? matches[0] : undefined;
}

/** `D:/Work/DUI/Settings/Row.dui` -> `Row.dui`: what a hover can afford to print. */
export function baseName(file: string): string {
    const normalized = file.replace(/\\/g, '/');
    return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * The spellings of a file's plain `use` lines. FileSummary.imports lists every `use`, `as` or not; the file's own
 * aliases name the ones that came with an `as`, and those merge nothing (a component) or merge under a prefix (a
 * namespace), so they are not part of the plain walk.
 */
function plainImportSpellings(summary: FileSummary): string[] {
    const aliased = new Set(summary.aliases
        .filter((alias) => alias.file === summary.file)
        .map((alias) => normSpelling(alias.target)));
    return summary.imports.filter((spelling) => !aliased.has(normSpelling(spelling)));
}

/**
 * Every file a plain `use` brings into `file`, transitively, breadth first -- the order a name is looked for in when
 * this file does not declare it. The file itself is never in the list, and a cycle ends where it closes.
 */
export function plainImportClosure(index: WorkspaceIndex, file: string): string[] {
    const start = index.summaryOf(file);
    if (!start) {
        return [];
    }
    const seen = new Set<string>([fold(file)]);
    const out: string[] = [];
    const pending = plainImportSpellings(start);
    for (let at = 0; at < pending.length; at++) {
        const resolved = resolveUnique(index, pending[at]);
        if (!resolved || seen.has(fold(resolved))) {
            continue;
        }
        seen.add(fold(resolved));
        out.push(resolved);
        const summary = index.summaryOf(resolved);
        if (summary) {
            pending.push(...plainImportSpellings(summary));
        }
    }
    return out;
}

export interface NamespaceInfo {
    /** As the `use … as` line spells it. */
    name: string;
    /** The library, when its spelling resolves uniquely to a file with no root. */
    file: string;
    /** The `use "…" as name` line that opened it, possibly in a library this file imports plainly. */
    declaredAt: AliasSymbol;
}

/** The `use "…" as X` lines OF `summary` whose target is a library -- a file the index knows to have no root. */
function ownNamespaces(index: WorkspaceIndex, summary: FileSummary): NamespaceInfo[] {
    const out: NamespaceInfo[] = [];
    for (const alias of summary.aliases) {
        if (alias.file !== summary.file || alias.targetKind !== 'file') {
            continue;
        }
        const library = resolveUnique(index, alias.target);
        const librarySummary = library ? index.summaryOf(library) : undefined;
        if (library && librarySummary && !librarySummary.hasRoot) {
            out.push({ name: alias.name, file: library, declaredAt: alias });
        }
    }
    return out;
}

/**
 * The namespaces `ns.` can name in `file`: its own `use "Lib.dui" as ns` lines, and those its plain imports carry
 * (a plain `use` merges the library's namespaced entries, namespaces and all). The file's own win a name.
 */
export function namespacesVisibleFrom(index: WorkspaceIndex, file: string): NamespaceInfo[] {
    const summary = index.summaryOf(file);
    if (!summary) {
        return [];
    }
    const out: NamespaceInfo[] = [];
    const add = (entry: NamespaceInfo): void => {
        if (!out.some((existing) => fold(existing.name) === fold(entry.name))) {
            out.push(entry);
        }
    };
    ownNamespaces(index, summary).forEach(add);
    for (const imported of plainImportClosure(index, file)) {
        const importedSummary = index.summaryOf(imported);
        if (importedSummary) {
            ownNamespaces(index, importedSummary).forEach(add);
        }
    }
    return out;
}

export function namespaceNamed(index: WorkspaceIndex, file: string, name: string): NamespaceInfo | undefined {
    return namespacesVisibleFrom(index, file).find((entry) => fold(entry.name) === fold(name));
}

/** A library and everything it merged plainly: the files whose declarations `ns.Name` can reach. */
function libraryFiles(index: WorkspaceIndex, library: string): string[] {
    return [library, ...plainImportClosure(index, library)];
}

export type BorrowedKind = 'style' | 'resource';

export interface FoundDeclaration {
    site: NamedSymbol & { type?: string };
    /** Set when the name was written `ns.Name` and found through that namespace. */
    namespace?: NamespaceInfo;
    /** True when the declaration is in the asking file itself. */
    local: boolean;
}

function declarationsOf(summary: FileSummary, kind: BorrowedKind): (NamedSymbol & { type?: string })[] {
    return kind === 'style' ? summary.styles : summary.resources;
}

/**
 * Where a style or resource, as written in `file`, is declared: the file's own entry first (a local name shadows an
 * imported one), then each plainly imported file in walk order. `nier.Label` is looked for in the `nier` library and
 * what it merged.
 */
export function findBorrowed(index: WorkspaceIndex, file: string, kind: BorrowedKind, written: string):
    FoundDeclaration | undefined {
    const dot = written.indexOf('.');
    if (dot > 0) {
        const namespace = namespaceNamed(index, file, written.slice(0, dot));
        if (!namespace) {
            return undefined;
        }
        const wanted = fold(written.slice(dot + 1));
        for (const library of libraryFiles(index, namespace.file)) {
            const summary = index.summaryOf(library);
            const hit = summary && declarationsOf(summary, kind).find((entry) => fold(entry.name) === wanted);
            if (hit) {
                return { site: hit, namespace, local: false };
            }
        }
        return undefined;
    }
    const wanted = fold(written);
    const own = index.summaryOf(file);
    const local = own && declarationsOf(own, kind).find((entry) => fold(entry.name) === wanted);
    if (local) {
        return { site: local, local: true };
    }
    for (const imported of plainImportClosure(index, file)) {
        const summary = index.summaryOf(imported);
        const hit = summary && declarationsOf(summary, kind).find((entry) => fold(entry.name) === wanted);
        if (hit) {
            return { site: hit, local: false };
        }
    }
    return undefined;
}

/**
 * Every style or resource name `file` can use without a namespace -- its own, then what its plain imports bring --
 * each once (first wins), with the file that declares it. Completion's list for `: ▌` and `@▌`.
 */
export function borrowableNames(index: WorkspaceIndex, file: string, kind: BorrowedKind):
    (NamedSymbol & { type?: string })[] {
    const out: (NamedSymbol & { type?: string })[] = [];
    const seen = new Set<string>();
    for (const source of [file, ...plainImportClosure(index, file)]) {
        const summary = index.summaryOf(source);
        for (const entry of summary ? declarationsOf(summary, kind) : []) {
            if (!seen.has(fold(entry.name))) {
                seen.add(fold(entry.name));
                out.push(entry);
            }
        }
    }
    return out;
}

/** What `ns.` can be followed by, in each of the three positions a namespaced name stands in. */
export function namespaceMembers(index: WorkspaceIndex, file: string, namespace: string, kind: BorrowedKind | 'alias'):
    (NamedSymbol & { type?: string })[] {
    if (kind === 'alias') {
        const prefix = fold(namespace) + '.';
        return index.aliasesVisibleFrom(file)
            .filter((alias) => fold(alias.name).startsWith(prefix))
            .map((alias) => ({ ...alias, name: alias.name.slice(prefix.length) }));
    }
    const library = namespaceNamed(index, file, namespace);
    if (!library) {
        return [];
    }
    const out: (NamedSymbol & { type?: string })[] = [];
    const seen = new Set<string>();
    for (const source of libraryFiles(index, library.file)) {
        const summary = index.summaryOf(source);
        for (const entry of summary ? declarationsOf(summary, kind) : []) {
            if (!seen.has(fold(entry.name))) {
                seen.add(fold(entry.name));
                out.push(entry);
            }
        }
    }
    return out;
}

// ---- components ------------------------------------------------------------------------------------------------

export interface ComponentFacts {
    /** The type as written on the node. */
    name: string;
    /** WorkspaceIndex's answer, when the type is an alias. Absent for an asset-path type. */
    resolved?: ResolvedComponent;
    /** The component's own file, when the workspace holds it: its props, events and slots. */
    summary?: FileSummary;
    classPath?: string;
}

/**
 * What a node's type names as a component: an alias (`Row`, `nier.Row`) through WorkspaceIndex.resolveComponent, or
 * an asset path (`/Game/UI/WBP_Row`) through the class lines the workspace declares. Undefined for a tag, a container,
 * a registry widget, or an alias nobody can resolve.
 */
export function componentFacts(index: WorkspaceIndex, file: string, typeName: string): ComponentFacts | undefined {
    if (typeName.startsWith('/')) {
        const summary = index.fileForClass(typeName);
        return summary ? { name: typeName, summary, classPath: typeName } : undefined;
    }
    const resolved = index.resolveComponent(file, typeName);
    if (!resolved) {
        return undefined;
    }
    let summary = resolved.file ? index.summaryOf(resolved.file) : undefined;
    if (!summary && resolved.classPath) {
        summary = index.fileForClass(resolved.classPath);
    }
    return { name: typeName, resolved, summary, classPath: resolved.classPath ?? summary?.classPath?.name };
}

/** Where F12 on a component lands: its class line, else its root node, else the top of its file. */
export function componentSite(summary: FileSummary): SymbolSite {
    if (summary.classPath) {
        return summary.classPath;
    }
    const root = summary.nodes.find((node) => node.kind === 'node');
    if (summary.hasRoot && root) {
        return root;
    }
    return { file: summary.file, start: 0, end: 0, line: 1, column: 1 };
}

const fileTop = (file: string): SymbolSite => ({ file, start: 0, end: 0, line: 1, column: 1 });

/** `Text Label = "x"`-shaped one-liner of a prop, as a hover prints it. */
export function propSignature(prop: { type: string; name: string; defaultText?: string; enumPath?: string }): string {
    const type = prop.enumPath ? `${prop.type} ${prop.enumPath}` : prop.type;
    return prop.defaultText !== undefined && prop.defaultText !== ''
        ? `${type} ${prop.name} = ${prop.defaultText}`
        : `${type} ${prop.name}`;
}

/** `Picked(Number Index)`; a parameterless event is its name alone, as the file writes it. */
export function eventSignature(event: EventDecl): string {
    return event.params.length === 0
        ? event.name
        : `${event.name}(${event.params.map((param) =>
            `${param.enumPath ? `${param.type} ${param.enumPath}` : param.type} ${param.name}`).join(', ')})`;
}

/** The markdown block describing what a component offers its hosts. */
export function componentMarkdown(facts: ComponentFacts): string {
    const lines: string[] = [];
    const declaredAt = facts.resolved?.declaredAt;
    const whereFrom = facts.summary ? `\`${baseName(facts.summary.file)}\`` : declaredAt ? `\`${declaredAt.target}\`` : '';
    const classPath = facts.classPath ? ` → \`${facts.classPath}\`` : '';
    lines.push(`**${facts.name}** — component${whereFrom ? ` ${whereFrom}` : ''}${classPath}`);
    if (declaredAt && declaredAt.file !== facts.summary?.file) {
        lines.push(`named by \`use … as ${declaredAt.name}\` in \`${baseName(declaredAt.file)}\``);
    }
    const summary = facts.summary;
    if (summary) {
        if (summary.props.length > 0) {
            lines.push(`props: ${summary.props.map((prop) => `\`${propSignature(prop)}\``).join(', ')}`);
        }
        if (summary.events.length > 0) {
            lines.push(`events: ${summary.events.map((event) =>
                `\`${event.params ? `${event.name}(${event.params})` : event.name}\``).join(', ')}`);
        }
        if (summary.slots.length > 0) {
            lines.push(`slots: ${summary.slots.map((slot) =>
                `\`${slot.name}\`${slot.isDefault ? ' (default)' : ''}`).join(', ')}`);
        }
    } else if (facts.resolved && !facts.resolved.file) {
        lines.push('a class with no `.dui` in this workspace: its properties are the editor\'s to say');
    }
    return lines.join('\n\n');
}

// ---- the file's own props, events and the names that read them ------------------------------------------------------

export interface WalkedNode {
    node: StructNode;
    parent?: StructNode;
}

export function walkNodes(structure: StructureResult): WalkedNode[] {
    const out: WalkedNode[] = [];
    const visit = (node: StructNode, parent?: StructNode): void => {
        out.push({ node, parent });
        node.children.forEach((child) => visit(child, node));
    };
    structure.roots.forEach((root) => visit(root));
    return out;
}

/**
 * The nearest enclosing node that is not a loop, a branch or a slot fill: the instance a `slot X { … }` fill or an
 * `if` arm stands in, as far as what its lines set is concerned.
 */
export function owningNode(structure: StructureResult, target: StructNode): StructNode | undefined {
    const parents = new Map<StructNode, StructNode | undefined>();
    for (const entry of walkNodes(structure)) {
        parents.set(entry.node, entry.parent);
    }
    let at = parents.get(target);
    while (at && at.kind !== 'node') {
        at = parents.get(at);
    }
    return at;
}

export function propNamed(structure: StructureResult, name: string): PropDecl | undefined {
    return (structure.props ?? []).find((prop) => fold(prop.name) === fold(name));
}

export function eventNamed(structure: StructureResult, name: string): EventDecl | undefined {
    return (structure.events ?? []).find((event) => fold(event.name) === fold(name));
}

/**
 * True when `head` at `offset` is an enclosing loop's variable -- `Item` in `for Item in …` -- which shadows a class
 * member of the same name there. Case sensitive, as the compiler's loop-variable rules are.
 */
export function isLoopVariableAt(structure: StructureResult, head: string, offset: number): boolean {
    return structure.scopes.some((scope) => scope.kind === 'loop' && scope.id === head
        && offset >= scope.bodyStart && offset <= scope.bodyEnd);
}

/** The prop a binding reads, when its first segment names one and no loop variable shadows it there. */
export function propReadBy(structure: StructureResult, binding: BindingRef): PropDecl | undefined {
    if (!binding.isVariable || binding.isEmit) {
        return undefined;
    }
    const dot = binding.name.indexOf('.');
    const head = dot < 0 ? binding.name : binding.name.slice(0, dot);
    if (isLoopVariableAt(structure, head, binding.nameStart)) {
        return undefined;
    }
    return propNamed(structure, head);
}

/** The span of a binding's first segment: what a prop rename rewrites and what a hover covers. */
export function bindingHeadSpan(binding: BindingRef): { start: number; end: number } {
    const dot = binding.name.indexOf('.');
    return { start: binding.nameStart, end: binding.nameStart + (dot < 0 ? binding.name.length : dot) };
}

/**
 * The generated id of the unnamed node whose type token covers `offset` -- what a hover tells the author the node
 * compiles to, since nothing in the text spells it.
 */
export function anonymousNodeAt(structure: StructureResult, offset: number): StructNode | undefined {
    return walkNodes(structure).map((entry) => entry.node).find((node) => node.kind === 'node' && node.anonymous
        && offset >= node.start && offset <= tagEndOf(node));
}

// ---- definitions --------------------------------------------------------------------------------------------------

export interface DefinitionHit {
    /** The span under the cursor the jump starts from. */
    originStart: number;
    originEnd: number;
    /** Offsets into the target file; `file` is the asking file for an in-file jump. */
    target: { file: string; start: number; end: number; line?: number; column?: number };
}

const toTarget = (site: SymbolSite): DefinitionHit['target'] =>
    ({ file: site.file, start: site.start, end: site.end, line: site.line, column: site.column });

const within = (offset: number, start: number | undefined, length: number): boolean =>
    start !== undefined && offset >= start && offset <= start + length;

/** Where a `use` line's target lands: a component's class line or root, a library's top, a class's declaring file. */
function useTarget(index: WorkspaceIndex, directive: UseDirective): SymbolSite | undefined {
    if (directive.target === 'class') {
        return index.fileForClass(directive.path)?.classPath;
    }
    const resolved = resolveUnique(index, directive.path);
    const summary = resolved ? index.summaryOf(resolved) : undefined;
    return summary ? componentSite(summary) : resolved ? fileTop(resolved) : undefined;
}

/**
 * Go-to-definition for everything the new grammar names across a file boundary or inside the file's own `props` and
 * `events`:
 *
 *   - an alias on a node (`Row Audio`, `nier.Row`), and the name after `use … as` -> the component (class line or
 *     root); the `nier` of `nier.Row` -> the library;
 *   - `: nier.Label`, `@nier.Ink` -> the library's declaration; a style or resource a plain `use` brought in -> the
 *     imported file's; a local one -> its own entry;
 *   - `emit Picked` -> the `events` entry; a binding reading a prop -> the `props` entry;
 *   - on a component instance, a prop it sets or an event it routes -> the component's entry, and a `slot X { … }`
 *     fill -> the component's slot.
 */
export function definitionAt(index: WorkspaceIndex | undefined, file: string, structure: StructureResult,
    offset: number): DefinitionHit | undefined {
    const here = (start: number, length: number) => ({ file, start, end: start + length });

    for (const directive of structure.imports) {
        if (directive.alias && within(offset, directive.aliasStart, directive.alias.length) && index) {
            const site = useTarget(index, directive);
            if (site) {
                return { originStart: directive.aliasStart!, originEnd: directive.aliasStart! + directive.alias.length,
                    target: toTarget(site) };
            }
            return undefined;
        }
    }

    const walked = walkNodes(structure);
    for (const { node, parent } of walked) {
        // The type token.
        if (node.kind === 'node' && within(offset, node.start, tagEndOf(node) - node.start) && index
            && !node.tag.startsWith('/')) {
            const dot = node.tag.indexOf('.');
            if (dot > 0 && offset <= node.start + dot) {
                const namespace = namespaceNamed(index, file, node.tag.slice(0, dot));
                return namespace
                    ? { originStart: node.start, originEnd: node.start + dot, target: toTarget(fileTop(namespace.file)) }
                    : undefined;
            }
            const facts = componentFacts(index, file, node.tag);
            const site = facts?.summary ? componentSite(facts.summary)
                : facts?.classPath ? index.fileForClass(facts.classPath)?.classPath : undefined;
            const fallback = site ?? facts?.resolved?.declaredAt;
            if (fallback) {
                // The tail of `nier.Row` is measured back from the type's end: the three tokens may be spaced.
                const originStart = dot > 0 ? tagEndOf(node) - (node.tag.length - dot - 1) : node.start;
                return { originStart, originEnd: tagEndOf(node), target: toTarget(fallback) };
            }
            // Nothing to go to as a component: `@Row` still names its resource entry, below.
        }
        // The style clause.
        if (node.styleName && within(offset, node.styleNameStart, node.styleName.length)) {
            return borrowedDefinition(index, file, structure, 'style', node.styleName, node.styleNameStart!, offset);
        }
        // A slot fill names the component's slot.
        if (node.kind === 'namedSlot' && node.fillsSlot && within(offset, node.idStart, node.id.length) && index) {
            const instance = parent && parent.kind === 'node' ? parent : owningNode(structure, node);
            const facts = instance && componentFacts(index, file, instance.tag);
            const slot = facts?.summary?.slots.find((entry) => fold(entry.name) === fold(node.id));
            return slot ? { originStart: node.idStart!, originEnd: node.idStart! + node.id.length, target: toTarget(slot) }
                : undefined;
        }
        // On an instance, the props it sets and the events it routes are the component's.
        if (node.kind === 'node' && index) {
            for (const stmt of node.properties) {
                const head = stmt.path.split('.')[0];
                if (stmt.isSlot || !within(offset, stmt.pathStart, head.length)) {
                    continue;
                }
                const facts = componentFacts(index, file, node.tag);
                const summary = facts?.summary;
                const entry = stmt.op === 'eventArrow'
                    ? summary?.events.find((event) => fold(event.name) === fold(head))
                    : summary?.props.find((prop) => fold(prop.name) === fold(head));
                return entry ? { originStart: stmt.pathStart, originEnd: stmt.pathStart + head.length,
                    target: toTarget(entry) } : undefined;
            }
        }
    }

    for (const style of structure.styles) {
        if (style.base && within(offset, style.baseStart, style.base.length)) {
            return borrowedDefinition(index, file, structure, 'style', style.base, style.baseStart!, offset);
        }
    }

    for (const ref of structure.resourceRefs) {
        if (within(offset, ref.start, ref.name.length + 1)) {
            return borrowedDefinition(index, file, structure, 'resource', ref.name, ref.start + 1, offset);
        }
    }

    for (const binding of structure.bindings) {
        if (binding.isEmit && within(offset, binding.nameStart, binding.name.length)) {
            const event = eventNamed(structure, binding.name);
            return event ? { originStart: binding.nameStart, originEnd: binding.nameStart + binding.name.length,
                target: here(event.nameStart, event.name.length) } : undefined;
        }
        const head = bindingHeadSpan(binding);
        if (binding.isVariable && offset >= head.start && offset <= head.end) {
            const prop = propReadBy(structure, binding);
            return prop ? { originStart: head.start, originEnd: head.end, target: here(prop.nameStart, prop.name.length) }
                : undefined;
        }
    }
    return undefined;
}

/** A style or resource name as written at `start`: local first, then imported, `ns.` through its namespace. */
function borrowedDefinition(index: WorkspaceIndex | undefined, file: string, structure: StructureResult,
    kind: BorrowedKind, written: string, start: number, offset: number): DefinitionHit | undefined {
    const dot = written.indexOf('.');
    if (dot > 0 && offset <= start + dot) {
        const namespace = index && namespaceNamed(index, file, written.slice(0, dot));
        return namespace ? { originStart: start, originEnd: start + dot, target: toTarget(fileTop(namespace.file)) }
            : undefined;
    }
    if (dot < 0) {
        // The file's own declaration needs no index: the live parse is the authority on its own text.
        const local = kind === 'style'
            ? structure.styles.find((style) => fold(style.name) === fold(written))
            : structure.resources.find((resource) => fold(resource.name) === fold(written));
        if (local) {
            return { originStart: start, originEnd: start + written.length,
                target: { file, start: local.nameStart, end: local.nameStart + local.name.length } };
        }
    }
    const found = index && findBorrowed(index, file, kind, written);
    if (!found || found.local) {
        return undefined;
    }
    return { originStart: dot > 0 ? start + dot + 1 : start, originEnd: start + written.length, target: toTarget(found.site) };
}

// ---- hover --------------------------------------------------------------------------------------------------------

export interface HoverFact {
    start: number;
    end: number;
    markdown: string;
}

function namespaceMarkdown(namespace: NamespaceInfo): string {
    const via = `\`use "${namespace.declaredAt.target}" as ${namespace.name}\``;
    const where = namespace.declaredAt.file !== namespace.file ? ` in \`${baseName(namespace.declaredAt.file)}\`` : '';
    return `**${namespace.name}** — namespace: library \`${baseName(namespace.file)}\`\n\nopened by ${via}${where}; `
        + `its styles are \`: ${namespace.name}.X\`, its resources \`@${namespace.name}.X\`, its components `
        + `\`${namespace.name}.X\``;
}

function borrowedMarkdown(kind: BorrowedKind, written: string, found: FoundDeclaration): string {
    const type = kind === 'resource' && found.site.type ? `${found.site.type} ` : '';
    const what = kind === 'style' ? 'style' : 'resource';
    const source = `\`${baseName(found.site.file)}\`, line ${found.site.line}`;
    const via = found.namespace ? ` — through \`use … as ${found.namespace.name}\`` : ' — brought in by `use`';
    return `\`${type}${written}\` — ${what} declared in ${source}${via}`;
}

/** Hover text for the names this module resolves; undefined where the tag/property hover of the symbols dump answers. */
export function hoverAt(index: WorkspaceIndex | undefined, file: string, structure: StructureResult,
    offset: number): HoverFact | undefined {
    for (const directive of structure.imports) {
        if (directive.alias && within(offset, directive.aliasStart, directive.alias.length)) {
            const span = { start: directive.aliasStart!, end: directive.aliasStart! + directive.alias.length };
            if (!index) {
                return undefined;
            }
            const namespace = namespaceNamed(index, file, directive.alias);
            if (namespace) {
                return { ...span, markdown: namespaceMarkdown(namespace) };
            }
            const facts = componentFacts(index, file, directive.alias);
            return facts ? { ...span, markdown: componentMarkdown(facts) } : undefined;
        }
    }

    for (const { node } of walkNodes(structure)) {
        if (node.kind === 'node' && within(offset, node.start, tagEndOf(node) - node.start) && index) {
            const dot = node.tag.indexOf('.');
            const anonymous = node.anonymous ? `\n\nunnamed — compiles as \`${node.id}\`` : '';
            if (dot > 0 && offset <= node.start + dot) {
                const namespace = namespaceNamed(index, file, node.tag.slice(0, dot));
                if (namespace) {
                    return { start: node.start, end: node.start + dot, markdown: namespaceMarkdown(namespace) };
                }
            }
            const facts = componentFacts(index, file, node.tag);
            if (facts) {
                return { start: node.start, end: tagEndOf(node), markdown: componentMarkdown(facts) + anonymous };
            }
            return undefined; // a tag: the symbols dump's hover answers, with the anonymous note added there
        }
        if (node.styleName && within(offset, node.styleNameStart, node.styleName.length) && index) {
            return borrowedHover(index, file, 'style', node.styleName, node.styleNameStart!, offset);
        }
        if (node.kind === 'node' && index) {
            for (const stmt of node.properties) {
                const head = stmt.path.split('.')[0];
                if (stmt.isSlot || !within(offset, stmt.pathStart, head.length)) {
                    continue;
                }
                const facts = componentFacts(index, file, node.tag);
                const summary = facts?.summary;
                if (!summary) {
                    return undefined;
                }
                const span = { start: stmt.pathStart, end: stmt.pathStart + head.length };
                if (stmt.op === 'eventArrow') {
                    const event = summary.events.find((entry) => fold(entry.name) === fold(head));
                    return event ? { ...span, markdown: `\`${event.params ? `${event.name}(${event.params})` : event.name}\``
                        + ` — event of \`${facts!.name}\` (\`${baseName(summary.file)}\`), raised there with \`emit\`` }
                        : undefined;
                }
                const prop = summary.props.find((entry) => fold(entry.name) === fold(head));
                return prop ? { ...span, markdown: `\`${propSignature(prop)}\` — prop of \`${facts!.name}\``
                    + ` (\`${baseName(summary.file)}\`)` } : undefined;
            }
        }
    }

    for (const style of structure.styles) {
        if (style.base && within(offset, style.baseStart, style.base.length) && index) {
            return borrowedHover(index, file, 'style', style.base, style.baseStart!, offset);
        }
    }
    for (const ref of structure.resourceRefs) {
        if (within(offset, ref.start, ref.name.length + 1) && index) {
            return borrowedHover(index, file, 'resource', ref.name, ref.start + 1, offset);
        }
    }

    for (const prop of structure.props ?? []) {
        if (within(offset, prop.nameStart, prop.name.length)) {
            return { start: prop.nameStart, end: prop.nameStart + prop.name.length,
                markdown: `\`${propSignature(prop)}\` — prop: a Blueprint variable of this class, editable on `
                    + 'instances; a host sets it (`=`) or binds it (`<-`)' };
        }
    }
    for (const event of structure.events ?? []) {
        if (within(offset, event.nameStart, event.name.length)) {
            return { start: event.nameStart, end: event.nameStart + event.name.length,
                markdown: `\`${eventSignature(event)}\` — event dispatcher of this class; raised with \`emit\`, `
                    + 'routed by a host with `->`' };
        }
    }
    for (const binding of structure.bindings) {
        if (binding.isEmit && within(offset, binding.nameStart, binding.name.length)) {
            const event = eventNamed(structure, binding.name);
            return { start: binding.nameStart, end: binding.nameStart + binding.name.length,
                markdown: event
                    ? `\`emit ${eventSignature(event)}\` — raises the event declared on line ${event.line}`
                    : `\`emit ${binding.name}\` — no \`events\` entry of this file declares it (DUI6010 at compile)` };
        }
        const head = bindingHeadSpan(binding);
        if (binding.isVariable && offset >= head.start && offset <= head.end) {
            const prop = propReadBy(structure, binding);
            if (prop) {
                return { ...head, markdown: `\`${propSignature(prop)}\` — prop of this class (line ${prop.line}): `
                    + 'the binding re-reads it whenever a host changes it' };
            }
        }
    }
    return undefined;
}

function borrowedHover(index: WorkspaceIndex, file: string, kind: BorrowedKind, written: string, start: number,
    offset: number): HoverFact | undefined {
    const dot = written.indexOf('.');
    if (dot > 0 && offset <= start + dot) {
        const namespace = namespaceNamed(index, file, written.slice(0, dot));
        return namespace ? { start, end: start + dot, markdown: namespaceMarkdown(namespace) } : undefined;
    }
    const found = findBorrowed(index, file, kind, written);
    if (!found || found.local) {
        return undefined; // the file's own: features.ts already describes it from the live parse
    }
    return { start, end: start + written.length, markdown: borrowedMarkdown(kind, written, found) };
}
