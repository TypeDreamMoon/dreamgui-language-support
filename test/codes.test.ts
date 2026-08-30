/**
 * The bundled code table: complete over everything this extension can raise, and over the whole
 * compiler table's numbering ranges, so compiler diagnostics arriving later (the mailbox) explain
 * themselves for free.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CODE_EXPLANATIONS, explainCode } from '../src/core/codes';
import { LOCALLY_RAISED } from '../src/core/mailbox';

test('every code the extension raises has an explanation', () => {
    for (const code of LOCALLY_RAISED) {
        assert.ok(CODE_EXPLANATIONS[code], `DUI${code} raised but unexplained`);
    }
});

test('every entry is whole: title, explanation, fix', () => {
    for (const [code, entry] of Object.entries(CODE_EXPLANATIONS)) {
        assert.ok(entry.title.length > 0, `DUI${code} has no title`);
        assert.ok(entry.explain.length > 10, `DUI${code} has no explanation`);
        assert.ok(entry.fix.length > 5, `DUI${code} has no fix`);
    }
});

test('explainCode renders markdown with the code in its heading', () => {
    const markdown = explainCode(3001)!;
    assert.match(markdown, /^# DUI3001/);
    assert.match(markdown, /怎么修/);
    assert.equal(explainCode(9999), undefined);
});
