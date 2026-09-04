/**
 * The structural layer, held to the compiler's verdicts. One block per code with a positive and a
 * negative, then the skeleton facts (tree shape, styles, resources, refs, scopes), then the
 * fixture sweep: the project's real file must produce zero structural diagnostics.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildStructure, scopeAt, MAX_NESTING_DEPTH } from '../src/core/structure';

function structural(source: string): { code: number; severity: string; line: number; message: string }[] {
    return buildStructure(source).diagnostics
        .map(({ code, severity, line, message }) => ({ code, severity, line, message }));
}

function codes(source: string): number[] {
    return structural(source).map((diagnostic) => diagnostic.code);
}

const WELL_FORMED = `class /Game/UI/WBP_Panel

style Label {
    FontSize = 18
}
style Danger : Label {
    FontSize = 22
}

resources {
    Color Accent = #FF6600
    Number Gap = 8
}

Widget Root {
    + Overlay {}

    Text Title : Label {
        Text = "Hello"
        Brush.TintColor = @Accent
        @slot Padding = (4, 4, 4, 4)
        OnClicked -> Confirm
        Text <- GetTitle()
    }

    slot Footer

    for Row in GetRows() {
        Text RowLabel : Danger {
            Text = "row"
        }
    }
}
`;

// ---- DUI2002 / DUI2003 unclosed block and tuple ------------------------------------------------

test('DUI2002: an unclosed brace reports at the brace, not at end of file', () => {
    const result = structural('Widget Root {\n    Text Title {\n');
    const unclosed = result.filter((d) => d.code === 2002);
    assert.equal(unclosed.length, 2); // the inner block and the outer both never close
    assert.deepEqual(unclosed.map((d) => d.line).sort(), [1, 2]);
});

test('DUI2003: an unclosed tuple reports at the parenthesis and stops at the closing brace', () => {
    assert.deepEqual(codes('Widget Root {\n    A = (1, 2\n}\n'), [2003]);
});

test('a nested tuple pairs across lines without complaint', () => {
    assert.deepEqual(codes('Widget Root {\n    A = ((1, 2), (3, 4))\n}\n'), []);
});

// ---- DUI2004 missing node id -------------------------------------------------------------------

test('DUI2004: a node header with no identifier, reported against the type', () => {
    const result = structural('Widget Root {\n    Text {\n    }\n}\n');
    assert.deepEqual(result.map((d) => d.code), [2004]);
    assert.match(result[0].message, /needs an id/);
    assert.equal(result[0].line, 2);
});

test('a property at the top level is not mistaken for a node header', () => {
    assert.ok(!codes('A = 1\nWidget Root {}\n').includes(2004));
});

// ---- DUI2006 root count ------------------------------------------------------------------------

test('DUI2006: a second root reports where it stands', () => {
    const result = structural('Widget Root {}\nWidget Другой {}\n');
    assert.deepEqual(result.map((d) => d.code), [2006]);
    assert.equal(result[0].line, 2);
});

test('DUI2006: substance but no root', () => {
    assert.deepEqual(codes('class /Game/UI/WBP_X\n'), [2006]);
});

test('an empty file and a comment-only file stay quiet', () => {
    assert.deepEqual(codes(''), []);
    assert.deepEqual(codes('// just notes\n/* and a block */\n'), []);
});

// ---- DUI3001 duplicate id ----------------------------------------------------------------------

test('DUI3001: two nodes sharing an id, case insensitively, second one reported', () => {
    const result = structural('Widget Root {\n    Text OkBtn {}\n    Image okbtn {}\n}\n');
    assert.deepEqual(result.map((d) => d.code), [3001]);
    assert.equal(result[0].line, 3);
    assert.match(result[0].message, /already the id of the node on line 2/);
});

test('DUI3001: a named slot lives in the same namespace as widget ids', () => {
    assert.deepEqual(codes('Widget Root {\n    Text Footer {}\n    slot Footer\n}\n'), [3001]);
});

test('DUI3001: ids inside a loop body still count', () => {
    assert.deepEqual(codes('Widget Root {\n    Text A {}\n    for Row in GetRows() {\n        Text A {}\n    }\n}\n'), [3001]);
});

// ---- DUI3002 invalid id ------------------------------------------------------------------------

test('DUI3002: a keyword as a node id, a digit-leading id, a keyword slot name', () => {
    assert.deepEqual(codes('Widget style {}\n'), [3002]);
    assert.deepEqual(codes('Widget Root {\n    Text 2ndPanel {}\n}\n'), [3002]);
    assert.deepEqual(codes('Widget Root {\n    slot was\n}\n'), [3002]);
});

test('CJK ids are ordinary ids', () => {
    assert.deepEqual(codes('Widget 根 {\n    Text 标题 {}\n}\n'), []);
});

