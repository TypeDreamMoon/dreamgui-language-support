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

// ---- a node with no id: naming it writes its first id, and no (was:) ---------------------------

const UNNAMED = 'style Caption {\n    FontSize = 12\n}\n\nWidget Root {\n    HorizontalBox {\n        Spacing = 14\n'
    + '        Text : Caption {\n            Text = "Status"\n        }\n    }\n}\n';

test('naming an unnamed node writes the id after its type, as the designer does', () => {
    const renamed = rename(UNNAMED, UNNAMED.indexOf('HorizontalBox') + 2, 'StatusRow');
    assert.ok(renamed.includes('    HorizontalBox StatusRow {'));
    assert.ok(!renamed.includes('was:'));
    const built = buildStructure(renamed);
    assert.deepEqual(built.diagnostics, []);
    const box = built.roots[0].children[0];
    assert.equal(box.id, 'StatusRow');
    assert.ok(!box.anonymous);
});

test('an unnamed node with a style clause gets its id between the type and the clause', () => {
    const renamed = rename(UNNAMED, UNNAMED.indexOf('Text :') + 1, 'StatusLabel');
    assert.ok(renamed.includes('        Text StatusLabel : Caption {'));
    assert.deepEqual(buildStructure(renamed).diagnostics, []);
});

test('the F2 placeholder of an unnamed node is the id it compiles to', () => {
    const target = renameTargetAt(buildStructure(UNNAMED), UNNAMED.indexOf('HorizontalBox'))!;
    assert.equal(target.kind, 'anonymousNode');
    assert.equal(target.name, 'Root__HorizontalBox0');
});

test('naming an unnamed node refuses an id already in the file', () => {
    const source = 'Widget Root {\n    Text Taken {}\n    HorizontalBox {\n        Text A {}\n    }\n}\n';
    assert.match(renameError(source, source.indexOf('HorizontalBox'), 'taken'), /已经是/);
});

// ---- aliases and namespaces ------------------------------------------------------------------

test('an alias renames its use line and every node typed by it, from either end', () => {
    const source = 'use "UI/Row.dui" as Row\n\nWidget Root {\n    Row A {}\n    Row { Label = "x" }\n    Text Row2 {}\n}\n';
    for (const at of [source.indexOf('as Row') + 4, source.indexOf('Row A')]) {
        const renamed = rename(source, at, 'Line');
        assert.ok(renamed.includes('use "UI/Row.dui" as Line'));
        assert.ok(renamed.includes('    Line A {}'));
        assert.ok(renamed.includes('    Line { Label = "x" }'));
        // An id that merely starts with the alias is not the alias.
        assert.ok(renamed.includes('Text Row2 {}'));
    }
});

test('a namespace renames every prefix it qualifies: types, style clauses, resources', () => {
    const source = 'use "UI/Lib.dui" as ui\n\nWidget Root : ui.Card {\n    ui.Row A {\n        Color = @ui.Ink\n    }\n}\n';
    const renamed = rename(source, source.indexOf('ui.Row'), 'kit');
    assert.equal(renamed,
        'use "UI/Lib.dui" as kit\n\nWidget Root : kit.Card {\n    kit.Row A {\n        Color = @kit.Ink\n    }\n}\n');
});

test('the tail of a namespaced name is the library\'s, and is no rename target here', () => {
    const source = 'use "UI/Lib.dui" as ui\n\nWidget Root : ui.Card {\n}\n';
    assert.equal(renameTargetAt(buildStructure(source), source.indexOf('Card') + 1), undefined);
});

test('an alias may not take a tag\'s or a container\'s name, nor another alias\'s', () => {
    const source = 'use "UI/Row.dui" as Row\nuse "UI/Tab.dui" as Tab\n\nWidget Root {\n    Row A {}\n}\n';
    const at = source.indexOf('as Row') + 4;
    assert.match(renameError(source, at, 'Text'), /DUI3018/);
    assert.match(renameError(source, at, 'VerticalBox'), /DUI3018/);
    assert.match(renameError(source, at, 'tab'), /DUI3017/);
});

// ---- props and events ------------------------------------------------------------------------

const COMPONENT = 'props {\n    Text Label\n    Number Index = 0\n}\nevents {\n    Picked(Number Index)\n}\n\n'
    + 'Widget Root {\n    Text A { Text <- Label }\n    Native.Button B { OnClicked -> emit Picked(Index) }\n'
    + '    for Label in Items {\n        Text C { Text <- Label.Name }\n    }\n}\n';

test('a prop renames its entry and every binding that reads it -- not a loop variable of its name', () => {
    for (const at of [COMPONENT.indexOf('Label'), COMPONENT.indexOf('<- Label') + 4]) {
        const renamed = rename(COMPONENT, at, 'Caption');
        assert.ok(renamed.includes('    Text Caption\n'));
        assert.ok(renamed.includes('Text A { Text <- Caption }'));
        assert.ok(renamed.includes('for Label in Items'));
        assert.ok(renamed.includes('Text <- Label.Name'));
    }
});

test('a prop read as an emit argument renames with it', () => {
    const renamed = rename(COMPONENT, COMPONENT.indexOf('Number Index') + 8, 'Position');
    assert.ok(renamed.includes('    Number Position = 0'));
    assert.ok(renamed.includes('emit Picked(Position)'));
    // The event's parameter is the event's own name for it, and stays.
    assert.ok(renamed.includes('Picked(Number Index)'));
});

test('an event renames its entry and every emit of it, from either end', () => {
    for (const at of [COMPONENT.indexOf('Picked('), COMPONENT.indexOf('emit Picked') + 6]) {
        const renamed = rename(COMPONENT, at, 'Chosen');
        assert.ok(renamed.includes('    Chosen(Number Index)'));
        assert.ok(renamed.includes('OnClicked -> emit Chosen(Index)'));
        // The left of the arrow is the button's event, not this file's.
        assert.ok(renamed.includes('OnClicked'));
    }
});

test('props, events and ids share the class: a rename into another member is refused', () => {
    assert.match(renameError(COMPONENT, COMPONENT.indexOf('Label'), 'B'), /已经是/);
    assert.match(renameError(COMPONENT, COMPONENT.indexOf('Label'), 'picked'), /event/);
    assert.match(renameError(COMPONENT, COMPONENT.indexOf('Picked('), 'Index'), /prop/);
});

test('a slot fill names the component\'s slot, and is refused with the reason', () => {
    const source = 'use "UI/ListPage.dui" as ListPage\n\nWidget Root {\n    ListPage P {\n        slot Detail {\n'
        + '            Text N {}\n        }\n    }\n}\n';
    const structure = buildStructure(source);
    const target = renameTargetAt(structure, source.indexOf('Detail') + 1)!;
    assert.equal(target.kind, 'slotFill');
    const plan = planRename(structure, target, 'Info');
    assert.ok('error' in plan && /组件/.test(plan.error));
});
