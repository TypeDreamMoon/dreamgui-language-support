/**
 * The bundled code table: complete over the compiler's whole table, and over everything this
 * extension raises itself, so compiler diagnostics arriving through the mailbox explain themselves
 * for free.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CODE_EXPLANATIONS, explainCode } from '../src/core/codes';
import { LOCALLY_RAISED } from '../src/core/mailbox';

/** Every number in [first, last]. */
function range(first: number, last: number): number[] {
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/**
 * The compiler's whole table (EDreamUIDiagnosticCode in DreamUIDiagnostics.h, and the table in the
 * plugin's Docs/DuiLanguage.md), by hand, less DUI3007 -- retired, never raised, kept only so the
 * number is not reused.
 *
 * Listed by hand rather than derived, because the whole point is to notice when the compiler grows
 * one: a code with no entry arrives in Problems as a number and nothing else. It used to be the
 * compiler-only half, with the locally raised half taken from the mailbox; the whole table is the
 * steadier list, because a code moving from one half to the other -- the mirror learning to raise
 * DUI3016 -- does not change whether the compiler can send it.
 */
const COMPILER_TABLE: number[] = [
    ...range(1001, 1007),
    ...range(2001, 2019),
    ...range(3001, 3006), ...range(3008, 3022),
    ...range(4001, 4008),
    ...range(5001, 5022),
    ...range(6001, 6014),
    ...range(7001, 7005),
];

test('every code the extension raises has an explanation', () => {
    for (const code of LOCALLY_RAISED) {
        assert.ok(CODE_EXPLANATIONS[code], `DUI${code} raised but unexplained`);
    }
});

test('every code the extension raises is one the compiler has -- the mirror invents no numbers', () => {
    const compiler = new Set(COMPILER_TABLE);
    for (const code of LOCALLY_RAISED) {
        assert.ok(compiler.has(code), `DUI${code} is raised locally but is not in the compiler's table`);
    }
});

test('every entry is whole: title, explanation, fix', () => {
    for (const [code, entry] of Object.entries(CODE_EXPLANATIONS)) {
        assert.ok(entry.title.length > 0, `DUI${code} has no title`);
        assert.ok(entry.explain.length > 10, `DUI${code} has no explanation`);
        assert.ok(entry.fix.length > 5, `DUI${code} has no fix`);
    }
});

test('every code the compiler can send explains itself', () => {
    for (const code of COMPILER_TABLE) {
        assert.ok(CODE_EXPLANATIONS[code], `DUI${code} can arrive from the compiler but is unexplained`);
    }
});

test('the table holds nothing but the compiler\'s codes -- no invented numbers, no retired ones', () => {
    const known = new Set(COMPILER_TABLE);
    for (const code of Object.keys(CODE_EXPLANATIONS)) {
        assert.ok(known.has(Number(code)), `DUI${code} is explained but nothing can raise it`);
    }
    assert.equal(CODE_EXPLANATIONS[3007], undefined, 'DUI3007 is retired: two slots of one name are DUI3001');
});

/**
 * The codes the component syntax brought, each held to naming the construct it is about -- a cheap
 * guard against an entry pasted under the wrong number, which the completeness tests cannot see.
 */
test('the new language codes each name their construct', () => {
    const expected: [number, string][] = [
        [2014, 'timeline'],
        [2015, 'as'],
        [2016, 'props'],
        [2017, 'events'],
        [2018, 'if'],
        [2019, 'slot'],
        [3017, 'use'],
        [3018, 'VerticalBox'],
        [3019, 'props'],
        [3021, 'use'],
        [3022, 'default'],
        [5018, 'class'],
        [5019, 'slot'],
        [5021, 'for'],
        [5022, '+'],
        [6008, 'Enum'],
        [6010, 'emit'],
        [6012, 'emit'],
        [7004, '@fill'],
        [7005, '+'],
    ];
    for (const [code, word] of expected) {
        const entry = CODE_EXPLANATIONS[code];
        const text = `${entry.title} ${entry.explain} ${entry.fix}`;
        assert.ok(text.includes(word), `DUI${code} never mentions ${word}`);
    }
});

/**
 * Entries whose meaning moved with the language: `for` landed, so DUI5007 stopped meaning "not
 * implemented yet"; nodes may go unnamed, so DUI2004 stopped saying every node needs an id.
 */
test('the entries whose meaning moved say what they mean now', () => {
    assert.doesNotMatch(CODE_EXPLANATIONS[5007].explain, /尚未实现/);
    assert.match(CODE_EXPLANATIONS[5007].explain, /调用方/);
    assert.doesNotMatch(CODE_EXPLANATIONS[2004].explain, /每个节点都必须命名/);
    assert.match(CODE_EXPLANATIONS[2004].explain, /HorizontalBox \{/);
    assert.doesNotMatch(CODE_EXPLANATIONS[3009].explain, /循环嵌套也落在这里/);
    assert.match(CODE_EXPLANATIONS[3002].explain, /timeline/);
});

test('explainCode renders markdown with the code in its heading', () => {
    const markdown = explainCode(3001)!;
    assert.match(markdown, /^# DUI3001/);
    assert.match(markdown, /怎么修/);
    assert.equal(explainCode(9999), undefined);
});
