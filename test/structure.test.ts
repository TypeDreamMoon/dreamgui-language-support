/**
 * The structural layer, held to the compiler's verdicts. One block per code with a positive and a
 * negative, then the skeleton facts (tree shape, styles, resources, refs, scopes), then the
 * fixture sweep: the project's real file must produce zero structural diagnostics.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildStructure, scopeAt, loweredChildren, MAX_NESTING_DEPTH, StructNode } from '../src/core/structure';
import { CONTEXTUAL_KEYWORDS, RESERVED_WORDS } from '../src/core/scanner';

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

test('DUI2004: a type alone on its line, reported against the type in the compiler\'s words', () => {
    // `Text {` is a node now (an unnamed one); a type with neither an id nor a block still is not.
    const result = structural('Widget Root {\n    Image\n}\n');
    assert.deepEqual(result.map((d) => d.code), [2004]);
    assert.equal(result[0].message,
        "'Image' needs an id or a block, as in 'Image MyName' or 'Image { ... }' -- or an '=' if it was meant to be a property");
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
    // `@key(…)` where it is an annotation: after a string value. At the head of a statement the compiler reads
    // `@key` as a node type an Asset resource names (ParseNode), which it then is.
    const built = buildStructure('Widget Root {\n    @slot Padding = (1, 1, 1, 1)\n    Text = "Old" @key("Old.Text")\n}\n');
    assert.deepEqual(built.diagnostics, []);
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

test('a timeline block is recognised whole and judged by nobody here', () => {
    // The extension may report LESS than the compiler and never differently, so the one thing this
    // layer owes a timeline is not painting its contents red. Track lines resolve against the tree
    // and the engine's reflection, neither of which one file's characters can see.
    const structure = buildStructure(`class /Game/UI/WBP_X

timeline Pulse {
    duration = 0.6
    loop     = PingPong
    RenderScale : 0.0 = (1, 1, 1), 0.3 = (1.25, 1.25, 1) ease InOutQuad
    Row/Icon.Color : 0.0 = #FFFFFF, 0.6 = #FFC800
    @0.3 -> Landed
}

timeline Celebrate external

Widget Root {
    Widget Row {
        Image Icon { }
    }
}
`);
    assert.deepEqual(structure.diagnostics, []);
    assert.equal(structure.timelines.length, 2);
    assert.equal(structure.timelines[0].name, 'Pulse');
    assert.equal(structure.timelines[0].external, false);
    assert.equal(structure.timelines[1].name, 'Celebrate');
    assert.equal(structure.timelines[1].external, true);
    // And the tree beside it is still the tree: a timeline is file scope, level with `style`.
    assert.equal(structure.roots.length, 1);
    assert.equal(structure.roots[0].id, 'Root');
});

test('two timelines of one name is DUI3016, the same shape a duplicate style is', () => {
    const structure = buildStructure(`timeline T { }
timeline T { }
Widget Root { }
`);
    assert.deepEqual(structure.diagnostics.map((d) => d.code), [3016]);
    assert.equal(structure.timelines.length, 1);
});

// ---- the newer spellings: use … as, namespaces, unnamed nodes, slot lines, props, events, slots, if ----------------
//
// Held to DreamUISyntaxParserAutomationTests.cpp, case for case where one file's characters settle the case: the code,
// the line, and -- where the compiler's test asserts it -- the column and the made id.

/** A file of `entries`, joined with '\n', as the compiler's tests write theirs (line 1 is the first entry). */
const lines = (...entries: string[]): string => entries.join('\n');

/** Every node of the tree as the compiler holds it, branches flattened, in order: `id` per node. */
function ids(node: StructNode): string[] {
    return [node.id, ...loweredChildren(node).flatMap(ids)];
}

function only(source: string): { code: number; line: number; column: number; message: string } {
    const result = buildStructure(source).diagnostics;
    assert.equal(result.length, 1, JSON.stringify(result.map((d) => `DUI${d.code} ${d.line}: ${d.message}`)));
    return result[0];
}

