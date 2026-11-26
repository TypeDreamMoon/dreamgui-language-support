/**
 * The ui.db reader against a real database, built here with the schema of spec 11.3 the way the
 * DreamGUI editor writes it (WAL, the meta revisions, symbols by section and member). Skipped on a
 * Node without node:sqlite, which is also the case the extension falls back to JSON for.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSqliteAvailable, isSupportedSchema, loadSqlite, readMailboxText, readRevisions, readSymbolsObject }
    from '../src/core/sourceDatabase';
import { parseMailbox } from '../src/core/mailbox';
import { normalizeSymbols } from '../src/core/symbolFacts';

const skip = isSqliteAvailable() ? false : 'this Node has no node:sqlite';

function buildDatabase(write: (exec: (sql: string, ...params: unknown[]) => void) => void): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamui-db-'));
    const file = path.join(directory, 'ui.db');
    const sqlite = loadSqlite()!;
    const database = new sqlite.DatabaseSync(file);
    database.exec('PRAGMA journal_mode=WAL;');
    database.exec(`
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE symbols(section TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(section, name));
        CREATE TABLE diagnostics(path TEXT PRIMARY KEY, compiled_at_utc TEXT NOT NULL, json TEXT NOT NULL);`);
    write((sql, ...params) => {
        database.prepare(sql).run(...params);
    });
    database.close();
    return file;
}

test('reads the meta revisions, the symbols and the diagnostics of a ui.db', { skip }, () => {
    const file = buildDatabase((run) => {
        for (const [key, value] of [['schema', '1'], ['producer', 'DreamGUI@1.0.0'], ['revision', '4'],
            ['symbols_revision', '2'], ['diagnostics_revision', '2']]) {
            run('INSERT INTO meta(key, value) VALUES (?, ?)', key, value);
        }
        run('INSERT INTO symbols VALUES (?, ?, ?)', 'version', '', '2');
        run('INSERT INTO symbols VALUES (?, ?, ?)', 'tags', 'Image',
            JSON.stringify({ kind: 'visual', class: 'DreamImage', properties: [{ name: 'Tint', type: 'color' }] }));
        run('INSERT INTO symbols VALUES (?, ?, ?)', 'widgetProperties', '', JSON.stringify([{ name: 'Visibility' }]));
        run('INSERT INTO symbols VALUES (?, ?, ?)', 'viewModels', '', '{}');
        run('INSERT INTO diagnostics VALUES (?, ?, ?)', 'X:/P/DreamSource/UI/Main.dui', '2026-11-26T10:00:00Z',
            JSON.stringify([{ code: 5004, severity: 'error', line: 3, column: 7, message: 'Bad.' }]));
    });

    const revisions = readRevisions(file)!;
    assert.deepEqual(revisions, { schema: 1, revision: 4, symbols: 2, diagnostics: 2 });
    assert.ok(isSupportedSchema(revisions));

    const symbols = readSymbolsObject(file)!;
    assert.equal(symbols.version, 2);
    assert.deepEqual(symbols.viewModels, {});
    const normalized = normalizeSymbols(symbols);
    assert.equal(normalized.tags.Image.class, 'DreamImage');
    assert.equal(normalized.widgetProperties?.[0].name, 'Visibility');

    const mailbox = parseMailbox(readMailboxText(file)!)!;
    assert.equal(mailbox.files['X:/P/DreamSource/UI/Main.dui'].diagnostics[0].line, 3);
});

test('a database with no symbols yet reads as none, and another schema is not supported', { skip }, () => {
    const file = buildDatabase((run) => {
        run('INSERT INTO meta(key, value) VALUES (?, ?)', 'schema', '2');
    });
    assert.equal(readSymbolsObject(file), undefined);
    assert.ok(!isSupportedSchema(readRevisions(file)));
    assert.equal(parseMailbox(readMailboxText(file)!)!.files && Object.keys(parseMailbox(readMailboxText(file)!)!.files).length, 0);
});

test('a missing or foreign file is an answer of nothing, not a throw', { skip }, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamui-db-'));
    assert.equal(readRevisions(path.join(directory, 'absent.db')), undefined);
    const foreign = path.join(directory, 'foreign.db');
    fs.writeFileSync(foreign, 'not a database at all');
    assert.equal(readRevisions(foreign), undefined);
    assert.equal(readSymbolsObject(foreign), undefined);
});
