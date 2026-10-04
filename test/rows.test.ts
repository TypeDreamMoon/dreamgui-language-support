/**
 * `rows Type : Style (Column, Column) { values, values }` -- a table of instances -- through every layer it touches:
 * the structure reads each line into the unnamed child the compiler makes of it, with the compiler's id; the header is
 * described once; the grammar colours the header; the formatter keeps the table a table; the index and the semantic
 * tokens count the header's style and type once, not once per row.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { buildStructure, makeRowKeyIdPart, StructNode } from '../src/core/structure';
import { formatDui, tokenSignature } from '../src/core/format';
import { summarizeFile } from '../src/core/workspaceIndex';

const TABLE = [
    'VerticalBox Page {',                                   // 1
    '    Text Header {}',                                   // 2
    '    rows Text : Caption (Text, FontSize) {',           // 3
    '        "City Ruins",  24',                            // 4
    '        "Desert Zone", 18 { HAlign = Right }',         // 5
    '        // a comment between rows',                   // 6
    '        "Forest Zone", 20; "Factory", 22',             // 7
    '    }',                                                // 8
    '    Text Footer {}',                                   // 9
    '}',                                                    // 10
    'style Caption { FontSize = 12 }',
].join('\n');

test('a table reads into one unnamed child per line, between its siblings, named from each first value', () => {
    const structure = buildStructure(TABLE);
    assert.deepEqual(structure.diagnostics, []);
    const children = structure.roots[0].children;
    assert.deepEqual(children.map((child) => child.id), [
        'Header', 'Page__Text_City_Ruins', 'Page__Text_Desert_Zone', 'Page__Text_Forest_Zone', 'Page__Text_Factory', 'Footer',
    ]);
    const rows = children.slice(1, 5);
    for (const row of rows) {
        assert.equal(row.kind, 'node');
        assert.equal(row.tag, 'Text');
        assert.equal(row.styleName, 'Caption');
        assert.equal(row.anonymous, true);
        assert.equal(row.styleNameStart, undefined, 'the style clause is the header\'s, written once');
    }
    assert.deepEqual(rows.map((row) => row.rowKey), ['City Ruins', 'Desert Zone', 'Forest Zone', 'Factory']);
    assert.deepEqual(rows.map((row) => row.line), [4, 5, 7, 7]);

    const cells = rows[1].properties.filter((property) => property.isRowCell);
    assert.deepEqual(cells.map((cell) => cell.path), ['Text', 'FontSize']);
    assert.equal(TABLE.slice(cells[1].valueStart, cells[1].valueEnd), '18');
    assert.ok(rows[1].properties.some((property) => property.path === 'HAlign' && !property.isRowCell),
        'the block at the end of a line is that row\'s own');

    const table = structure.rowsTables![0];
    assert.equal(table.tag, 'Text');
    assert.equal(TABLE.slice(table.tagStart, table.tagEnd), 'Text');
    assert.equal(table.styleName, 'Caption');
    assert.deepEqual(table.columns.map((column) => column.name), ['Text', 'FontSize']);
    assert.ok(structure.scopes.some((scope) => scope.kind === 'rows'));
});

test("a row's id is the compiler's: the key cleaned, cut to 32, bumped and warned when taken, counted when empty", () => {
    assert.equal(makeRowKeyIdPart('  W S / Up -- Down!  '), 'W_S_Up_Down');
    assert.equal(makeRowKeyIdPart('A very long first value that goes on and on and on'), 'A_very_long_first_value_that_goe');
    assert.equal(makeRowKeyIdPart('!!'), '');

    const ids = (rows: string[]): { ids: string[]; codes: number[] } => {
        const source = ['Widget Root {', '    rows Text (Text) {', ...rows.map((row) => `        ${row}`), '    }', '    Text {}', '}'].join('\n');
        const structure = buildStructure(source);
        return {
            ids: structure.roots[0].children.map((child: StructNode) => child.id),
            codes: structure.diagnostics.map((diagnostic) => diagnostic.code),
        };
    };
    assert.deepEqual(ids(['"Save"', '"Load"']).ids, ['Root__Text_Save', 'Root__Text_Load', 'Root__Text0']);
    assert.deepEqual(ids(['"New Game"', '"Save"', '"Load"']).ids.slice(1, 3), ['Root__Text_Save', 'Root__Text_Load'],
        'an inserted row moves no other row\'s id');

    const twice = ids(['"Exit"', '"Exit"']);
    assert.deepEqual(twice.ids, ['Root__Text_Exit', 'Root__Text_Exit_1', 'Root__Text0']);
    assert.deepEqual(twice.codes, [3023]);

    assert.deepEqual(ids(['(1, 2)', '"!!"']).ids, ['Root__Text_1_2', 'Root__Text0', 'Root__Text1']);
});

test('a table that does not read is DUI2020, and a row that does not read makes no widget', () => {
    const verdict = (lines: string[]): { codes: number[]; lines: number[]; rows: number } => {
        const structure = buildStructure(['Widget Root {', ...lines, '}'].join('\n'));
        return {
            codes: structure.diagnostics.map((diagnostic) => diagnostic.code),
            lines: structure.diagnostics.map((diagnostic) => diagnostic.line),
            rows: structure.roots[0].children.length,
        };
    };
    assert.deepEqual(verdict(['    rows Text (Text, FontSize) {', '        "A", 12', '        "B"', '    }']),
        { codes: [2020], lines: [4], rows: 1 });
    assert.deepEqual(verdict(['    rows Text (Text) {', '        "A", 12', '        "B"', '    }']),
        { codes: [2020], lines: [3], rows: 1 });
    assert.deepEqual(verdict(['    rows Text (Text, text) {', '        "A", "B"', '    }']),
        { codes: [2020], lines: [2], rows: 1 });
    assert.deepEqual(verdict(['    rows Text (Text, 12) {', '        "A", "B"', '    }', '    Text After {}']),
        { codes: [2020], lines: [2], rows: 1 });
    // A missing comma is the compiler's DUI2001 to word; the mirror says nothing, and makes no widget of the line.
    assert.deepEqual(verdict(['    rows Text (Text, FontSize) {', '        "A" 12', '        "B", 14', '    }']),
        { codes: [], lines: [], rows: 1 });
});

test('rows is a keyword only before a type and a column list', () => {
    const structure = buildStructure([
        'Widget Root {',
        '    rows = 3',
        '    rows Grid { }',
        '    rows : Card { }',
        '}',
        'style Card { }',
    ].join('\n'));
    assert.deepEqual(structure.diagnostics, []);
    assert.ok(structure.roots[0].properties.some((property) => property.path === 'rows'));
    assert.deepEqual(structure.roots[0].children.map((child) => [child.tag, child.rowKey]), [['rows', undefined], ['rows', undefined]]);
    assert.deepEqual(structure.rowsTables, []);
});

test("an unknown style on a table is said once, at the header", () => {
    const structure = buildStructure([
        'Widget Root {',
        '    rows Text : Missing (Text) {',
        '        "A"',
        '        "B"',
        '    }',
        '}',
    ].join('\n'));
    assert.deepEqual(structure.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.line]), [[3004, 2]]);
});

test("the index counts a table's style once, and keeps its rows as unnamed nodes", () => {
    const summary = summarizeFile('/w/Rows.dui', TABLE);
    assert.equal(summary.styleUses.filter((use) => use.name === 'Caption').length, 1);
    assert.ok(summary.nodes.some((node) => node.id === 'Page__Text_Factory' && node.anonymous));
});

test('the formatter keeps a table a table, and is a fixed point on one', () => {
    const SPACES = { indent: '    ', eol: '\n' } as const;
    const once = formatDui(TABLE, SPACES);
    assert.deepEqual(tokenSignature(once), tokenSignature(TABLE));
    assert.equal(formatDui(once, SPACES), once);
    assert.ok(once.includes('rows Text : Caption (Text, FontSize) {'));
    assert.ok(/\n {8}"City Ruins", {1,2}24\n/.test(once), 'a row stays one line, at the block\'s indent');
});

test('the real NieR screens, where present, read with no diagnostics and their tables expand', () => {
    const nier = path.join('C:', 'Users', '10678', 'Documents', 'Unreal Projects', '58', 'DevProject', 'DUI', 'UITests', 'NieR', 'NieR_Menu.dui');
    if (!fs.existsSync(nier)) {
        return;
    }
    // Read alone: the styles it borrows from NieR_Common.dui are the index's to resolve (the corpus sweep does that),
    // so DUI3004 is all one file may say about it.
    const structure = buildStructure(fs.readFileSync(nier, 'utf8'));
    assert.deepEqual(structure.diagnostics.filter((diagnostic) => diagnostic.code !== 3004), []);
    assert.ok((structure.rowsTables ?? []).length >= 7);
});
