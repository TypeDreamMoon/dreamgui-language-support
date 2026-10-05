/**
 * The diagnostics mailbox: `DUI/.dui-diagnostics.json`, written by the Unreal editor after every
 * compile of a text-backed class (the watcher's recompiles and manual ones alike), read here into
 * the Problems panel. This file is the contract's single source: the C++ writer conforms to what
 * parseMailbox accepts.
 *
 * The shape, version 1:
 *
 *   {
 *     "version": 1,
 *     "files": {
 *       "<absolute .dui path>": {
 *         "compiledAt": "<ISO-8601>",
 *         "diagnostics": [
 *           { "code": 5004, "severity": "error", "line": 12, "column": 5, "message": "..." }
 *         ]
 *       }
 *     }
 *   }
 *
 * A file that compiled clean appears with an empty diagnostics array -- that is what CLEARS its
 * squiggles; absence means "no news", not "no problems". Line and column are 1-based, as every
 * DUInnnn message counts them.
 */

export interface MailboxDiagnostic {
    code: number;
    severity: 'error' | 'warning';
    line: number;
    column: number;
    message: string;
}

export interface MailboxFileEntry {
    compiledAt?: string;
    diagnostics: MailboxDiagnostic[];
}

export interface Mailbox {
    version: number;
    files: Record<string, MailboxFileEntry>;
}

/**
 * Every code the extension's own layers can raise, live on every keystroke. The scanner's lexical
 * ones, the structure layer's (core/structure.ts), and the index-aware judge's (core/diagnose.ts:
 * DUI4007 for a missing resource, DUI3018 for an alias a built-in answers to, and the namespaced
 * DUI3004 / DUI3021 it settles once every import was followed).
 *
 * Kept as one list because it is what the code table is held complete over: a code this extension
 * puts on the screen with no entry to open is a number and nothing else.
 */
export const LOCALLY_RAISED: ReadonlySet<number> = new Set([
    1001, 1002, 1003, 1004, 1005, 1006,
    2002, 2003, 2004, 2006, 2013, 2015, 2016, 2017, 2018, 2019, 2020, 2021,
    3001, 3002, 3004, 3005, 3008, 3010, 3011, 3012, 3014, 3015, 3016, 3017, 3018, 3019, 3020, 3021, 3022, 3023, 3024,
    4007,
]);

/**
 * The subset whose mailbox copies are dropped: one fact should not wear two squiggles, and for
 * these the local squiggle is fresher than any compile and says the same thing.
 *
 * "Says the same thing" is the membership test, not "we raise it too", and it is the only thing
 * standing between this file and a compile that failed reading as clean. A code whose local check
 * is WEAKER than the compiler's must stay out, or the compiler's copy of a case the mirror cannot
 * see is thrown away -- DUI2012 is the standing example (a `use` resolves against the compiler's
 * search roots, which the extension does not have). Three locally-raised codes are outside it:
 *
 *   - DUI2013, because this parser spends its depth budget on blocks only, where the compiler also
 *     spends it on parenthesised sub-expressions;
 *   - DUI1006, because the mirror reads the unsaved buffer and the compiler read the file on disk,
 *     so the two can be about different words in the same file;
 *   - DUI3010/3011/3012, which had no raise site in the compiler at all when this set was written
 *     and now arrive as errors that fail the compile. The compiler's message names both nodes and
 *     both ways out, and is worth having beside the mirror's warning;
 *   - DUI3018, which the mirror can only say for a class-path alias, or a file the index resolves,
 *     spelt exactly as the symbols dump spells the tag -- the compiler compares FNames and needs no
 *     index;
 *   - DUI3021, which the mirror settles alone only for a file with no plain `use`, and otherwise
 *     only once every import resolved in the index -- the compiler resolves them against its DUI
 *     roots and always knows.
 *
 * The parse-level codes the `use … as` / props / events / if / slot grammar added (2015-2019, 3016,
 * 3017, 3019, 3020, 3022) ARE in it, and so are the `rows` table's (2020, 3023): each is one file's characters, the mirror consumes every one of
 * those productions token for token as FParser does, and says each refusal the compiler says there.
 */
export const MAILBOX_SUPPRESSED: ReadonlySet<number> = new Set([
    1001, 1002, 1003, 1004, 1005,
    2002, 2003, 2004, 2006, 2015, 2016, 2017, 2018, 2019, 2020, 2021,
    3001, 3002, 3004, 3005, 3008, 3014, 3015, 3016, 3017, 3019, 3020, 3022, 3023, 3024,
    4007,
]);

/** Parses and shape-checks; undefined for anything that is not a well-formed mailbox. */
export function parseMailbox(json: string): Mailbox | undefined {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return undefined;
    }
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const candidate = raw as { version?: unknown; files?: unknown };
    if (candidate.version !== 1 || typeof candidate.files !== 'object' || candidate.files === null) {
        return undefined;
    }

    const files: Record<string, MailboxFileEntry> = {};
    for (const [file, value] of Object.entries(candidate.files as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) {
            continue;
        }
        const entry = value as { compiledAt?: unknown; diagnostics?: unknown };
        const diagnostics: MailboxDiagnostic[] = [];
        if (Array.isArray(entry.diagnostics)) {
            for (const item of entry.diagnostics) {
                if (typeof item !== 'object' || item === null) {
                    continue;
                }
                const diagnostic = item as Record<string, unknown>;
                if (typeof diagnostic.code === 'number'
                    && (diagnostic.severity === 'error' || diagnostic.severity === 'warning')
                    && typeof diagnostic.line === 'number'
                    && typeof diagnostic.column === 'number'
                    && typeof diagnostic.message === 'string') {
                    diagnostics.push({
                        code: diagnostic.code, severity: diagnostic.severity,
                        line: diagnostic.line, column: diagnostic.column, message: diagnostic.message,
                    });
                }
            }
        }
        files[file] = {
            compiledAt: typeof entry.compiledAt === 'string' ? entry.compiledAt : undefined,
            diagnostics,
        };
    }
    return { version: 1, files };
}

/** What the Problems panel should show from an entry: the compiler's codes minus the suppressed. */
export function mailboxDiagnosticsToShow(entry: MailboxFileEntry): MailboxDiagnostic[] {
    return entry.diagnostics.filter((diagnostic) =>
        !MAILBOX_SUPPRESSED.has(diagnostic.code) || namesAQualifiedName(diagnostic));
}

/**
 * DUI3004 and DUI4007 about a NAMESPACED name (`'nier.Lable' names a style …`, `'@nier.Inc' names no entry …`).
 *
 * Those two codes are suppressed because the live layer says them at least as often as the compiler for a plain
 * name. For a namespaced one it does not: the library behind the namespace is another file, and the judge only says
 * it is missing once the index has followed every import. That is the case MAILBOX_SUPPRESSED's own rule keeps out
 * -- a weaker local check -- so the compiler's copy is let through, told apart by the dot in the name it quotes.
 */
function namesAQualifiedName(diagnostic: MailboxDiagnostic): boolean {
    if (diagnostic.code !== 3004 && diagnostic.code !== 4007) {
        return false;
    }
    const quoted = /'@?([^']*)'/.exec(diagnostic.message);
    return quoted !== null && quoted[1].includes('.');
}
