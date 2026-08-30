/**
 * Quickfix plans, verified the only way that matters: apply, re-parse, the target exists, nothing
 * else complained. All plans are pure insertions, so "nothing else changed" is by construction.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import { planDeclareResource, planCreateStyle, applyPlan } from '../src/core/quickfixes';

test('declaring a resource into an existing block', () => {
    const source = 'class /Game/UI/WBP_X\n\nresources {\n    Number Gap = 8\n}\n\nWidget Root {\n    A = @Accent\n}\n';
    const fixed = applyPlan(source, planDeclareResource(buildStructure(source), 'Accent', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.resources.map((r) => r.name), ['Gap', 'Accent']);
    assert.ok(built.resourceRefs.every((ref) =>
        built.resources.some((r) => r.name.toLowerCase() === ref.name.toLowerCase())));
});

test('declaring a resource creates the block after the class line when none exists', () => {
    const source = 'class /Game/UI/WBP_X\n\nWidget Root {\n    A = @Accent\n}\n';
    const fixed = applyPlan(source, planDeclareResource(buildStructure(source), 'Accent', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.resources.map((r) => `${r.type} ${r.name}`), ['Color Accent']);
    assert.ok(fixed.indexOf('resources {') > fixed.indexOf('class '));
    assert.ok(fixed.indexOf('resources {') < fixed.indexOf('Widget Root'));
});

test('declaring a resource with neither block nor class line lands at the top', () => {
    const source = 'Widget Root {\n    A = @Accent\n}\n';
    const fixed = applyPlan(source, planDeclareResource(buildStructure(source), 'Accent', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.equal(built.resources.length, 1);
    assert.equal(built.roots.length, 1);
});

test('creating a style lands after the last style', () => {
    const source = 'style Label {\n    FontSize = 18\n}\n\nWidget Root {\n    Text A : Danger {}\n}\n';
    const fixed = applyPlan(source, planCreateStyle(buildStructure(source), 'Danger', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.styles.map((s) => s.name), ['Label', 'Danger']);
});

test('creating a style with no styles yet lands after the class line', () => {
    const source = 'class /Game/UI/WBP_X\n\nWidget Root {\n    Text A : Danger {}\n}\n';
    const fixed = applyPlan(source, planCreateStyle(buildStructure(source), 'Danger', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.styles.map((s) => s.name), ['Danger']);
    assert.ok(fixed.indexOf('style Danger') < fixed.indexOf('Widget Root'));
});

test('creating a style fixes a broken base clause too', () => {
    const source = 'style A : Missing {\n}\n\nWidget Root {\n    Text T : A {}\n}\n';
    const fixed = applyPlan(source, planCreateStyle(buildStructure(source), 'Missing', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.styles.map((s) => s.name), ['A', 'Missing']);
});