test('use … as: a file, a class path and a namespace are recorded with their names, and judged clean', () => {
    const built = buildStructure(lines(
        'use "Components/Row.dui" as Row',
        'use /Game/UI/WBP_Slider as Slider',
        'use "UI/NieR_Common.dui" as nier',
        'use "UI/Library.dui"',
        'Widget Root {',
        '    Row Row1 { }',
        '}'));
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.imports.map((u) => `${u.target}:${u.path}:${u.alias ?? '-'}`),
        ['file:Components/Row.dui:Row', 'class:/Game/UI/WBP_Slider:Slider', 'file:UI/NieR_Common.dui:nier',
            'file:UI/Library.dui:-']);
    // At the name after 'as', as the compiler locates an alias (column 29).
    assert.equal(built.imports[0].aliasColumn, 29);
    assert.equal(built.imports[1].aliasColumn, 28);
    assert.equal(built.imports.some((u) => u.refused), false);
});

test('DUI2015: every malformed use … as is one complaint, on its line, and imports nothing', () => {
    const cases: [string, string][] = [
        ['use /Game/UI/WBP_Row', "'use /Game/UI/WBP_Row' names a class, and needs a name to write it by, as in 'use /Game/UI/WBP_Row as Row'"],
        ['use "Row.dui" as', "'use Row.dui as' needs a name after 'as', as in 'use Row.dui as Row', found 'the end of the line'"],
        ['use "Row.dui" as nier.Row', "'nier' after 'as' is the whole name, and '.' cannot follow it"],
        ['use /Game/UI/WBP_Row as for', "'use /Game/UI/WBP_Row as' needs a name after 'as', as in 'use /Game/UI/WBP_Row as Row', found 'for'"],
    ];
    for (const [use, message] of cases) {
        const source = lines(use, 'Widget Root { }');
        const diagnostic = only(source);
        assert.deepEqual([diagnostic.code, diagnostic.line, diagnostic.message], [2015, 1, message], use);
        assert.equal(buildStructure(source).imports.every((u) => u.refused), true, use);
    }
});

test('DUI3017: a name given twice -- aliases and namespaces share the names -- and the first is kept', () => {
    const twice = only(lines('use /Game/UI/WBP_RowA as Row', 'use /Game/UI/WBP_RowB as row', 'Widget Root { }'));
    assert.deepEqual([twice.code, twice.line, twice.message], [3017, 2, "'row' is already the name the 'use' on line 1 gave"]);
    const shared = only(lines('use /Game/UI/WBP_Row as nier', 'use "Lib.dui" as nier', 'Widget Root { }'));
    assert.deepEqual([shared.code, shared.line], [3017, 2]);
    const built = buildStructure(lines('use /Game/UI/WBP_RowA as Row', 'use /Game/UI/WBP_RowB as Row', 'Widget Root { }'));
    assert.deepEqual(built.imports.map((u) => !!u.refused), [false, true]);
});

test('DUI3021: a namespace no use … as declares, once, where it is written', () => {
    const style = only(lines('Widget Root {', '    Image Bg : nier.Card { }', '}'));
    assert.deepEqual([style.code, style.line, style.column], [3021, 2, 16]);
    assert.equal(style.message, `'nier.Card' is qualified by 'nier', which no 'use "..." as nier' declares`);
    assert.deepEqual([only(lines('Widget Root {', '    Color = @nier.Ink', '}')).code], [3021]);
    assert.deepEqual([only(lines('Widget Root {', '    Tint <- Mix(@nier.Ink)', '}')).code], [3021]);
    assert.deepEqual([only(lines('style Danger : nier.Base { }', 'Widget Root { }')).line], [1]);
    assert.deepEqual([only(lines('Widget Root {', '    @nier.Row R1 { }', '}')).code], [3021]);
    // A class path's name is a component, never a namespace.
    assert.deepEqual([only(lines('use /Game/UI/WBP_Row as nier', 'Widget Root { Color = @nier.Ink }')).code], [3021]);
});

