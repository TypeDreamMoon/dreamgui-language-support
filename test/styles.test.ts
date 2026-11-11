/**
 * More than one style in a clause -- `style Danger : Button : Loud`, `Text Title : Heading : Glow`,
 * `rows Row : ListRow : Dense (Label, Value)` -- read, judged name by name, renamed, coloured and laid out.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import { renameTargetAt, planRename, applyRenameEdits, RenamePlan } from '../src/core/rename';
import { collectSemanticSpans } from '../src/core/semantics';
import { summarizeFile } from '../src/core/workspaceIndex';
import { formatDui } from '../src/core/format';
import { planInlineStyle, wornStyleAt } from '../src/core/refactors';
import { definitionAt } from '../src/core/componentIntel';

const SPACES = { indent: '    ', eol: '\n' } as const;

const SOURCE = [
    'style Heading {',
    '    FontSize = 24',
    '}',
    'style Glow {',
    '    Color = #FFCC00',
    '}',
    'style Strong : Heading : Glow {',
    '    FontSize = 30',
    '}',
    'Widget Root {',
    '    Text Title : Heading : Glow { Text = "Hi" }',
    '    Text : Heading : Strong { Text = "Anon" }',
    '    rows Text : Heading : Glow (Text) {',
    '        "One"',
    '        "Two"',
    '    }',
    '}',
    '',
].join('\n');

const names = (styles: { name: string }[] | undefined): string[] | undefined => styles?.map((style) => style.name);

test('a node, an unnamed node and a style declaration each keep every name of their clause, in order', () => {
    const built = buildStructure(SOURCE);
    assert.deepEqual(built.diagnostics, []);
    const [title, anonymous] = built.roots[0].children;
    assert.deepEqual(names(title.styles), ['Heading', 'Glow']);
    assert.deepEqual(names(anonymous.styles), ['Heading', 'Strong']);
    assert.deepEqual(built.styles.map((style) => names(style.bases)), [[], [], ['Heading', 'Glow']]);
    for (const style of [...title.styles!, ...built.styles[2].bases]) {
        assert.equal(SOURCE.slice(style.start, style.end), style.name);
    }
});

test('a rows header keeps its styles once, and its rows are read as before', () => {
    const built = buildStructure(SOURCE);
    assert.deepEqual(names(built.rowsTables![0].styles), ['Heading', 'Glow']);
    const rows = built.roots[0].children.filter((child) => child.rowKey !== undefined);
    assert.deepEqual(rows.map((row) => row.rowKey), ['One', 'Two']);
});

test('a namespaced name in a later position is still noted for DUI3021', () => {
    const built = buildStructure('use "Lib.dui" as ui\nWidget Root {\n    Text T : Heading : ui.Glow {}\n}\n');
    assert.deepEqual(built.namespaceRefs!.map((ref) => ref.name), ['ui.Glow']);
});

test('a colon with no name after it ends the clause, and the rest of the line is read as before', () => {
    const built = buildStructure('style A {}\nWidget Root {\n    Text T : A : {}\n}\n');
    assert.deepEqual(names(built.roots[0].children[0].styles), ['A']);
    assert.ok(built.roots[0].children[0].bodyStart !== undefined);
});

// ---- the diagnostics, per name -------------------------------------------------------------------

test('DUI3004 is reported at each name that is not declared, and only there', () => {
    const source = 'style A {}\nWidget Root {\n    Text T : A : Missing : Gone {}\n}\n';
    const built = buildStructure(source);
    const missing = built.diagnostics.filter((diagnostic) => diagnostic.code === 3004);
    assert.deepEqual(missing.map((diagnostic) => source.slice(diagnostic.start, diagnostic.end)), ['Missing', 'Gone']);
    assert.deepEqual(missing.map((diagnostic) => diagnostic.message),
        ["'Missing' names a style this file does not declare", "'Gone' names a style this file does not declare"]);
});

test('DUI3004 on a rows header is per name too', () => {
    const source = 'style A {}\nWidget Root {\n    rows Text : A : Nope (Text) { "x" }\n}\n';
    const missing = buildStructure(source).diagnostics.filter((diagnostic) => diagnostic.code === 3004);
    assert.deepEqual(missing.map((diagnostic) => source.slice(diagnostic.start, diagnostic.end)), ['Nope']);
});

test('DUI3004 reaches the second base of a worn style, at the base that is missing', () => {
    const source = 'style Base {}\nstyle D : Base : Gone {}\nWidget Root {\n    Text T : D {}\n}\n';
    const found = buildStructure(source).diagnostics.filter((diagnostic) => diagnostic.code === 3004);
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, 'error');
    assert.equal(source.slice(found[0].start, found[0].end), 'Gone');
    assert.equal(found[0].message, "style 'D' inherits 'Gone', which this file does not declare");
});

test('an unworn style with a second base that is missing is a warning', () => {
    const found = buildStructure('style Base {}\nstyle D : Base : Gone {}\nWidget Root {}\n').diagnostics;
    assert.deepEqual(found.map((diagnostic) => [diagnostic.code, diagnostic.severity]), [[3004, 'warning']]);
});

test('DUI3015 follows every base: a cycle through the second one is a cycle', () => {
    const source = 'style Base {}\nstyle A : Base : B {}\nstyle B : A {}\nWidget Root {\n    Text T : A {}\n}\n';
    const found = buildStructure(source).diagnostics.filter((diagnostic) => diagnostic.code === 3015);
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 5);
});

test('DUI3015 is judged for each worn name, and a diamond is not a cycle', () => {
    const diamond = 'style Base {}\nstyle A : Base {}\nstyle B : Base {}\nWidget Root {\n    Text T : A : B {}\n}\n';
    assert.deepEqual(buildStructure(diamond).diagnostics, []);
    const second = 'style A : B {}\nstyle B : A {}\nstyle Ok {}\nWidget Root {\n    Text T : Ok : A {}\n}\n';
    assert.deepEqual(buildStructure(second).diagnostics.map((diagnostic) => diagnostic.code), [3015]);
});

test('DUI3025 is the compiler\'s to say: the mirror never raises it, for a repeat or a style applied through another', () => {
    const repeated = 'style A {}\nWidget Root {\n    Text T : A : A {}\n}\n';
    const through = 'style A {}\nstyle B : A {}\nWidget Root {\n    Text T : B : A {}\n}\n';
    assert.deepEqual(buildStructure(repeated).diagnostics, []);
    assert.deepEqual(buildStructure(through).diagnostics, []);
});

// ---- the editor features over every name ---------------------------------------------------------

test('renaming a style reaches it in every position of every clause', () => {
    const source = SOURCE;
    const at = source.indexOf('Glow');
    const structure = buildStructure(source);
    const target = renameTargetAt(structure, at)!;
    assert.equal(target.kind, 'style');
    const plan = planRename(structure, target, 'Shine') as RenamePlan;
    const renamed = applyRenameEdits(source, plan.edits);
    assert.deepEqual(buildStructure(renamed).diagnostics, []);
    assert.ok(renamed.includes('style Shine {'));
    assert.ok(renamed.includes('style Strong : Heading : Shine {'));
    assert.ok(renamed.includes('Text Title : Heading : Shine {'));
    assert.ok(renamed.includes('rows Text : Heading : Shine (Text)'));
    assert.ok(!renamed.includes('Glow'));
});

test('the rename target is found on a name that is not the first of its clause', () => {
    const structure = buildStructure(SOURCE);
    const at = SOURCE.indexOf('Glow', SOURCE.indexOf('Text Title'));
    const target = renameTargetAt(structure, at)!;
    assert.deepEqual([target.kind, target.name], ['style', 'Glow']);
});

test('every name of a clause is a class, a declaration included', () => {
    const structure = buildStructure(SOURCE);
    const spans = collectSemanticSpans(structure, {}).map((span) => ({
        text: SOURCE.slice(span.start, span.start + span.length), type: span.type,
    }));
    const line = SOURCE.indexOf('Text Title');
    const lineEnd = SOURCE.indexOf('\n', line);
    const here = collectSemanticSpans(structure, {})
        .filter((span) => span.start >= line && span.start < lineEnd && span.type === 'class')
        .map((span) => SOURCE.slice(span.start, span.start + span.length));
    assert.deepEqual(here, ['Heading', 'Glow']);
    const headerStart = SOURCE.indexOf('rows Text');
    const header = collectSemanticSpans(structure, {})
        .filter((span) => span.start >= headerStart && span.start < SOURCE.indexOf('\n', headerStart) && span.type === 'class')
        .map((span) => SOURCE.slice(span.start, span.start + span.length));
    assert.deepEqual(header, ['Heading', 'Glow']);
    assert.ok(spans.filter((span) => span.text === 'Heading' && span.type === 'class').length >= 4);
});

test('the workspace index lists a use for every name, so go-to-definition and references see each', () => {
    const summary = summarizeFile('a.dui', SOURCE);
    const uses = summary.styleUses.filter((use) => use.name === 'Glow');
    // Strong's base, the Title node, and the rows header.
    assert.equal(uses.length, 3);
    for (const use of uses) {
        assert.equal(SOURCE.slice(use.start, use.end), 'Glow');
    }
});

test('the formatter keeps the clause and spaces its colons', () => {
    const tight = 'style S:A:B{\n}\nWidget Root {\n    Text T:A:B { Text = "x" }\n    rows Text:A:B (Text) {\n        "x"\n    }\n}\n';
    const formatted = formatDui(tight, SPACES);
    assert.ok(formatted.includes('style S : A : B {'), formatted);
    assert.ok(formatted.includes('Text T : A : B { Text = "x" }'), formatted);
    assert.ok(formatted.includes('rows Text : A : B (Text) {'), formatted);
    assert.equal(formatDui(formatted, SPACES), formatted);
    assert.equal(formatDui(SOURCE, SPACES), SOURCE);
});

test('inlining is offered on any name of a clause but done only for one style', () => {
    const source = 'style A {\n    FontSize = 20\n}\nstyle B {\n    Color = #FFF\n}\nWidget Root {\n    Text T : A : B {\n    }\n    Text U : A {\n    }\n}\n';
    const built = buildStructure(source);
    const worn = wornStyleAt(built, source.indexOf('B {\n    }'))!;
    assert.equal(worn.id, 'T');
    const refused = planInlineStyle(built, source, worn);
    assert.ok('error' in refused);
    const single = wornStyleAt(built, source.indexOf(': A {\n    }', source.indexOf('Text U')) + 2)!;
    assert.equal(single.id, 'U');
    assert.ok(!('error' in planInlineStyle(built, source, single)));
});

test('go to definition lands on the declaration from any name of a clause, a rows header\'s included', () => {
    const structure = buildStructure(SOURCE);
    const glowDeclaration = SOURCE.indexOf('style Glow') + 'style '.length;
    for (const marker of ['Text Title : Heading : Glow', 'rows Text : Heading : Glow', 'Strong : Heading : Glow']) {
        const at = SOURCE.indexOf(marker) + marker.length - 'Glow'.length + 1;
        const hit = definitionAt(undefined, 'a.dui', structure, at);
        assert.ok(hit, marker);
        assert.equal(hit!.target.start, glowDeclaration, marker);
    }
});
