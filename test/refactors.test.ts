/**
 * The extract/inline refactors, verified by applying: the result re-parses clean and the skeleton
 * says the same thing it said before -- values moved, nothing changed meaning.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import {
    extractableLiteralAt, countMatchingLiterals, planExtractResource,
    planExtractStyle, wornStyleAt, planInlineStyle,
} from '../src/core/refactors';
import { applyRenameEdits, RenameEdit } from '../src/core/rename';

function mustPlan(plan: { edits: RenameEdit[] } | { error: string }): RenameEdit[] {
    assert.ok(!('error' in plan), 'error' in plan ? (plan as { error: string }).error : '');
    return (plan as { edits: RenameEdit[] }).edits;
}

// ---- extract literal -> resource ---------------------------------------------------------------

const COLOURS = 'class /Game/UI/WBP_X\n\nWidget Root {\n    Image A {\n        Brush.TintColor = #0077FF\n    }\n    Image B {\n        Brush.TintColor = #0077FF\n        Brush.ImageSize = (120, 44)\n    }\n}\n';

test('a hex literal in single-value position is extractable; a tuple element is not', () => {
    const built = buildStructure(COLOURS);
    const literal = extractableLiteralAt(built, COLOURS, COLOURS.indexOf('#0077FF') + 2)!;
    assert.equal(literal.text, '#0077FF');
    assert.equal(literal.resourceType, 'Color');
    assert.equal(extractableLiteralAt(built, COLOURS, COLOURS.indexOf('120') + 1), undefined);
});

test('extracting one occurrence declares the entry and rewrites just that literal', () => {
    const built = buildStructure(COLOURS);
    const literal = extractableLiteralAt(built, COLOURS, COLOURS.indexOf('#0077FF'))!;
    const result = applyRenameEdits(COLOURS,
        mustPlan(planExtractResource(built, COLOURS, literal, 'Accent', false)));
    const rebuilt = buildStructure(result);
    assert.deepEqual(rebuilt.diagnostics, []);
    assert.deepEqual(rebuilt.resources.map((r) => `${r.type} ${r.name} = ${r.valueText}`), ['Color Accent = #0077FF']);
    assert.equal((result.match(/@Accent/g) ?? []).length, 1);
    assert.equal((result.match(/#0077FF/g) ?? []).length, 2); // the declaration and B's untouched literal
});

test('extract-all rewrites every matching single-value literal', () => {
    const built = buildStructure(COLOURS);
    const literal = extractableLiteralAt(built, COLOURS, COLOURS.indexOf('#0077FF'))!;
    assert.equal(countMatchingLiterals(built, COLOURS, literal), 2);
    const result = applyRenameEdits(COLOURS,
        mustPlan(planExtractResource(built, COLOURS, literal, 'Accent', true)));
    const rebuilt = buildStructure(result);
    assert.deepEqual(rebuilt.diagnostics, []);
    assert.equal((result.match(/@Accent/g) ?? []).length, 2);
    assert.equal((result.match(/#0077FF/g) ?? []).length, 1); // only the declaration keeps the raw value
});

test('a string literal extracts as String, with its quotes', () => {
    const source = 'Widget Root {\n    Text T {\n        Text = "确定"\n    }\n}\n';
    const built = buildStructure(source);
    const literal = extractableLiteralAt(built, source, source.indexOf('"确定"'))!;
    assert.equal(literal.resourceType, 'String');
    const result = applyRenameEdits(source, mustPlan(planExtractResource(built, source, literal, 'OkText', false)));
    const rebuilt = buildStructure(result);
    assert.deepEqual(rebuilt.diagnostics, []);
    assert.equal(rebuilt.resources[0].valueText, '"确定"');
});

// ---- extract properties -> style ---------------------------------------------------------------

const FOR_STYLE = 'class /Game/UI/WBP_X\n\nWidget Root {\n    Text Title {\n        FontSize = 32\n        HAlign   = Left\n        @slot SizeRule = Auto\n        Text = "Settings"\n    }\n}\n';

test('extracting selected property lines makes a style the node then wears', () => {
    const built = buildStructure(FOR_STYLE);
    const start = FOR_STYLE.indexOf('FontSize');
    const end = FOR_STYLE.indexOf('Left') + 4;
    const result = applyRenameEdits(FOR_STYLE, mustPlan(planExtractStyle(built, FOR_STYLE, start, end, 'Heading')));
    const rebuilt = buildStructure(result);
    assert.deepEqual(rebuilt.diagnostics, []);
    assert.deepEqual(rebuilt.styles.map((s) => s.name), ['Heading']);
    assert.deepEqual(rebuilt.styles[0].properties.map((p) => p.path), ['FontSize', 'HAlign']);
    const title = rebuilt.roots[0].children[0];
    assert.equal(title.styleName, 'Heading');
    // The moved lines left the node; the others stayed.
    assert.deepEqual(title.properties.map((p) => p.path), ['SizeRule', 'Text']);
});

test('a selection touching an @slot line is refused: not style material', () => {
    const built = buildStructure(FOR_STYLE);
    const start = FOR_STYLE.indexOf('FontSize');
    const end = FOR_STYLE.indexOf('Auto') + 4;
    const plan = planExtractStyle(built, FOR_STYLE, start, end, 'Heading');
    assert.ok('error' in plan && /@slot/.test(plan.error));
});

test('a node already wearing a style is refused', () => {
    const source = 'style S {\n}\nWidget Root {\n    Text T : S {\n        FontSize = 9\n    }\n}\n';
    const built = buildStructure(source);
    const plan = planExtractStyle(built, source, source.indexOf('FontSize'), source.indexOf('= 9') + 3, 'X');
    assert.ok('error' in plan && /已经穿着/.test(plan.error));
});

// ---- inline a style ----------------------------------------------------------------------------

test('inlining lands the chain base-first-derived-overriding, minus what the node already sets', () => {
    const source = 'style Label {\n    FontSize = 18\n    HAlign = Left\n}\nstyle Danger : Label {\n    FontSize = 22\n}\n\nWidget Root {\n    Text T : Danger {\n        HAlign = Right\n    }\n}\n';
    const built = buildStructure(source);
    const node = wornStyleAt(built, source.indexOf(': Danger') + 3)!;
    const result = applyRenameEdits(source, mustPlan(planInlineStyle(built, source, node)));
    const rebuilt = buildStructure(result);
    assert.deepEqual(rebuilt.diagnostics, []);
    const title = rebuilt.roots[0].children[0];
    assert.equal(title.styleName, undefined);
    // FontSize comes from Danger (22, overriding Label's 18); HAlign stays the node's own Right.
    const props = new Map(title.properties.map((p) => [p.path, result.slice(p.valueStart!, p.valueEnd!)]));
    assert.equal(props.get('FontSize'), '22');
    assert.equal(props.get('HAlign'), 'Right');
    assert.equal(title.properties.length, 2);
    // The declarations stay: other nodes may wear them.
    assert.deepEqual(rebuilt.styles.map((s) => s.name), ['Label', 'Danger']);
});

test('inlining into a single-line block opens the block up', () => {
    const source = 'style S {\n    FontSize = 9\n}\nWidget Root {\n    Text T : S {}\n}\n';
    const built = buildStructure(source);
    const node = wornStyleAt(built, source.indexOf(': S') + 2)!;
    const result = applyRenameEdits(source, mustPlan(planInlineStyle(built, source, node)));
    const rebuilt = buildStructure(result);
    assert.deepEqual(rebuilt.diagnostics, []);
    assert.equal(rebuilt.roots[0].children[0].properties.length, 1);
    assert.equal(rebuilt.roots[0].children[0].styleName, undefined);
});

test('inlining a broken chain is refused with the code to fix first', () => {
    const source = 'style A : Missing {\n}\nWidget Root {\n    Text T : A {\n        X = 1\n    }\n}\n';
    const built = buildStructure(source);
    const node = wornStyleAt(built, source.indexOf(': A') + 2)!;
    const plan = planInlineStyle(built, source, node);
    assert.ok('error' in plan && /DUI3004/.test(plan.error));
});

// ---- the component grammar's forms -------------------------------------------------------------

test('extracting a style from an unnamed node puts the clause straight after its type', () => {
    const source = 'Widget Root {\n    HorizontalBox {\n        Spacing = 14\n        Padding = (1, 2, 3, 4)\n        Text A {}\n    }\n}\n';
    const built = buildStructure(source);
    const plan = planExtractStyle(built, source, source.indexOf('Spacing'), source.indexOf('(1, 2, 3, 4)') + 12, 'Strip');
    const result = applyRenameEdits(source, mustPlan(plan));
    assert.ok(result.includes('    HorizontalBox : Strip {'));
    const rebuilt = buildStructure(result);
    assert.deepEqual(rebuilt.diagnostics, []);
    const box = rebuilt.roots[0].children[0];
    assert.ok(box.anonymous);
    assert.equal(box.styleName, 'Strip');
    assert.deepEqual(rebuilt.styles[0].properties.map((p) => p.path), ['Spacing', 'Padding']);
});

test('an if arm holds widgets only: a selection in one is no node body', () => {
    const source = 'Widget Root {\n    if HasSave() {\n        Text A {}\n    }\n}\n';
    const built = buildStructure(source);
    const plan = planExtractStyle(built, source, source.indexOf('Text A'), source.indexOf('Text A') + 6, 'S');
    assert.ok('error' in plan);
});

const COLUMN = 'style Column {\n    + VerticalBox { Spacing = 8 }\n    FontSize = 18\n    @slot Padding = (0, 4, 0, 0)\n    @fill\n}\n\n'
    + 'Widget Root {\n    + HorizontalBox {}\n    Widget Left : Column {\n        @slot Padding = (1, 1, 1, 1)\n    }\n}\n';

test('inlining a style lands its components, widget lines and slot lines, each as what it was', () => {
    const built = buildStructure(COLUMN);
    const node = wornStyleAt(built, COLUMN.indexOf(': Column') + 3)!;
    const result = applyRenameEdits(COLUMN, mustPlan(planInlineStyle(built, COLUMN, node)));
    const rebuilt = buildStructure(result);
    assert.deepEqual(rebuilt.diagnostics, []);
    const left = rebuilt.roots[0].children[0];
    assert.equal(left.styleName, undefined);
    assert.deepEqual(left.components.map((c) => c.name), ['VerticalBox']);
    assert.ok(result.includes('+ VerticalBox { Spacing = 8 }'));
    // The widget line stays a widget line; the slot lines stay slot lines.
    const widgetLines = left.properties.filter((p) => !p.isSlot).map((p) => p.path);
    assert.deepEqual(widgetLines, ['FontSize']);
    assert.ok(left.properties.some((p) => p.shorthand === 'fill'), '@fill came along');
    // The node's own @slot Padding won over the style's: one Padding, the node's value.
    const paddings = left.properties.filter((p) => p.isSlot && p.path === 'Padding');
    assert.equal(paddings.length, 1);
    assert.equal(result.slice(paddings[0].valueStart!, paddings[0].valueEnd!), '(1, 1, 1, 1)');
});

test('inlining refuses a component the node writes too: the merge is the author\'s', () => {
    const source = 'style Column {\n    + VerticalBox { Spacing = 8 }\n}\n\nWidget Root {\n    Widget Left : Column {\n'
        + '        + VerticalBox { Padding = (1, 1, 1, 1) }\n    }\n}\n';
    const built = buildStructure(source);
    const plan = planInlineStyle(built, source, wornStyleAt(built, source.indexOf(': Column') + 3)!);
    assert.ok('error' in plan && /VerticalBox/.test(plan.error));
});

test('a style from a namespace, or brought in by use, is not this file\'s to inline', () => {
    const source = 'use "UI/Lib.dui" as ui\nuse "UI/Common.dui"\n\nWidget Root {\n    Text A : ui.Caption {}\n    Text B : Label {}\n}\n';
    const built = buildStructure(source);
    const namespaced = planInlineStyle(built, source, wornStyleAt(built, source.indexOf('ui.Caption') + 4)!);
    assert.ok('error' in namespaced && /命名空间/.test(namespaced.error));
    const imported = planInlineStyle(built, source, wornStyleAt(built, source.indexOf(': Label') + 3)!);
    assert.ok('error' in imported && /use/.test(imported.error));
});

test('the weight of @fill is no extractable literal', () => {
    const source = 'Widget Root {\n    + HorizontalBox {}\n    Text A {\n        @fill 2\n    }\n}\n';
    assert.equal(extractableLiteralAt(buildStructure(source), source, source.indexOf('2\n')), undefined);
});