// ---- DUI3004 unknown style ---------------------------------------------------------------------

test('DUI3004: a node wearing an undeclared style is an error', () => {
    const result = structural('Widget Root {\n    Text A : Missing {}\n}\n');
    assert.deepEqual(result.map((d) => ({ code: d.code, severity: d.severity })),
        [{ code: 3004, severity: 'error' }]);
    assert.match(result[0].message, /names a style this file does not declare/);
});

test('DUI3004: a worn style with an unknown base is an error at the style declaration', () => {
    const result = structural('style A : Missing {\n}\nWidget Root {\n    Text T : A {}\n}\n');
    assert.deepEqual(result.map((d) => ({ code: d.code, severity: d.severity, line: d.line })),
        [{ code: 3004, severity: 'error', line: 1 }]);
    assert.match(result[0].message, /style 'A' inherits 'Missing', which this file does not declare/);
});

test('DUI3004: an unworn style with an unknown base is only a warning', () => {
    const result = structural('style A : Missing {\n}\nWidget Root {}\n');
    assert.deepEqual(result.map((d) => ({ code: d.code, severity: d.severity })),
        [{ code: 3004, severity: 'warning' }]);
});

test('style names resolve case insensitively', () => {
    assert.deepEqual(codes('style Label {\n}\nWidget Root {\n    Text A : label {}\n}\n'), []);
});

// ---- DUI3005 duplicate style -------------------------------------------------------------------

test('DUI3005: two styles under one name, case insensitively', () => {
    const result = structural('style Card {\n}\nstyle card {\n}\nWidget Root {}\n');
    assert.deepEqual(result.map((d) => d.code), [3005]);
    assert.equal(result[0].line, 3);
});

// ---- DUI3008 shadowed loop variable ------------------------------------------------------------

test('DUI3008: shadowing an enclosing loop variable is a warning, case sensitively', () => {
    const shadowed = structural(
        'Widget Root {\n    for Row in GetRows() {\n        for Row in GetCells() {\n            Text A {}\n        }\n    }\n}\n');
    assert.deepEqual(shadowed.map((d) => ({ code: d.code, severity: d.severity })),
        [{ code: 3008, severity: 'warning' }]);
    // Different case = different variable, exactly as the compiler compares them.
    assert.deepEqual(codes(
        'Widget Root {\n    for Row in GetRows() {\n        for row in GetCells() {\n            Text A {}\n        }\n    }\n}\n'), []);
});

// ---- DUI2013 nesting too deep ------------------------------------------------------------------

/** A chain of `Widget N0 { Widget N1 { ... } }`, `depth` bodies deep, one root included. */
function nested(depth: number): string {
    let source = '';
    for (let level = 0; level < depth; level++) {
        source += `Widget N${level} {\n`;
    }
    for (let level = 0; level < depth; level++) {
        source += '}\n';
    }
    return source;
}

test('DUI2013: the limit is exactly the compiler\'s -- 256 bodies pass, 257 do not', () => {
    assert.deepEqual(codes(nested(MAX_NESTING_DEPTH)), []);
    assert.deepEqual(codes(nested(MAX_NESTING_DEPTH + 1)), [2013]);
});

test('DUI2013: said once per file, however many levels reach the limit', () => {
    const result = structural(nested(MAX_NESTING_DEPTH + 40));
    assert.deepEqual(result.map((d) => ({ code: d.code, severity: d.severity })),
        [{ code: 2013, severity: 'error' }]);
    assert.match(result[0].message, /nests more than 256 levels deep/);
    // Reported at the '{' that broke the budget, not at the end of the file.
    assert.equal(result[0].line, MAX_NESTING_DEPTH + 1);
});

test('DUI2013: the over-deep block is skipped balanced, so the file after it still parses', () => {
    const built = buildStructure(`${nested(MAX_NESTING_DEPTH + 1)}Widget Second {}\n`);
    assert.deepEqual(built.diagnostics.map((d) => d.code), [2013, 2006]);
    // Two roots is DUI2006's business; the point here is that the second one was SEEN.
    assert.equal(built.roots.length, 2);
    assert.equal(built.roots[1].id, 'Second');
});

test('DUI2013: a component body spends the same budget -- one counter, one stack', () => {
    // 256 node bodies is legal, so the '+ Overlay {' inside the innermost is the 257th descent.
    let opens = '';
    for (let level = 0; level < MAX_NESTING_DEPTH; level++) {
        opens += `Widget N${level} {\n`;
    }
    const closes = '}\n'.repeat(MAX_NESTING_DEPTH);
    const seen = codes(`${opens}+ Overlay {\n    Padding = 4\n}\n${closes}`);
    assert.deepEqual(seen, [2013]);
});