test('DUI3021 is not said where one file cannot know: a declared namespace, a plain use, a registry scope', () => {
    assert.deepEqual(codes(lines('use "Lib.dui" as nier', 'Widget Root {', '    Image Bg : nier.Missing { }', '}')), []);
    // A plain `use` merges the library's own namespaces, which only the library can name.
    assert.deepEqual(codes(lines('use "Lib.dui"', 'Widget Root { Color = @pal.Ink }')), []);
    // `Native` is the widget registry's scope, which no `use` declares, and a node type is never a namespace ref.
    assert.deepEqual(codes(lines('Widget Root {', '    Native.Button Ok { }', '    nier.Row R { }', '}')), []);
});

test('an unnamed node gets the id the compiler makes: parent, type, count, bumped past a written one', () => {
    const built = buildStructure(lines(
        'Widget Root {',                      //  1
        '    HorizontalBox {',                //  2
        '        Spacing = 14',               //  3
        '        Text { Text = "Status" }',   //  4
        '        Text : Caption { }',         //  5
        '    }',                              //  6
        '    Text { }',                       //  7
        '    @Row { }',                       //  8
        '    nier.Row { }',                   //  9
        '    Text Root__Text1 { }',           // 10
        '    Text { }',                       // 11
        '}',                                  // 12
        'style Caption { }'));                // 13
    assert.deepEqual(built.diagnostics, []);
    const root = built.roots[0];
    assert.deepEqual(root.children.map((c) => c.id),
        ['Root__HorizontalBox0', 'Root__Text0', 'Root___Row0', 'Root__nier_Row0', 'Root__Text1', 'Root__Text1_1']);
    assert.deepEqual(root.children[0].children.map((c) => c.id), ['Root__HorizontalBox0__Text0', 'Root__HorizontalBox0__Text1']);
    assert.equal(root.children[0].anonymous, true);
    assert.equal(root.children[0].idStart, undefined);
    assert.equal(root.children[4].anonymous, undefined);
    // Located at the type -- the '@' of a resource type.
    assert.deepEqual([root.children[2].line, root.children[2].column, root.children[2].tag], [8, 5, '@Row']);
    assert.equal(root.children[0].children[1].styleName, 'Caption');
});

test('an unnamed root is named under Root, and its children under it', () => {
    const built = buildStructure('Widget {\n    Text { }\n}');
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(ids(built.roots[0]), ['Root__Widget0', 'Root__Widget0__Text0']);
});

test('loops and fills are see-through for made ids, and an if counts its widgets among its parent\'s', () => {
    const built = buildStructure(lines(
        'Widget Root {',
        '    Text { }',
        '    for Item in Items {',
        '        Text { }',
        '    }',
        '    ListPage Page {',
        '        slot Detail {',
        '            Text { }',
        '        }',
        '        Text { }',
        '    }',
        '    if Ready() {',
        '        Text { }',
        '    } else {',
        '        text { }',
        '    }',
        '}'));
    assert.deepEqual(built.diagnostics, []);
    // The loop's own id is empty, as the compiler's is; the count is per spelling without regard to case, as a TMap
    // of FString keeps it.
    assert.deepEqual(ids(built.roots[0]).filter((id, at) => at !== 2),
        ['Root', 'Root__Text0', 'Root__Text1', 'Page', 'Detail', 'Page__Text0', 'Page__Text1', 'Root__Text2', 'Root__text3']);
});

test('DUI1006: a made id an FName cannot hold is reported at the type and cut short enough to bump', () => {
    const path = '/Game/' + 'A'.repeat(1011);
    const built = buildStructure(`Widget Root {\n    ${path} { }\n}`);
    assert.deepEqual(built.diagnostics.map((d) => [d.code, d.line, d.column]), [[1006, 2, 5]]);
    assert.equal(built.diagnostics[0].message,
        "the id made for this unnamed '/Game/AAAAAAAAAA...' would be 1024 characters long, and an id holds at most 1023; give it, or a node above it, an id");
    assert.equal(built.roots[0].children[0].id.length, 1011);
});

