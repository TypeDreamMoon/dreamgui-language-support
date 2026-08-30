/**
 * The starter file: it must come through the whole front end clean, carry the shape the editor
 * side writes, and actually render something (a root and one centred label).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import { duiStarter } from '../src/core/templates';

test('the starter parses without a single diagnostic', () => {
    const built = buildStructure(duiStarter('NewPanel.dui', '/Game/UI/WBP_NewPanel', 'NewPanel'));
    assert.deepEqual(built.lexical, []);
    assert.deepEqual(built.diagnostics, []);
});

test('the starter renders something: a root, an overlay, a centred label', () => {
    const built = buildStructure(duiStarter('NewPanel.dui', '/Game/UI/WBP_NewPanel', 'NewPanel'));
    assert.equal(built.classPath?.path, '/Game/UI/WBP_NewPanel');
    assert.equal(built.roots.length, 1);
    const root = built.roots[0];
    assert.equal(root.id, 'Root');
    assert.deepEqual(root.components.map((c) => c.name), ['Overlay']);
    assert.deepEqual(root.children.map((c) => c.id), ['Title']);
});

test('a CJK name survives the trip', () => {
    const built = buildStructure(duiStarter('设置面板.dui', '/Game/UI/WBP_设置面板', '设置面板'));
    assert.deepEqual(built.lexical, []);
    assert.deepEqual(built.diagnostics, []);
});
