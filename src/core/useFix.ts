/**
 * The `use "..."` quickfix, planned: which file declares the name the diagnostic complained
 * about, how this file should spell a path to it, and where the directive goes.
 *
 * The spelling is the delicate half. The compiler resolves `use` against the DUI roots, which
 * this side cannot know; the workspace index mirrors that with a path-suffix match, and the
 * mirror only agrees with the compiler when the match is UNIQUE. So a candidate spelling is
 * never trusted for being well-formed -- it is fed back through the same resolver every other
 * feature uses, and only a spelling that resolves to exactly the intended file is offered. An
 * import that lands on the wrong file is worse than no quickfix at all.
 *
 * No vscode import here: src/core/ is the seam a future LSP server or another IDE reuses.
 */

import { EditPlan } from './quickfixes';
import { StructureResult } from './structure';
import { Token } from './scanner';
import { WorkspaceIndex } from './workspaceIndex';

const norm = (filePath: string): string => filePath.replace(/\\/g, '/');
const fold = (text: string): string => norm(text).toLowerCase();

/** The files whose declarations carry this name. Case insensitive, as the compiler compares. */
export function filesDeclaring(index: WorkspaceIndex, kind: 'style' | 'resource', name: string): string[] {
    const wanted = name.toLowerCase();
    const out: string[] = [];
    for (const summary of index.allSummaries()) {
        const declarations = kind === 'style' ? summary.styles : summary.resources;
        if (declarations.some((entry) => entry.name.toLowerCase() === wanted)) {
            out.push(summary.file);
        }
    }
    return out;
}

/**
 * The component files a type name that resolves to nothing could have meant: files with a root node whose name is
 * the type -- `Row` -> `Row.dui`, or the prefixed family spelling the corpus uses, `NieR_Row.dui`. Exact names win
 * over prefixed ones, so `Row` never picks `NieR_Row.dui` while a `Row.dui` exists. The caller acts on a UNIQUE answer
 * only: two candidates are two guesses, and an import that names the wrong class is worse than none.
 */
export function componentFilesNamed(index: WorkspaceIndex, typeName: string): string[] {
    if (!/^[A-Za-z_\u00A0-\uFFFF][\w\u00A0-\uFFFF]*$/u.test(typeName)) {
        return [];
    }
    const wanted = typeName.toLowerCase();
    const exact: string[] = [];
    const prefixed: string[] = [];
    for (const summary of index.allSummaries()) {
        if (!summary.hasRoot) {
            continue;
        }
        const base = norm(summary.file).replace(/^.*\//, '').replace(/\.dui$/i, '').toLowerCase();
        if (base === wanted) {
            exact.push(summary.file);
        } else if (base.endsWith('_' + wanted)) {
            prefixed.push(summary.file);
        }
    }
    return exact.length > 0 ? exact : prefixed;
}

export interface UseStyle {
    /** The file's existing `use` lines all lead with './'. */
    leadingDot: boolean;
    separator: '/' | '\\';
}

/**
 * How this file already spells its imports. Unanimity is the bar: one file mixing spellings has
 * no house style to follow, and forward slashes without a prefix are what the corpus writes.
 */
export function useStyleOf(existing: readonly string[]): UseStyle {
    const written = existing.filter((spelling) => spelling.length > 0);
    return {
        leadingDot: written.length > 0 && written.every((spelling) => spelling.startsWith('./')),
        separator: written.length > 0 && written.every(
            (spelling) => spelling.includes('\\') && !spelling.includes('/')) ? '\\' : '/',
    };
}

export function applyUseStyle(spelling: string, style: UseStyle): string {
    const withPrefix = style.leadingDot && !spelling.startsWith('./') ? `./${spelling}` : spelling;
    return style.separator === '\\' ? withPrefix.replace(/\//g, '\\') : withPrefix;
}

export interface UseSpellingInput {
    /** Absolute path of the document being fixed. */
    documentFile: string;
    /** Absolute path of the file that declares the wanted name. */
    targetFile: string;
    /** This file's `use` directives, exactly as written. */
    existing: readonly string[];
    /** The index's resolver -- the same one diagnostics and go-to-definition are judged by. */
    resolve: (spelling: string) => string[];
}

/**
 * A spelling this file can write for `targetFile`, or nothing when none round-trips. Preference
 * runs document-relative first (what an author would type, and what the corpus writes: the DUI
 * root and the file's own directory coincide for everything under it), then the shortest
 * path suffix that is still unambiguous.
 */
export function planUseSpelling(input: UseSpellingInput): string | undefined {
    const target = norm(input.targetFile);
    const targetKey = target.toLowerCase();

    // Already imported: the name being unknown is then a timing artefact -- the index had not
    // taken the library in when the diagnostic ran -- and a second `use` would fix nothing.
    for (const spelling of input.existing) {
        if (input.resolve(spelling).some((file) => fold(file) === targetKey)) {
            return undefined;
        }
    }

    const documentDirectory = norm(input.documentFile).replace(/\/[^/]*$/, '');
    const candidates: string[] = [];
    if (documentDirectory.length > 0 && targetKey.startsWith(documentDirectory.toLowerCase() + '/')) {
        candidates.push(target.slice(documentDirectory.length + 1));
    }
    const segments = target.split('/').filter((segment) => segment.length > 0);
    for (let count = 1; count <= segments.length; count++) {
        candidates.push(segments.slice(segments.length - count).join('/'));
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
        if (candidate.length === 0 || seen.has(candidate.toLowerCase())) {
            continue;
        }
        seen.add(candidate.toLowerCase());
        const resolved = input.resolve(candidate);
        if (resolved.length === 1 && fold(resolved[0]) === targetKey) {
            return applyUseStyle(candidate, useStyleOf(input.existing));
        }
    }
    return undefined;
}

/**
 * Where the directive goes: after the last `use`, else after the class line, else before the
 * file's first statement. The class line keeps its place at the top by convention only -- the
 * compiler's file-scope loop accepts these declarations in any order -- but every .dui in the
 * corpus is written that way, and a quickfix is not the place to start a second convention.
 */
export function planUseInsertion(
    structure: StructureResult & { tokens: Token[] }, spelling: string, sourceLength: number, alias?: string): EditPlan {
    // `as Row` names the file's class as a node type (a component), or opens it as a namespace (a library).
    const directive = alias ? `use "${spelling}" as ${alias}` : `use "${spelling}"`;

    const last = structure.imports[structure.imports.length - 1];
    if (last) {
        return { offset: Math.min(last.pathEnd, sourceLength), text: `\n${directive}` };
    }
    if (structure.classPath) {
        return { offset: Math.min(structure.classPath.end, sourceLength), text: `\n\n${directive}` };
    }
    // Comments are not tokens, so the first token that is not a line break IS the first
    // statement -- which is exactly what a file's header comment should stay above.
    const first = structure.tokens.find((token) => token.kind !== 'separator' && token.kind !== 'end');
    return { offset: first ? first.start : 0, text: `${directive}\n\n` };
}