// ---- DUI3010/3011/3012 rename clauses ----------------------------------------------------------
//
// Warnings here and errors in the compiler, deliberately: this layer answers on every keystroke,
// the compiler answers on compile with a message that names both nodes, and since these left
// MAILBOX_SUPPRESSED both now reach the Problems panel. See core/mailbox.ts.

test('DUI3012: a was clause naming the node itself', () => {
    const result = structural('Widget Root (was: Root) {}\n');
    assert.deepEqual(result.map((d) => ({ code: d.code, severity: d.severity })),
        [{ code: 3012, severity: 'warning' }]);
});

test('DUI3010: a was clause naming a still-live id', () => {
    const result = structural('Widget Root {\n    Text A (was: B) {}\n    Image B {}\n}\n');
    assert.deepEqual(result.map((d) => ({ code: d.code, severity: d.severity })),
        [{ code: 3010, severity: 'warning' }]);
});

test('DUI3011: two nodes claiming the same old id', () => {
    const result = structural('Widget Root {\n    Text A (was: Old) {}\n    Image B (was: Old) {}\n}\n');
    assert.deepEqual(result.map((d) => d.code), [3011]);
    assert.equal(result[0].line, 3);
});

test('a well-formed was clause is silent and lands on the node', () => {
    const built = buildStructure('Widget Root {\n    Text A (was: Old) {}\n}\n');
    assert.deepEqual(built.diagnostics, []);
    assert.equal(built.roots[0].children[0].wasId, 'Old');
});

// ---- DUI3014 duplicate resource ----------------------------------------------------------------

test('DUI3014: a resource declared twice, case insensitively, second one reported', () => {
    const result = structural('resources {\n    Color Accent = #FFF\n    Number accent = 3\n}\nWidget Root {}\n');
    assert.deepEqual(result.map((d) => d.code), [3014]);
    assert.equal(result[0].line, 3);
});

// ---- DUI3015 style cycle -----------------------------------------------------------------------

test('DUI3015: a worn style that inherits itself through its bases', () => {
    const result = structural('style A : B {\n}\nstyle B : A {\n}\nWidget Root {\n    Text T : A {}\n}\n');
    assert.deepEqual(result.map((d) => ({ code: d.code, severity: d.severity, line: d.line })),
        [{ code: 3015, severity: 'error', line: 6 }]);
});

test('an unworn cycle stays quiet, as the builder never walks it', () => {
    assert.deepEqual(codes('style A : B {\n}\nstyle B : A {\n}\nWidget Root {}\n'), []);
});

// ---- the skeleton ------------------------------------------------------------------------------

test('the well-formed sample parses without a single diagnostic', () => {
    const built = buildStructure(WELL_FORMED);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.lexical, []);
});

test('the skeleton carries the tree, styles, resources and refs', () => {
    const built = buildStructure(WELL_FORMED);
    assert.equal(built.classPath?.path, '/Game/UI/WBP_Panel');
    assert.equal(built.roots.length, 1);

    const root = built.roots[0];
    assert.equal(root.id, 'Root');
    assert.deepEqual(root.components.map((c) => c.name), ['Overlay']);
    assert.deepEqual(root.children.map((c) => `${c.kind}:${c.id}`),
        ['node:Title', 'namedSlot:Footer', 'loop:Row']);
    assert.equal(root.children[0].styleName, 'Label');
    assert.equal(root.children[2].children[0].id, 'RowLabel');

    assert.deepEqual(built.styles.map((s) => `${s.name}${s.base ? ':' + s.base : ''}`), ['Label', 'Danger:Label']);
    assert.deepEqual(built.resources.map((r) => `${r.type} ${r.name} = ${r.valueText}`),
        ['Color Accent = #FF6600', 'Number Gap = 8']);
    assert.deepEqual(built.resourceRefs.map((r) => r.name), ['Accent']);
});

test('scopeAt answers the innermost block for an offset', () => {
    const built = buildStructure(WELL_FORMED);
    const inTitle = WELL_FORMED.indexOf('Text = "Hello"');
    assert.equal(scopeAt(built, inTitle)?.id, 'Title');
    const inOverlay = WELL_FORMED.indexOf('+ Overlay {') + '+ Overlay {'.length;
    assert.equal(scopeAt(built, inOverlay)?.kind, 'component');
    const inResources = WELL_FORMED.indexOf('Color Accent');
    assert.equal(scopeAt(built, inResources)?.kind, 'resources');
    const inStyle = WELL_FORMED.indexOf('FontSize = 18');
    assert.equal(scopeAt(built, inStyle)?.kind, 'style');
    assert.equal(scopeAt(built, 0), undefined);
});

test('@slot and @key are not resource references', () => {
    const built = buildStructure('Widget Root {\n    @slot Padding = (1, 1, 1, 1)\n    @key("Old.Text")\n}\n');
    assert.deepEqual(built.resourceRefs, []);
});

