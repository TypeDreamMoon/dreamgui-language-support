/**
 * Which installed extensions are stale copies of this one, left under the id it had up to 0.9.1.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { OWN_ID, staleCopies } from '../src/core/oldCopies';

test('the old id is a stale copy, whoever the publisher is', () => {
    assert.deepEqual(staleCopies(['typedreammoon.dreamui-language-support']), ['typedreammoon.dreamui-language-support']);
    assert.deepEqual(staleCopies(['someone.dreamui-language-support']), ['someone.dreamui-language-support']);
});

test('this extension\'s own id is never one, nor are other extensions', () => {
    assert.equal(OWN_ID, 'typedreammoon.dreamgui-language-support');
    assert.deepEqual(staleCopies([OWN_ID, 'ms-vscode.cpptools', 'typedreammoon.other-thing', 'dreamui-language-support-x.pack']), []);
    assert.deepEqual(staleCopies([]), []);
});

test('both installed: only the old one is named, with the case it came in, once', () => {
    assert.deepEqual(
        staleCopies([OWN_ID, 'TypeDreamMoon.DreamUI-Language-Support', 'typedreammoon.dreamui-language-support']),
        ['TypeDreamMoon.DreamUI-Language-Support']);
});

test('an id compares to the own id without regard to case', () => {
    assert.deepEqual(staleCopies(['TypeDreamMoon.DreamGUI-Language-Support']), []);
    assert.deepEqual(staleCopies(['pub.dreamui-language-support'], 'pub.dreamui-language-support'), []);
});
