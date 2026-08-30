/**
 * Comment spans out of the scanner: folding needs where comments were, which the token stream by
 * design does not carry.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scan } from '../src/core/scanner';

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