test('DUI2004: a type alone is still a mistake, and an unnamed node cannot be renamed', () => {
    assert.deepEqual([only(lines('Widget Root {', '    Image', '}')).line], [2]);
    const renamed = only(lines('style Card { }', 'Widget Root {', '    Image : Card (was: Old) { }', '}'));
    assert.deepEqual([renamed.code, renamed.line, renamed.message],
        [2004, 3, "'Image (was: Old)' renames a node, so it needs the new id written: 'Image MyName : ...'"]);
});

test('slot lines: the @slot block, @fill and @fill 2 land on the node, flagged', () => {
    const built = buildStructure(lines(
        'Widget Root {',
        '    Text A {',
        '        @slot { SizeRule = Fill  Padding = (0, 8, 0, 0) }',
        '    }',
        '    Text B { @fill }',
        '    Text Cell {',
        '        @fill 2',
        '    }',
        '}'));
    assert.deepEqual(built.diagnostics, []);
    const [a, b, cell] = built.roots[0].children;
    assert.deepEqual(a.properties.map((p) => `${p.path}:${p.isSlot}`), ['SizeRule:true', 'Padding:true']);
    assert.deepEqual(b.properties.map((p) => `${p.path}:${p.shorthand}:${p.isSlot}`), ['SizeRule:fill:true']);
    assert.equal(cell.properties[0].shorthand, 'fill');
    assert.equal(cell.properties[0].valueStart, undefined); // no value is spelt
    // The shorthand is not a resource reference.
    assert.deepEqual(built.resourceRefs, []);
    assert.equal(built.scopes.filter((s) => s.kind === 'slotLines').length, 1);
});

test('fill is the shorthand only alone or before a number: a resource called fill still types nodes', () => {
    const built = buildStructure(lines(
        'resources { Asset fill = /Game/UI/WBP_Fill }',
        'Widget Root {',
        '    @fill Filler { }',
        '    @fill { }',
        '    Color = @fill',
        '}'));
    assert.deepEqual(built.diagnostics, []);
    const root = built.roots[0];
    assert.deepEqual(root.children.map((c) => `${c.tag} ${c.id}`), ['@fill Filler', '@fill Root___fill0']);
    assert.deepEqual(built.resourceRefs.map((r) => `${r.name}${r.nodeType ? ' (type)' : ''}`),
        ['fill (type)', 'fill (type)', 'fill']);
});

test('a style carries components and slot lines', () => {
    const built = buildStructure(lines(
        'style RowColumn {',
        '    + VerticalBox { Spacing = 15 }',
        '    @fill',
        '    @slot Padding = (0, 4, 0, 4)',
        '    @slot { MinDesiredSize = (0, 48) }',
        '    RenderOpacity = 0.5',
        '}',
        'Widget Root : RowColumn { }'));
    assert.deepEqual(built.diagnostics, []);
    const style = built.styles[0];
    assert.deepEqual(style.components.map((c) => `${c.name}:${c.properties?.map((p) => p.path).join(',')}`),
        ['VerticalBox:Spacing']);
    assert.deepEqual(style.properties.map((p) => `${p.path}:${p.isSlot}`),
        ['SizeRule:true', 'Padding:true', 'MinDesiredSize:true', 'RenderOpacity:false']);
});

test('props: typed names with optional defaults, accumulating over blocks', () => {
    const built = buildStructure(lines(
        'props {',
        '    Text Label',
        '    Number ValueIndex = 0',
        '    Enum /Script/DevProject.ENieRRowKind Kind = Cycle',
        '    Bool Ready = true; Color Tint = #FF6600',
        '}',
        'props { Vector2 Size }',
        'Widget Root { }'));
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.props.map((p) => `${p.type}${p.enumPath ? ' ' + p.enumPath : ''} ${p.name}${p.defaultText ? ' = ' + p.defaultText : ''}`),
        ['Text Label', 'Number ValueIndex = 0', 'Enum /Script/DevProject.ENieRRowKind Kind = Cycle', 'Bool Ready = true',
            'Color Tint = #FF6600', 'Vector2 Size']);
    assert.deepEqual([built.props[0].line, built.props[0].column], [2, 10]);
    assert.equal(built.scopes.filter((s) => s.kind === 'props').length, 2);
});

