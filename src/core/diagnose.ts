/**
 * Every verdict this extension reaches on its own, in one function with no editor in it.
 *
 * The judging used to live inside the vscode provider, mixed in with ranges and severity enums,
 * which meant the decisions that matter -- what an import exempts, what a file with no root is
 * allowed to be, when an '@' is a mistake -- were only reachable through a running editor and so
 * were only ever tested by hand. Moving them here is not a tidy-up: it is what lets the corpus
 * sweep judge real files the way the editor judges them, index and all.
 *
 * The rule the whole extension is built on applies here hardest: reporting LESS than the compiler
 * is allowed, reporting differently is not. Most of the checks below exist only to withhold a
 * refusal the structural layer would otherwise make on knowledge one file's characters cannot
 * carry -- and the ones that ADD a verdict from the index (a namespaced name that is not there, an
 * alias that a built-in already answers to) say it only when every `use` they depend on resolved,
 * and as a warning where the index's resolution, not the file, is what makes it certain.
 *
 * No vscode import here, ever: src/core/ is the seam a future LSP server or another IDE reuses.
 */

import { buildStructure, StructNode } from './structure';
import { ImportScope, WorkspaceIndex, usesOf } from './workspaceIndex';

/**
 * A diagnostic in the shapes core can speak: offsets, not positions, and a code that may be
 * absent -- two of the checks here mirror no compiler code at all, and inventing one for them
 * would put a number in the Problems panel that no `dreamui.explain` and no compiler message can
 * ever account for.
 */
export interface CoreDiagnostic {
    /** The numeric half of DUInnnn. Absent for the checks the compiler has no code for. */
    code?: number;
    severity: 'error' | 'warning' | 'information';
    /** Without the code prefix: the host spells `DUInnnn: ` in front when there is a code. */
    message: string;
    start: number;
    end: number;
}

export type DuiStructure = ReturnType<typeof buildStructure>;

export interface JudgeInput {
    /**
     * The document's own path: an import chain that comes back to it is a cycle, which imports nothing.
     */
    file: string;
    text: string;
    /** Every .dui the host can see. Without it the import exemptions cannot fire; see below. */
    index?: WorkspaceIndex;
    /**
     * Tag names out of the plugin's symbols dump -- visuals, registered widgets and layout containers. `undefined`
     * means no dump is loaded and the tag sweep stays silent; an empty array means a dump that declares no tags,
     * which is a different thing and reports every tag.
     */
    tags?: readonly string[];
    /**
     * The same dump's `tags` entries, for what each one IS: DUI3018's message names a container's class, and a
     * word only refuses an alias when it is a visual's tag or a container. Absent, DUI3018 is not judged.
     */
    tagInfo?: Readonly<Record<string, { kind?: string; class?: string }>>;
    /** The parse of `text`, when the caller already made one. Must be that parse and no other. */
    structure?: DuiStructure;
}

const fold = (name: string): string => name.toLowerCase();

