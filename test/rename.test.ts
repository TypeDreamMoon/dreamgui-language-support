/**
 * Rename plans, verified by applying them: the result re-parses clean and carries exactly the
 * change asked for. The id cases are the ones that matter -- the (was:) machinery is the
 * language's own migration syntax wired to F2.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import { renameTargetAt, planRename, applyRenameEdits, RenamePlan } from '../src/core/rename';

function rename(source: string, at: number, newName: string): string {
    const structure = buildStructure(source);
    const target = renameTargetAt(structure, at)!;
    assert.ok(target, 'no rename target at that offset');
    const plan = planRename(structure, target, newName);
    assert.ok(!('error' in plan), 'error' in plan ? (plan as { error: string }).error : '');
    return applyRenameEdits(source, (plan as RenamePlan).edits);
}

function renameError(source: string, at: number, newName: string): string {
    const structure = buildStructure(source);
    const target = renameTargetAt(structure, at)!;
    const plan = planRename(structure, target, newName);
    assert.ok('error' in plan, 'expected an error');
    return (plan as { error: string }).error;
}

// ---- ids and the (was:) machinery --------------------------------------------------------------

test('renaming an id with no (was:) writes one naming the old id', () => {
    const source = 'Widget Root {\n    Text Title : Label {}\n}\nstyle Label {\n}\n';
    const renamed = rename(source, source.indexOf('Title') + 1, 'Heading');
    assert.ok(renamed.includes('Text Heading (was: Title) : Label {'));
    const built = buildStructure(renamed);
    assert.deepEqual(built.diagnostics, []);
    assert.equal(built.roots[0].children[0].id, 'Heading');
    assert.equal(built.roots[0].children[0].wasId, 'Title');
});

test('renaming an id that already carries (was:) keeps the clause: it names the last compiled id', () => {
    const source = 'Widget Root {\n    Text Heading (was: Title) {}\n}\n';
    const renamed = rename(source, source.indexOf('Heading') + 1, 'Caption');
    assert.ok(renamed.includes('Text Caption (was: Title) {'));
});

test('renaming back to the old id removes the clause: the migration cancels itself', () => {
    const source = 'Widget Root {\n    Text Heading (was: Title) {}\n}\n';
    const renamed = rename(source, source.indexOf('Heading') + 1, 'Title');
    assert.ok(renamed.includes('Text Title {'));
    assert.ok(!renamed.includes('was:'));
    assert.deepEqual(buildStructure(renamed).diagnostics, []);
});

test('an id rename flags the localization consequence; style and resource renames do not', () => {
    const source = 'Widget Root {\n    Text Title {}\n}\nstyle Label {\n}\n';
    const structure = buildStructure(source);
    const idPlan = planRename(structure,
        renameTargetAt(structure, source.indexOf('Title') + 1)!, 'Heading') as RenamePlan;
    assert.equal(idPlan.localizationKeysChange, true);
    const stylePlan = planRename(structure,
        renameTargetAt(structure, source.indexOf('Label') + 1)!, 'Tag') as RenamePlan;
    assert.equal(stylePlan.localizationKeysChange, false);
});

test('an id rename refuses a name another node holds, case-insensitively', () => {
    const source = 'Widget Root {\n    Text A {}\n    Text B {}\n}\n';
    assert.match(renameError(source, source.indexOf('A {'), 'b'), /已经是/);
});

// ---- styles ------------------------------------------------------------------------------------

test('a style rename reaches the declaration, every wearing site and every base clause', () => {
    const source = 'style Label {\n}\nstyle Danger : Label {\n}\nWidget Root {\n    Text A : Label {}\n    Text B : label {}\n}\n';
    const renamed = rename(source, source.indexOf('Label'), 'Tag');
    assert.deepEqual(buildStructure(renamed).diagnostics, []);
    assert.ok(renamed.includes('style Tag {'));
    assert.ok(renamed.includes('style Danger : Tag {'));
    assert.ok(renamed.includes('Text A : Tag {'));
    // The differently-cased wearing site renames too -- names are one namespace.
    assert.ok(renamed.includes('Text B : Tag {'));
});

test('a style rename works from a wearing site as well as the declaration', () => {
    const source = 'style Label {\n}\nWidget Root {\n    Text A : Label {}\n}\n';
    const renamed = rename(source, source.lastIndexOf('Label'), 'Tag');
    assert.ok(renamed.includes('style Tag {'));
    assert.ok(renamed.includes(': Tag {'));
});

// ---- resources ---------------------------------------------------------------------------------

test('a resource rename reaches the declaration and every @use, keeping the @', () => {
    const source = 'resources {\n    Color Accent = #F00\n}\nWidget Root {\n    A = @Accent\n    B = @accent\n}\n';
    const renamed = rename(source, source.indexOf('Accent'), 'Primary');
    assert.deepEqual(buildStructure(renamed).diagnostics, []);
    assert.ok(renamed.includes('Color Primary = #F00'));
    assert.equal((renamed.match(/@Primary/g) ?? []).length, 2);
});

// ---- validation --------------------------------------------------------------------------------

test('invalid new names are refused with a reason', () => {
    const source = 'Widget Root {\n    Text Title {}\n}\n';
    const at = source.indexOf('Title') + 1;
    assert.match(renameError(source, at, 'style'), /关键字/);
    assert.match(renameError(source, at, '2nd'), /数字开头/);
    assert.match(renameError(source, at, 'a b'), /不能出现/);
    assert.match(renameError(source, at, 'Title'), /相同/);
    assert.match(renameError(source, at, 'title'), /大小写/);
});

test('a loop variable renames as itself alone, and CJK names are fine', () => {
    const source = 'Widget Root {\n    for Row in GetRows() {\n        Text A {}\n    }\n}\n';
    const renamed = rename(source, source.indexOf('Row') + 1, '行');
    assert.ok(renamed.includes('for 行 in GetRows() {'));
    assert.ok(!renamed.includes('was:'));
});

test('there is no rename target in a comment or a value', () => {
    const source = 'Widget Root {\n    FontSize = 18 // Title\n}\n';
    const structure = buildStructure(source);
    assert.equal(renameTargetAt(structure, source.indexOf('18')), undefined);
    assert.equal(renameTargetAt(structure, source.indexOf('// Title') + 4), undefined);
});