test('DUI3019 and DUI2016: a name twice, and every malformed props line, one complaint each', () => {
    const twice = only(lines('props {', '    Text Label', '    String label', '}', 'Widget Root { }'));
    assert.deepEqual([twice.code, twice.line, twice.column, twice.message], [3019, 3, 5, "'label' is already declared on line 2"]);
    const cases: [string, string][] = [
        ['    Label', "expected a name after 'Label', found 'the end of the line'"],
        ['    = 1', "a 'props' line is written 'Type Name', as in 'Text Label', found '='"],
        ['    Enum Kind', "'Enum' takes the enum's path before the name, as in 'Enum /Script/MyGame.ERowKind Kind', found 'Kind'"],
        ['    Number Gap =', "'Gap =' needs its default value, or no '=' at all"],
        ['    Text Label Extra', "a 'props' line declares one name, and 'Extra' cannot follow 'Label'"],
    ];
    for (const [line, message] of cases) {
        const diagnostic = only(lines('props {', line, '}', 'Widget Root { }'));
        assert.deepEqual([diagnostic.code, diagnostic.line, diagnostic.message], [2016, 2, message], line);
    }
    const inside = only(lines('Widget Root {', '    props { Text Label }', '}'));
    assert.deepEqual([inside.code, inside.line, inside.message],
        [2016, 2, "'props' declares what this file's class has, so it belongs at the top of the file, not inside a node"]);
});

test('events: names with optional typed parameters; DUI3020 and DUI2017', () => {
    const built = buildStructure(lines(
        'events {',
        '    Picked(Number Index, Enum /Script/Game.EKind Kind)',
        '    Closed; Opened()',
        '}',
        'events { Moved(Vector2 Delta) }',
        'Widget Root { }'));
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.events.map((e) => `${e.name}(${e.params.map((p) => `${p.type}${p.enumPath ? ' ' + p.enumPath : ''} ${p.name}`).join(', ')})`),
        ['Picked(Number Index, Enum /Script/Game.EKind Kind)', 'Closed()', 'Opened()', 'Moved(Vector2 Delta)']);
    assert.deepEqual([built.events[0].line, built.events[0].column], [2, 5]);

    const event = only(lines('events {', '    Picked', '    Picked(Number Index)', '}', 'Widget Root { }'));
    assert.deepEqual([event.code, event.line, event.message], [3020, 3, "event 'Picked' is already declared on line 2"]);
    const param = only(lines('events {', '    Picked(Number Index, String Index)', '}', 'Widget Root { }'));
    assert.deepEqual([param.code, param.message], [3020, "'Picked' already has a parameter 'Index'"]);
    for (const entry of ['    Picked(Number)', '    Picked(Number Index', '    Picked Closed']) {
        const diagnostic = only(lines('events {', entry, '}', 'Widget Root { }'));
        assert.deepEqual([diagnostic.code, diagnostic.line], [2017, 2], entry);
    }
});

test('emit: the event is an emit binding, its arguments are ordinary names, and `emit` alone is a handler', () => {
    const built = buildStructure(lines(
        'events { Picked(Number Index); Closed }',
        'Widget Root {',
        '    OnClicked -> emit Picked(Index)',
        '    OnHovered -> emit Picked(Base() + 1, @Gap)',
        '    OnPressed -> emit Closed',
        '    OnReleased -> emit',
        '    OnFocused -> Confirm',
        '}'));
    assert.deepEqual(built.diagnostics, []);
    assert.equal(built.roots[0].properties.length, 5);
    assert.deepEqual(built.bindings.map((b) => `${b.name}${b.isEmit ? ':emit' : ''}${b.isEvent ? ':event' : ''}${b.isVariable ? ':var' : ''}`),
        ['Picked:emit:event', 'Index:var', 'Picked:emit:event', 'Base', 'Closed:emit:event', 'emit:event', 'Confirm:event']);
    assert.deepEqual(built.resourceRefs.map((r) => r.name), ['Gap']);
});

