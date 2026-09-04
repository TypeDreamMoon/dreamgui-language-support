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
 * is allowed, reporting differently is not. Three of the five checks below exist only to withhold
 * a refusal the structural layer would otherwise make on knowledge one file's characters cannot
 * carry.
 *
 * No vscode import here, ever: src/core/ is the seam a future LSP server or another IDE reuses.
 */

import { buildStructure, StructNode } from './structure';
import { WorkspaceIndex } from './workspaceIndex';

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
     * The document's own path. Nothing below reads it yet -- import resolution asks the index
     * about a spelling, not about who wrote it -- but every caller has it, and a judgement that
     * needs to know which file it is judging (an import that resolves to the file itself, say)
     * should not have to change every call site to find out.
     */
    file: string;
    text: string;
    /** Every .dui the host can see. Without it the import exemptions cannot fire; see below. */
    index?: WorkspaceIndex;
    /**
     * Tag names out of the plugin's symbols dump. `undefined` means no dump is loaded and the tag
     * sweep stays silent; an empty array means a dump that declares no tags, which is a different
     * thing and reports every tag.
     */
    tags?: readonly string[];
    /** The parse of `text`, when the caller already made one. Must be that parse and no other. */
    structure?: DuiStructure;
}

const fold = (name: string): string => name.toLowerCase();

export function judgeDocument(input: JudgeInput): CoreDiagnostic[] {
    const structure = input.structure ?? buildStructure(input.text);
    const out: CoreDiagnostic[] = [];

    // What `use` imports bring into scope. The structure layer judges one file's characters;
    // styles and resources arriving through imports are workspace knowledge, so the refusals that
    // would be wrong for them are withheld HERE rather than taught to the parser. A spelling that
    // resolves to nothing (or ambiguously) imports nothing -- reporting less than the compiler is
    // allowed, reporting differently is not, so only a UNIQUE resolution is trusted.
    const importedStyles = new Set<string>();
    const importedResources = new Set<string>();
    const index = input.index;
    if (index) {
        for (const directive of structure.imports) {
            const matches = index.resolveImportSpelling(directive.path);
            if (matches.length !== 1) {
                continue;
            }
            const summary = index.summaryOf(matches[0]);
            if (!summary) {
                continue;
            }
            for (const style of summary.styles) {
                importedStyles.add(fold(style.name));
            }
            for (const resource of summary.resources) {
                importedResources.add(fold(resource.name));
            }
        }
    }
    /**
     * The style name a DUI3004 says is missing, in either of the two shapes the structural layer
     * words it: a node wearing one, and a style inheriting one.
     *
     * The second shape was missing here, and its absence was a false red on a file that compiles:
     * FDreamUIAst::FindStyle (DreamUIAst.cpp) looks through the local styles and THEN through
     * ImportedStyles, and the base walk in DreamUITextBuilder.cpp resolves every link through that
     * same call -- so `style Card : ImportedBase` is as legal as `Text T : ImportedStyle`, and the
     * mirror, which can only see one file, was refusing one of them.
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

    // A style-and-resource library legitimately declares no root: the compiler only demands a root
    // of a file it compiles AS a class, and an imported file is read for its declarations.
    const isDeclarationLibrary = structure.roots.length === 0
        && (structure.styles.length > 0 || structure.resources.length > 0);

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

    // '@Name' against this file's own resources block, case insensitively as FindResource compares
    // them. DUI4007 is the compiler's code for the same refusal.
    const declared = new Set(structure.resources.map((entry) => fold(entry.name)));
    for (const ref of structure.resourceRefs) {
        if (!declared.has(fold(ref.name)) && !importedResources.has(fold(ref.name))) {
            out.push({
                code: 4007, severity: 'warning',
                message: `'@${ref.name}' names no entry in a resources block`,
                // The '@' and the name after it: one more character than the name is long.
                start: ref.start, end: ref.start + ref.name.length + 1,
            });
        }
    }

    // Unknown tags, only when symbols are loaded and only as information: a tag can also be an
    // asset path, and the compiler's own message is the real verdict.
    if (input.tags) {
        const known = new Set(input.tags);
        const lines = lineStarts(input.text);
        const visit = (node: StructNode): void => {
            if (node.kind === 'node' && !known.has(node.tag) && !node.tag.startsWith('/')) {
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
