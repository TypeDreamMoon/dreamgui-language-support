/**
 * Reading `Intermediate/DreamSource/ui.db`, the database the Unreal editor writes what it knows
 * into (spec section 11.3). Read-only, one connection per read: holding a handle open would keep
 * a Windows editor from ever replacing the file, and opening one costs less than parsing the old
 * JSON did.
 *
 * `node:sqlite` is required lazily and its absence is an answer, not an error: an older VS Code
 * (its Node predates the module) reads the JSON files the way it always did.
 *
 * No vscode import, so the tests open real databases with it.
 */
import type * as Sqlite from 'node:sqlite';
import {
    DatabaseRevisions, DiagnosticRow, SymbolRow, SUPPORTED_SCHEMA, diagnosticRowsToMailboxText,
    reassembleSymbols, revisionsFromMeta,
} from './dreamSource';

let loaded: typeof Sqlite | null | undefined;

/** The module, or undefined when this Node has none. Asked once. */
export function loadSqlite(): typeof Sqlite | undefined {
    if (loaded === undefined) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            loaded = require('node:sqlite') as typeof Sqlite;
        } catch {
            loaded = null;
        }
    }
    return loaded ?? undefined;
}

export function isSqliteAvailable(): boolean {
    return loadSqlite() !== undefined;
}

function withDatabase<T>(databasePath: string, read: (database: Sqlite.DatabaseSync) => T): T | undefined {
    const sqlite = loadSqlite();
    if (!sqlite) {
        return undefined;
    }
    let database: Sqlite.DatabaseSync | undefined;
    try {
        database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
        try {
            // A write in flight holds the lock for a moment; wait it out rather than read nothing.
            database.exec('PRAGMA busy_timeout = 2000;');
        } catch {
            // Not fatal: the read below either gets through or throws into the catch.
        }
        return read(database);
    } catch {
        return undefined;
    } finally {
        try {
            database?.close();
        } catch {
            // Closing a connection that failed to open: nothing to release.
        }
    }
}

/** The meta revisions, or undefined when the file cannot be opened as a database at all. */
export function readRevisions(databasePath: string): DatabaseRevisions | undefined {
    return withDatabase(databasePath, (database) =>
        revisionsFromMeta(database.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]));
}

export function isSupportedSchema(revisions: DatabaseRevisions | undefined): boolean {
    return revisions?.schema === SUPPORTED_SCHEMA;
}

/** The symbols table as the object `.dui-symbols.json` held, or undefined when there are none. */
export function readSymbolsObject(databasePath: string): Record<string, unknown> | undefined {
    return withDatabase(databasePath, (database) => {
        const rows = database.prepare('SELECT section, name, json FROM symbols').all() as SymbolRow[];
        return rows.length > 0 ? reassembleSymbols(rows) : undefined;
    });
}

/** The diagnostics table as version-1 mailbox text, for parseMailbox. */
export function readMailboxText(databasePath: string): string | undefined {
    return withDatabase(databasePath, (database) => diagnosticRowsToMailboxText(
        database.prepare('SELECT path, compiled_at_utc, json FROM diagnostics').all() as DiagnosticRow[]));
}
