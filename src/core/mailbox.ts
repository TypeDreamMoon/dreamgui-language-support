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
 * ones, the structure layer's, and the resource-reference check in src/diagnostics.ts.
 *
 * Kept as one list because it is what the code table is held complete over: a code this extension
 * puts on the screen with no entry to open is a number and nothing else.
 */
export const LOCALLY_RAISED: ReadonlySet<number> = new Set([
    1001, 1002, 1003, 1004, 1005, 1006,
    2002, 2003, 2004, 2006, 2013,
    3001, 3002, 3004, 3005, 3008, 3010, 3011, 3012, 3014, 3015,
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
 *     both ways out, and is worth having beside the mirror's warning.
 */
export const MAILBOX_SUPPRESSED: ReadonlySet<number> = new Set([
    1001, 1002, 1003, 1004, 1005,
    2002, 2003, 2004, 2006,
    3001, 3002, 3004, 3005, 3008, 3014, 3015,
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
    return entry.diagnostics.filter((diagnostic) => !MAILBOX_SUPPRESSED.has(diagnostic.code));
}