// ---- the day `<-` learned expressions ----------------------------------------------------------

test('<-> parses as a property and records the mirrored variable', () => {
    const built = buildStructure('Widget Root {\n    Slider Vol {\n        Value <-> Volume\n    }\n}\n');
    assert.deepEqual(built.diagnostics, []);
    const slider = built.roots[0].children[0];
    assert.equal(slider.children.length, 0); // a property, never mistaken for a child node
    assert.deepEqual(slider.properties.map((p) => `${p.path}:${p.op}`), ['Value:twoWayArrow']);
    assert.deepEqual(built.bindings.map((b) => `${b.name}:${b.isVariable ? 'variable' : 'function'}`),
        ['Volume:variable']);
});

test('a binding expression yields every call as a function ref and every bare name as a variable', () => {
    const built = buildStructure(
        'Widget Root {\n    Text T {\n        Text <- Prefix\n        Enabled <- !IsBusy() && Count() > 0\n        RenderOpacity <- GetScale() * 0.5 - Base\n    }\n}\n');
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.bindings.map((b) => `${b.name}:${b.isVariable ? 'variable' : 'function'}`),
        ['Prefix:variable', 'IsBusy:function', 'Count:function', 'GetScale:function', 'Base:variable']);
});

test('true and false are literals, not variable refs', () => {
    const built = buildStructure('Widget Root {\n    Text T {\n        Visible <- true\n    }\n}\n');
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.bindings, []);
});

test('a call nested in an argument list is still found', () => {
    const built = buildStructure('Widget Root {\n    Text T {\n        Text <- Format(GetCount(), Suffix)\n    }\n}\n');
    assert.deepEqual(built.bindings.map((b) => `${b.name}:${b.isVariable ? 'variable' : 'function'}`),
        ['Format:function', 'GetCount:function', 'Suffix:variable']);
});

test('Item.Member inside an each body is one dotted variable ref', () => {
    const built = buildStructure(
        'Widget Root {\n    + UIRecyclableScrollView {}\n    each Item in Rows {\n        Text Cell {\n            Text <- Item.Title\n        }\n    }\n}\n');
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.bindings.map((b) => `${b.name}:${b.isVariable ? 'variable' : 'function'}`),
        ['Item.Title:variable']);
});

test('a loop source is a call with parens or a variable without, both clean', () => {
    assert.deepEqual(codes('Widget Root {\n    each Row in GetRows() {\n        Text A {}\n    }\n}\n'), []);
    assert.deepEqual(codes('Widget Root {\n    each Row in Rows {\n        Text A {}\n    }\n}\n'), []);
});

test('use records the import and judges nothing', () => {
    const built = buildStructure('class /Game/UI/WBP_X\nuse "Styles/Common.dui"\nWidget Root {}\n');
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.imports.map((entry) => entry.path), ['Styles/Common.dui']);
    assert.equal(built.imports[0].line, 2);
    // A malformed one (no quoted path) is the compiler's refusal to word; stepped over here.
    const malformed = buildStructure('use Common\nWidget Root {}\n');
    assert.deepEqual(malformed.diagnostics, []);
    assert.deepEqual(malformed.imports, []);
});

test('DUI3002: use is a keyword now, and cannot be a node id', () => {
    assert.deepEqual(codes('Widget use {}\n'), [3002]);
});

// ---- fixture sweep -----------------------------------------------------------------------------

test('a scoped tag is one node, and a dotted path is still a property', () => {
    const structure = buildStructure(`class /Game/UI/WBP_X

Widget Root {
    AnchorData.SizeDelta = (0, 30)

    Native.Toggle Mute {
        Label = "muted"
    }
}
`);
    assert.equal(structure.diagnostics.length, 0);
    assert.equal(structure.roots.length, 1);
    const root = structure.roots[0];
    assert.equal(root.properties.some((property) => property.path === 'AnchorData.SizeDelta'), true);
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].tag, 'Native.Toggle');
    assert.equal(root.children[0].id, 'Mute');
});

test('a dotted run ending in an arrow reads as a binding, not a node', () => {
    const structure = buildStructure(`class /Game/UI/WBP_X

Widget Root {
    Brush.TintColor <- GetInk()
}
`);
    assert.equal(structure.roots[0].children.length, 0);
    assert.equal(structure.bindings.length, 1);
});

test('the real SettingsPanel.dui produces zero structural diagnostics', () => {
    const fixture = fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'SettingsPanel.dui'), 'utf8');
    const built = buildStructure(fixture);
    assert.deepEqual(built.diagnostics, []);
    assert.equal(built.roots.length, 1);
    assert.equal(built.roots[0].id, 'Root');
    assert.equal(built.styles.length, 1);
});