test('slots: a declaration with a layout and a default, a fill of a component\'s slot, and DUI3022', () => {
    const built = buildStructure(lines(
        'style RowList { + VerticalBox { Spacing = 15 } }',
        'Widget Root {',
        '    Text Detail { }',
        '    slot Rows default : RowList {',
        '        + VerticalBox { Spacing = 15 }',
        '        RenderOpacity = 0.5',
        '        @slot SizeRule = Fill',
        '    }',
        '    slot Footer',
        '    ListPage Page_2 {',
        '        slot Detail { Text Note { } }',
        '    }',
        '    ListPage Page_3 {',
        '        slot Detail {',
        '            Text { }',
        '        }',
        '    }',
        '}'));
    // Two hosts filling their component's Detail and a widget called Detail besides: none is a duplicate id.
    assert.deepEqual(built.diagnostics, []);
    const [, rows, footer, page2, page3] = built.roots[0].children;
    assert.deepEqual([rows.kind, rows.defaultSlot, rows.fillsSlot, rows.styleName, rows.components.length, rows.properties.length],
        ['namedSlot', true, undefined, 'RowList', 1, 2]);
    assert.deepEqual([footer.defaultSlot, footer.fillsSlot], [undefined, undefined]);
    assert.deepEqual([page2.children[0].fillsSlot, page2.children[0].children[0].id], [true, 'Note']);
    assert.equal(page3.children[0].children[0].id, 'Page_3__Text0');

    const second = only(lines('Widget Root {', '    slot Rows default', '    slot Others default', '}'));
    assert.deepEqual([second.code, second.line, second.column, second.message],
        [3022, 3, 17, "slot 'Others' is a second default; 'Rows' on line 2 already is one"]);
});

test('DUI2019: a slot that both declares and fills, a default on a fill, default twice', () => {
    const both = only(lines('Widget Root {', '    slot Rows {', '        RenderOpacity = 0.5', '        Text T { }', '    }', '}'));
    assert.deepEqual([both.code, both.line], [2019, 4]);
    const fill = only(lines('Widget Root {', '    slot Detail default {', '        Text T { }', '    }', '}'));
    assert.deepEqual([fill.code, fill.line, fill.message],
        [2019, 2, "slot 'Detail' is filled here (it holds widgets), and 'default', a style or a rename belongs on the slot's declaration"]);
    const twice = only(lines('Widget Root {', '    slot Rows default default', '}'));
    assert.deepEqual([twice.code, twice.line, twice.message], [2019, 2, "slot 'Rows' says 'default' twice"]);
});

test('if / else if / else: one branch per arm, in place, else on the closing line or the next', () => {
    const source = lines(
        'Widget Root {',                               //  1
        '    if HasSave() {',                          //  2
        '        Text Continue { Text = "Continue" }', //  3
        '        Image Mark { }',                      //  4
        '    } else if Loading {',                     //  5
        '        Text Wait { }',                       //  6
        '    }',                                       //  7
        '    else {',                                  //  8
        '        Text NoSave { Shown <- Ready() }',    //  9
        '    }',                                       // 10
        '    Text After { }',                          // 11
        '}');                                          // 12
    const built = buildStructure(source);
    assert.deepEqual(built.diagnostics, []);
    const root = built.roots[0];
    assert.deepEqual(root.children.map((c) => `${c.kind}:${c.tag}:${c.condition ?? ''}`),
        ['branch:if:HasSave()', 'branch:else if:Loading', 'branch:else:', 'node:Text:']);
    // An `else if` is located at its `else`, as the compiler locates the Shown it makes.
    assert.deepEqual([root.children[1].line, root.children[1].column], [5, 7]);
    assert.equal(source.slice(root.children[0].conditionStart, root.children[0].conditionEnd), 'HasSave()');
    // The compiler's tree: every widget of every arm, in order, among the enclosing node's children.
    assert.deepEqual(loweredChildren(root).map((c) => c.id), ['Continue', 'Mark', 'Wait', 'NoSave', 'After']);
    assert.deepEqual(built.bindings.map((b) => `${b.name}${b.isCondition ? '?' : ''}`), ['HasSave?', 'Loading?', 'Ready']);
    assert.deepEqual(built.scopes.filter((s) => s.kind === 'branch').map((s) => s.name), ['if', 'else if', 'else']);
});

