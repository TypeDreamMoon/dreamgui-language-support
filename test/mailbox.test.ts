/**
 * The mailbox contract: what parseMailbox accepts is what the C++ writer conforms to, so these
 * tests ARE the format spec. Malformed input degrades to undefined (the reader keeps its last
 * good copy), and the suppressed codes are filtered so one fact never wears two squiggles --
 * suppression being a strict subset of what the mirror raises, and only where the mirror judges
 * from the same inputs the compiler does.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseMailbox, mailboxDiagnosticsToShow, LOCALLY_RAISED, MAILBOX_SUPPRESSED } from '../src/core/mailbox';

const GOOD = JSON.stringify({
    version: 1,
    files: {
        'I:/proj/DUI/Panel.dui': {
            compiledAt: '2026-08-30T12:00:00Z',
            diagnostics: [
                { code: 5004, severity: 'error', line: 12, column: 5, message: "no function named 'GetTitle'" },
                { code: 3001, severity: 'error', line: 3, column: 10, message: 'duplicate id' },
                { code: 6003, severity: 'warning', line: 1, column: 7, message: 'class mismatch' },
            ],
        },
        'I:/proj/DUI/Clean.dui': { compiledAt: '2026-08-30T12:00:01Z', diagnostics: [] },
    },
});

test('a well-formed mailbox parses whole', () => {
    const mailbox = parseMailbox(GOOD)!;
    assert.equal(mailbox.version, 1);
    assert.equal(Object.keys(mailbox.files).length, 2);
    assert.equal(mailbox.files['I:/proj/DUI/Panel.dui'].diagnostics.length, 3);
    assert.deepEqual(mailbox.files['I:/proj/DUI/Clean.dui'].diagnostics, []);
});

test('a clean file arrives with an empty array -- absence means no news, not no problems', () => {
    const mailbox = parseMailbox(GOOD)!;
    assert.ok('I:/proj/DUI/Clean.dui' in mailbox.files);
});

test('suppressed codes are filtered; compiler-only codes stay', () => {
    const mailbox = parseMailbox(GOOD)!;
    const shown = mailboxDiagnosticsToShow(mailbox.files['I:/proj/DUI/Panel.dui']);
    assert.deepEqual(shown.map((d) => d.code), [5004, 6003]);
    assert.ok(MAILBOX_SUPPRESSED.has(3001));
});

test('suppression is a subset of what is raised locally, never the other way round', () => {
    for (const code of MAILBOX_SUPPRESSED) {
        assert.ok(LOCALLY_RAISED.has(code), `DUI${code} is filtered out but nothing raises it locally`);
    }
});

test('the codes the mirror judges more narrowly than the compiler are NOT filtered', () => {
    // DUI1006 reads the unsaved buffer where the compiler read the file on disk; DUI2013's local
    // depth budget is spent on blocks only. Filtering either would throw away a real refusal.
    for (const code of [1006, 2013]) {
        assert.ok(LOCALLY_RAISED.has(code), `DUI${code} should be raised locally`);
        assert.ok(!MAILBOX_SUPPRESSED.has(code), `DUI${code} must reach Problems from the compiler too`);
    }
});

test('the rename-clause errors reach Problems now that the compiler raises them', () => {
    // DUI3010/3011/3012 had no raise site in the compiler when this filter was written; they do
    // now, as errors that fail the compile, and the mirror only ever warned.
    const entry = parseMailbox(JSON.stringify({
        version: 1,
        files: {
            'x.dui': {
                diagnostics: [
                    { code: 3010, severity: 'error', line: 4, column: 5, message: 'still a live id' },
                    { code: 3011, severity: 'error', line: 6, column: 5, message: 'two claims' },
                    { code: 3012, severity: 'error', line: 8, column: 5, message: 'names itself' },
                    { code: 3013, severity: 'warning', line: 4, column: 5, message: 'graph ambiguous' },
                ],
            },
        },
    }))!.files['x.dui'];
    assert.deepEqual(mailboxDiagnosticsToShow(entry).map((d) => d.code), [3010, 3011, 3012, 3013]);
});

test('the codes added on 2026-09-04 pass straight through', () => {
    const entry = parseMailbox(JSON.stringify({
        version: 1,
        files: {
            'x.dui': {
                diagnostics: [
                    { code: 5014, severity: 'error', line: 12, column: 9, message: 'loop body binding' },
                    // 6004/6005 have no source line: the handler lives in the graph, and the
                    // writer clamps a location-less refusal to 1,1 rather than 0,0.
                    { code: 6004, severity: 'error', line: 1, column: 1, message: 'no such function' },
                    { code: 6005, severity: 'error', line: 1, column: 1, message: 'wrong shape' },
                ],
            },
        },
    }))!.files['x.dui'];
    assert.deepEqual(mailboxDiagnosticsToShow(entry).map((d) => d.code), [5014, 6004, 6005]);
});

test('malformed input degrades to undefined, never throws', () => {
    assert.equal(parseMailbox('not json'), undefined);
    assert.equal(parseMailbox('{}'), undefined);
    assert.equal(parseMailbox('{"version": 2, "files": {}}'), undefined);
    assert.equal(parseMailbox('null'), undefined);
});

test('a malformed diagnostic inside an entry is dropped, its siblings kept', () => {
    const mailbox = parseMailbox(JSON.stringify({
        version: 1,
        files: {
            'x.dui': {
                diagnostics: [
                    { code: 5001, severity: 'error', line: 1, column: 1, message: 'ok' },
                    { code: 'not-a-number', severity: 'error', line: 1, column: 1, message: 'bad' },
                    { code: 5002, severity: 'mild' },
                ],
            },
        },
    }))!;
    assert.deepEqual(mailbox.files['x.dui'].diagnostics.map((d) => d.code), [5001]);
});
