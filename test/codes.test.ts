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

/**
 * The codes the extension never raises itself but the mailbox delivers. Listed by hand rather than
 * derived, because the whole point is to notice when the compiler grows one: a code with no entry
 * arrives in Problems as a number and nothing else.
 */
const COMPILER_ONLY = [
    2001, 2005, 2007, 2008, 2009, 2010, 2011, 2012,
    3003, 3006, 3009, 3013,
    4001, 4002, 4003, 4004, 4005, 4006, 4008,
    5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009, 5010, 5011, 5012, 5013, 5014,
    6001, 6002, 6003, 6004, 6005, 6006, 6007,
    7001, 7002, 7003,
];

test('every code the compiler can send explains itself too', () => {
    for (const code of COMPILER_ONLY) {
        assert.ok(CODE_EXPLANATIONS[code], `DUI${code} can arrive from the compiler but is unexplained`);
    }
});

test('the table holds nothing but the compiler\'s two halves -- no invented numbers', () => {
    const known = new Set([...LOCALLY_RAISED, ...COMPILER_ONLY]);
    for (const code of Object.keys(CODE_EXPLANATIONS)) {
        assert.ok(known.has(Number(code)), `DUI${code} is explained but nothing can raise it`);
    }
});

test('explainCode renders markdown with the code in its heading', () => {
    const markdown = explainCode(3001)!;
    assert.match(markdown, /^# DUI3001/);
    assert.match(markdown, /怎么修/);
    assert.equal(explainCode(9999), undefined);
});
