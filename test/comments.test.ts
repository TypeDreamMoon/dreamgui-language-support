/**
 * Comment spans out of the scanner: folding needs where comments were, which the token stream by
 * design does not carry.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scan } from '../src/core/scanner';
import { buildStructure } from '../src/core/structure';
import { formatDui } from '../src/core/format';

test('line and block comments report their spans and lines', () => {
    const source = '// one\nWidget Root { // trailing\n/* two\nlines */\n}\n';
    const comments = scan(source).comments.map((c) => ({
        kind: c.kind, line: c.line, endLine: c.endLine, text: source.slice(c.start, c.end),
    }));
    assert.deepEqual(comments, [
        { kind: 'line', line: 1, endLine: 1, text: '// one' },
        { kind: 'line', line: 2, endLine: 2, text: '// trailing' },
        { kind: 'block', line: 3, endLine: 4, text: '/* two\nlines */' },
    ]);
});

test('an unterminated block comment still reports its span to end of file', () => {
    const result = scan('/* forever\nand ever');
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].endLine, 2);
    assert.deepEqual(result.diagnostics.map((d) => d.code), [1003]);
});

test('a comment between an if block and its else does not end the chain', () => {
    // The chain looks past the line breaks after a '}' for an `else`; a comment there is a line break with words in it.
    const source = 'Widget Root {\n    if Ready() {\n        Text A { }\n    } // ready\n    /* otherwise */\n    else {\n        Text B { }\n    }\n}\n';
    const built = buildStructure(source);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.roots[0].children.map((c) => c.tag), ['if', 'else']);
    assert.deepEqual(built.comments.map((c) => source.slice(c.start, c.end)), ['// ready', '/* otherwise */']);
});

test('a comment inside a one-line block keeps the formatter from folding the block onto the line', () => {
    assert.equal(formatDui('Widget Root {\n    Text A { /* why */ Text = "x" }\n}\n', { indent: '    ', eol: '\n' }),
        'Widget Root {\n    Text A { /* why */\n        Text = "x"\n    }\n}\n');
});