export function judgeDocument(input: JudgeInput): CoreDiagnostic[] {
    const structure = input.structure ?? buildStructure(input.text);
    const out: CoreDiagnostic[] = [];

    // What `use` imports bring into scope. The structure layer judges one file's characters;
    // styles, resources and component names arriving through imports are workspace knowledge, so
    // the refusals that would be wrong for them are withheld HERE rather than taught to the parser.
    //
    // TRANSITIVELY, which is what the compiler does: ParseUseDeclaration merges the imported file's
    // OWN imports into the importer alongside its local declarations, so `A uses B` and `B uses C`
    // puts C's styles in A's scope -- the entire point of a layered style library. And by the `as`:
    // a library used `as ui` lands under `ui.`, a component used `as Row` brings nothing but its
    // name. A spelling that resolves to nothing (or ambiguously) imports nothing here -- reporting
    // less than the compiler is allowed, reporting differently is not, so only a UNIQUE resolution
    // is trusted, and `complete` says whether every one was.
    const index = input.index;
    const ownUses = usesOf(structure.imports);
    const scope: ImportScope | undefined = index ? index.importScopeOf(ownUses, input.file) : undefined;
    const importedStyles = scope?.styles ?? new Set<string>();
    /** True when nothing this file imports is out of the index's sight: absence is then the compiler's absence too. */
    const importsKnown = scope ? scope.complete : !ownUses.some((use) => use.targetKind === 'file');

    /**
     * The style name a DUI3004 says is missing, in either of the two shapes the structural layer
     * words it: a node wearing one, and a style inheriting one.
     *
     * FDreamUIAst::FindStyle (DreamUIAst.cpp) looks through the local styles and THEN through
     * ImportedStyles, and the base walk in DreamUITextBuilder.cpp resolves every link through that
     * same call -- so `style Card : ImportedBase` is as legal as `Text T : ImportedStyle`.
     */
    const missingStyleIn = (message: string): string | undefined => {
        const worn = /^'([^']+)' names a style this file does not declare/.exec(message);
        if (worn) {
            return worn[1];
        }
        const inherited = /^style '[^']+' inherits '([^']+)', which this file does not declare/.exec(message);
        return inherited ? inherited[1] : undefined;
    };
    const importCoversStyle = (message: string): boolean => {
        const missing = missingStyleIn(message);
        return missing !== undefined && importedStyles.has(fold(missing));
    };

    // A library legitimately declares no root: the compiler only demands a root of a file it
    // compiles AS a class, and an imported file is read for its declarations -- styles, resources,
    // and the component names it gives every screen that uses it.
    const isDeclarationLibrary = structure.roots.length === 0
        && (structure.styles.length > 0 || structure.resources.length > 0
            || structure.imports.some((directive) => directive.alias !== undefined && !directive.refused));

    for (const lexical of structure.lexical) {
        out.push({ code: lexical.code, severity: lexical.severity, message: lexical.message,
            start: lexical.start, end: lexical.end });
    }
    for (const structural of structure.diagnostics) {
        if (structural.code === 3004 && importCoversStyle(structural.message)) {
            continue;
        }
        if (structural.code === 2006 && isDeclarationLibrary) {
            continue;
        }
        out.push({ code: structural.code, severity: structural.severity, message: structural.message,
            start: structural.start, end: structural.end });
    }

    // A stray '}' at the top level: the structure layer steps over it (the compiler words that
    // refusal), but leaving it entirely unmarked reads as "fine". No code on purpose.
    let depth = 0;
    for (const token of structure.tokens) {
        if (token.kind === 'openBrace') {
            depth++;
        } else if (token.kind === 'closeBrace') {
            depth--;
            if (depth < 0) {
                out.push({ severity: 'error', message: "'}' closes nothing",
                    start: token.start, end: token.end });
                depth = 0;
            }
        }
    }

    // A namespace-qualified name the structural layer could not settle alone: it settled the ones no `use` of this
    // file can explain (and said DUI3021 itself); the rest -- a plain `use` may carry a namespace in, an `as` names a
    // namespace only when its file has no root -- are settled here, and only when every import was followed.
    const namespaceRefs = structure.namespaceRefs ?? [];
    const unknownNamespaceAt = new Set<number>(namespaceRefs.filter((ref) => ref.reported).map((ref) => ref.start));
    if (scope && scope.complete) {
        for (const ref of namespaceRefs) {
            if (ref.reported || scope.namespaces.has(fold(ref.prefix))) {
                continue;
            }
            unknownNamespaceAt.add(ref.start);
            out.push({
                code: 3021, severity: 'warning',
                message: `'${ref.name}' is qualified by '${ref.prefix}', which no 'use "..." as ${ref.prefix}' declares`,
                start: ref.start, end: ref.end,
            });
        }
        // A namespaced style the namespace's library does not have. A node's clause only: a style's base is walked
        // by the builder from the nodes that wear it, which is the structural layer's rule and stays its own.
        const baseStarts = new Set(structure.styles.map((style) => style.baseStart));
        for (const ref of namespaceRefs) {
            if (ref.kind !== 'style' || unknownNamespaceAt.has(ref.start) || baseStarts.has(ref.start)
                || importedStyles.has(fold(ref.name))) {
                continue;
            }
            out.push({
                code: 3004, severity: 'warning',
                message: `'${ref.name}' names a style this file does not declare`,
                start: ref.start, end: ref.end,
            });
        }
    }

    // '@Name' against this file's own resources block and what its imports bring, case
    // insensitively as FindResource compares them. DUI4007 is the compiler's code for the same
    // refusal. A namespaced one is only judged once its namespace is known to be there (DUI3021
    // otherwise, said once, as the compiler says it).
    const declared = new Set(structure.resources.map((entry) => fold(entry.name)));
    for (const ref of structure.resourceRefs) {
        const name = fold(ref.name);
        if (declared.has(name) || scope?.resources.has(name)) {
            continue;
        }
        if (ref.name.includes('.')) {
            if (!scope || !scope.complete || unknownNamespaceAt.has(ref.start)) {
                continue;
            }
        }
        out.push({
            code: 4007, severity: 'warning',
            message: ref.nodeType
                ? `'@${ref.name}' names no entry in a resources block; a node type written with '@' is an Asset resource, as in 'Asset ${ref.name} = /Game/UI/WBP_${ref.name}'`
                : `'@${ref.name}' names no entry in a resources block`,
            // The '@' and the name after it: one more character than the name is long.
            start: ref.start, end: ref.end ?? ref.start + ref.name.length + 1,
        });
    }

    // DUI3018: a `use … as` name that a built-in tag or a layout container already answers to. The builder asks the
    // built-ins first, so such an alias could never be written as a type. Only a component's name is one -- a class
    // path's always, a file's when the index sees a root in it (a warning: the index's resolution is what says so) --
    // and only a word the dump spells exactly that way: FName ignores case, and this check is allowed to see less.
    if (input.tagInfo) {
        for (const directive of structure.imports) {
            if (directive.refused || directive.alias === undefined || directive.aliasStart === undefined
                || directive.alias.includes('.')) {
                continue;
            }
            const info = Object.prototype.hasOwnProperty.call(input.tagInfo, directive.alias)
                ? input.tagInfo[directive.alias] : undefined;
            const what = info?.kind === 'visual' ? 'a built-in tag'
                : info?.kind === 'container' && info.class ? `a layout container (${info.class})` : undefined;
            if (!what) {
                continue;
            }
            const kind = directive.target === 'class' ? 'component'
                : index ? index.classifyAlias({ target: directive.path, targetKind: 'file' }) : 'unresolved';
            if (kind !== 'component') {
                continue;
            }
            out.push({
                code: 3018, severity: directive.target === 'class' ? 'error' : 'warning',
                message: `'${directive.alias}' is already ${what}, which a node type means before any alias -- choose another name`,
                start: directive.aliasStart, end: directive.aliasStart + directive.alias.length,
            });
        }
    }

    // Unknown tags, only when symbols are loaded and only as information: a tag can also be an
    // asset path, and the compiler's own message is the real verdict. A component's name is a type
    // too -- this file's own `as` names, and every one its libraries pass on -- so a name that is
    // none of those is only called unknown when every import was followed.
    if (input.tags) {
        const known = new Set(input.tags);
        const aliasNames = new Set<string>([
            ...structure.imports.filter((directive) => directive.alias !== undefined && !directive.refused)
                .map((directive) => fold(directive.alias!)),
            ...(scope?.aliases ?? []).map((alias) => fold(alias.name)),
        ]);
        const lines = lineStarts(input.text);
        const visit = (node: StructNode): void => {
            if (node.kind === 'node' && !known.has(node.tag) && !node.tag.startsWith('/') && !node.tag.startsWith('@')
                && !aliasNames.has(fold(node.tag)) && importsKnown) {
                // Anchored by searching the header's line for the tag rather than by trusting the
                // token offset: a scoped tag ('Native.Toggle') is three tokens joined into one
                // name, and its span is the text, not any single token.
                const lineStart = lines[node.line - 1] ?? 0;
                const lineEnd = lines[node.line] ?? input.text.length;
                const at = Math.max(0, input.text.slice(lineStart, lineEnd).indexOf(node.tag));
                out.push({
                    severity: 'information',
                    message: `'${node.tag}' is not a built-in tag (the compiler also accepts /asset paths)`,
                    start: lineStart + at, end: lineStart + at + node.tag.length,
                });
            }
            node.children.forEach(visit);
        };
        structure.roots.forEach(visit);
    }

    return out;
}

/**
 * Offset of the first character of every line, 0-based index for a 1-based line number minus one.
 * The last entry is one past the text so a line's end is always `starts[n]`.
 *
 * A line ends where the scanner says it ends, which is why the three flavours of break are all
 * counted: a lone '\r' file would otherwise report every tag on line one.
 */
function lineStarts(text: string): number[] {
    const starts = [0];
    for (let offset = 0; offset < text.length; offset++) {
        const code = text.charCodeAt(offset);
        if (code === 0x0d && text.charCodeAt(offset + 1) === 0x0a) {
            offset++;
        } else if (code !== 0x0a && code !== 0x0d) {
            continue;
        }
        starts.push(offset + 1);
    }
    starts.push(text.length);
    return starts;
}