test('ids inside branches are ids of the enclosing node: a duplicate across arms is DUI3001', () => {
    assert.deepEqual(codes(lines('Widget Root {', '    if A {', '        Text T { }', '    } else {', '        Text t { }', '    }', '}')),
        [3001]);
});

test('DUI2018: what an if block cannot hold, an else with no if, an if with no condition, an if at the top', () => {
    const cases: [string[], number, string][] = [
        [['Widget Root {', '    Text Before { }', '    else {', '        Text A { }', '    }', '}'], 3, "this 'else' follows no 'if' block"],
        [['Widget Root {', '    if {', '        Text A { }', '    }', '}'], 2, "this 'if' has no condition before its '{'"],
        [['Widget Root {', '    if Ready() {', '        RenderOpacity = 0.5', '    }', '}'], 3,
            "'RenderOpacity' is a property, and an 'if' block holds widgets: put it on a widget inside the block"],
        [['Widget Root {', '    if Ready() {', '        slot Footer', '    }', '}'], 3,
            "only widgets can be shown and hidden by an 'if' block; a slot or a loop cannot sit in one"],
        [['Widget Root {', '    if Ready() {', '        for Item in Items {', '            Text T { }', '        }', '    }', '}'], 3,
            "only widgets can be shown and hidden by an 'if' block; a slot or a loop cannot sit in one"],
        [['Widget Root {', '    if Ready() {', '        Text A { }', '    } else Other', '}'], 4,
            "'else' is followed by its '{ ... }' block, or by 'if' and another condition"],
        [['Widget Root { }', 'if Ready() {', '    Text A { }', '}'], 2, "'if' chooses between the children of a node, so it belongs inside one"],
        [['Widget Root {', '    if Ready() {', '        @fill', '    }', '}'], 3,
            "'@slot SizeRule' is a slot line, and an 'if' block holds widgets: put it on a widget inside the block"],
        [['Widget Root {', '    if Ready() {', '        Text T { Shown <-> Visible }', '    }', '}'], 3,
            "'Shown <-> Visible' cannot sit in an 'if' block: the branch decides Shown, and a mirror would write that back into 'Visible'"],
    ];
    for (const [source, line, message] of cases) {
        const diagnostic = only(lines(...source));
        assert.deepEqual([diagnostic.code, diagnostic.line, diagnostic.message], [2018, line, message], source.join(' / '));
    }
    // A widget written with its own `Shown <-` keeps it -- ANDed by the compiler, nothing to say here.
    assert.deepEqual(codes(lines('Widget Root {', '    if Ready() {', '        Text T { Shown <- Busy() }', '    }', '}')), []);
});

test('the new words stay ordinary names wherever they do not lead their statement', () => {
    const built = buildStructure(lines(
        'Widget Root {',
        '    as = 1',
        '    props = 2',
        '    events = 3',
        '    emit = 4',
        '    default = 5',
        '    fill = 6',
        '    if = 7',
        '    else <- Other()',
        '    Text as { }',
        '    Text props { }',
        '    Text emit { }',
        '    Text if { }',
        '    Text else { }',
        '    Text default { }',
        '}'));
    assert.deepEqual(built.diagnostics, []);
    assert.equal(built.roots[0].properties.length, 8);
    assert.deepEqual(built.roots[0].children.map((c) => `${c.id}${c.anonymous ? '?' : ''}`),
        ['as', 'props', 'emit', 'if', 'else', 'default']);
    for (const word of CONTEXTUAL_KEYWORDS) {
        assert.equal(RESERVED_WORDS.has(word), false, word);
    }
});

