/**
 * Lists and maps -- `[a, b]` for an array or a set, `{ key: value }` for a map -- read, said wrong, and laid out.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scan } from '../src/core/scanner';
import { buildStructure } from '../src/core/structure';
import { formatDui } from '../src/core/format';

const SPACES = { indent: '    ', eol: '\n' } as const;

const SOURCE = [
    'Widget Root {',
    '    + UIButton {',
    '        Names = ["Alpha", "Beta"]',
    '        Colors = { Hover: #FFCC00, Pressed: #AA8800 }',
    '        Sizes = [',
    '            (1, 2),',
    '            (3, 4),',
    '        ]',
    '        Empty = []',
    '        None = {}',
    '    }',
    '    Text Title { Text = "Hello" }',
    '}',
    '',
].join('\n');

test('a bracket is a token, not a character nothing begins with', () => {
    const scanned = scan('Names = ["A", "B"]');
    assert.deepEqual(scanned.diagnostics, []);
    assert.ok(scanned.tokens.some((token) => token.kind === 'openBracket'));
    assert.ok(scanned.tokens.some((token) => token.kind === 'closeBracket'));
});

test('lists and maps read as values, across lines, and the rest of the file is still read', () => {
    const structure = buildStructure(SOURCE);
    assert.deepEqual([...structure.lexical, ...structure.diagnostics].map((diagnostic) => diagnostic.code), []);
    assert.equal(structure.roots.length, 1);
    assert.ok(structure.roots[0].children.some((child) => child.id === 'Title'), 'the node after the containers is read');
});

test('a list that never closes is DUI2023', () => {
    const structure = buildStructure(['Widget Root {', '    Names = ["A", "B"', '}', ''].join('\n'));
    assert.ok(structure.diagnostics.some((diagnostic) => diagnostic.code === 2023));
});

test('a container is laid out on one line, and a map keeps its spelling', () => {
    const formatted = formatDui(SOURCE, SPACES);
    assert.ok(formatted.includes('        Names = ["Alpha", "Beta"]\n'), formatted);
    assert.ok(formatted.includes('        Colors = { Hover: #FFCC00, Pressed: #AA8800 }\n'), formatted);
    assert.ok(formatted.includes('        Sizes = [(1, 2), (3, 4),]\n'), formatted);
    assert.ok(formatted.includes('        Empty = []\n'), formatted);
    assert.ok(formatted.includes('        None = {}\n'), formatted);
    assert.equal(formatDui(formatted, SPACES), formatted, 'formatting twice changes nothing more');
});
