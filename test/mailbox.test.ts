/**
 * The mailbox contract: what parseMailbox accepts is what the C++ writer conforms to, so these
 * tests ARE the format spec. Malformed input degrades to undefined (the reader keeps its last
 * good copy), and locally-raised codes are filtered so one fact never wears two squiggles.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseMailbox, mailboxDiagnosticsToShow, LOCALLY_RAISED } from '../src/core/mailbox';

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

test('locally-raised codes are filtered; compiler-only codes stay', () => {
    const mailbox = parseMailbox(GOOD)!;
    const shown = mailboxDiagnosticsToShow(mailbox.files['I:/proj/DUI/Panel.dui']);
    assert.deepEqual(shown.map((d) => d.code), [5004, 6003]);
    assert.ok(LOCALLY_RAISED.has(3001));
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