test('a for takes a function or a variable, and two bindings may share a line', () => {
    const built = buildStructure(lines(
        'Widget Root {',
        '    for Option in GetOptions() {',
        '        Row { Label <- Option.Label  Kind <- Option.Kind }',
        '    }',
        '    for Entry in Entries {',
        '        Text Name { Text <- Entry.Name }',
        '    }',
        '}'));
    assert.deepEqual(built.diagnostics, []);
    const [byFunction, byVariable] = built.roots[0].children;
    assert.deepEqual([byFunction.loopSource, byFunction.loopSourceIsFunction], ['GetOptions', true]);
    assert.deepEqual([byVariable.loopSource, byVariable.loopSourceIsFunction], ['Entries', false]);
    assert.deepEqual(byFunction.children[0].properties.map((p) => p.path), ['Label', 'Kind']);
    assert.equal(byFunction.children[0].id, 'Root__Row0');
    assert.deepEqual(built.bindings.map((b) => b.name), ['Option.Label', 'Option.Kind', 'Entry.Name']);
});

test('so may assignments and one-line blocks: a value is one value, not the rest of the line', () => {
    const built = buildStructure('Widget Root {\n    + Scope { InputMode = Menu  bCloseOnBack = false }\n    A = 1  B = (2, 3)  C = "x" @key("K")\n}\n');
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.roots[0].properties.map((p) => p.path), ['A', 'B', 'C']);
    assert.deepEqual(built.roots[0].components[0].properties?.map((p) => p.path), ['InputMode', 'bCloseOnBack']);
});

test('a loop header still being typed keeps its body for the editor, out of the compiler\'s tree', () => {
    const built = buildStructure('Widget Root {\n    each Track in {\n        Text { }\n        Text T { }\n    }\n    Text T { }\n}\n');
    // The compiler steps over the block (DUI2010 is its to word): nothing inside is a duplicate of anything.
    assert.deepEqual(built.diagnostics, []);
    const loop = built.roots[0].children[0];
    assert.deepEqual([loop.kind, loop.refused, loop.children.length], ['loop', true, 2]);
    assert.deepEqual(loweredChildren(built.roots[0]).map((c) => c.id), ['T']);
    assert.equal(built.scopes.filter((s) => s.kind === 'loop').length, 1);
});

test('slot, for and each at the top of a file are stepped over whole, block and all', () => {
    assert.deepEqual(codes('Widget Root { }\nfor Item in GetItems() {\n    Text A { }\n}\n'), []);
});

test('a namespaced resource keeps its dots, and a node typed by a resource is a reference to it', () => {
    const built = buildStructure(lines(
        'use "Lib.dui" as nier',
        'Widget Root : nier.Card {',
        '    Color = @nier.Ink',
        '    @nier.Row R { }',
        '}'));
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.resourceRefs.map((r) => `${r.name}${r.nodeType ? ' (type)' : ''}`), ['nier.Ink', 'nier.Row (type)']);
    assert.deepEqual(built.namespaceRefs?.map((r) => `${r.kind}:${r.name}`), ['style:nier.Card', 'resource:nier.Ink', 'resource:nier.Row']);
    assert.equal(built.roots[0].styleName, 'nier.Card');
});

test('the kit fixtures say nothing a single file can settle but the imported styles', () => {
    const kit = path.join(__dirname, '..', '..', 'test', 'fixtures', 'Kit');
    for (const file of ['KitScreen.dui', 'KitNamespaced.dui', 'Components/KitRow.dui', 'Components/KitPanel.dui']) {
        const built = buildStructure(fs.readFileSync(path.join(kit, file), 'utf8'));
        assert.deepEqual(built.diagnostics.filter((d) => d.code !== 3004).map((d) => d.message), [], file);
    }
});
