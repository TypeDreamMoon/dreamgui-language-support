/**
 * `Widget Column { + VerticalBox { … } }` -> `VerticalBox Column { … }`: offered only where it builds the same widget,
 * and verified the way every edit here is -- apply it, re-parse, and read what the compiler would read.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import { containerTypeRewrites, layoutFactsFrom, LayoutFacts } from '../src/core/containerType';
import { applyRenameEdits } from '../src/core/rename';
import { judgeDocument } from '../src/core/diagnose';
import { duiStarter } from '../src/core/templates';

/** The shape of a real dump, cut down to what the rewrite asks about. */
const DUMP = {
    tags: {
        Widget: { kind: 'visual' },
        Text: { kind: 'visual', properties: [{ name: 'Text' }, { name: 'FontSize' }] },
        Overlay: { kind: 'container', properties: [{ name: 'Padding' }] },
        VerticalBox: { kind: 'container', properties: [{ name: 'Orientation' }, { name: 'Padding' }, { name: 'Spacing' }, { name: 'bUseAnimation' }] },
        HorizontalBox: { kind: 'container', properties: [{ name: 'Padding' }, { name: 'Spacing' }] },
    },
    widgetProperties: [{ name: 'AnchorData.SizeDelta' }, { name: 'AnchorData.AnchorMin' }, { name: 'RenderOpacity' }, { name: 'Shown' }],
};
const FACTS = layoutFactsFrom(DUMP)!;

function rewrite(source: string, facts: LayoutFacts | undefined = FACTS): string {
    const structure = buildStructure(source);
    return applyRenameEdits(source, containerTypeRewrites(structure, source, facts).flatMap((one) => one.edits));
}

function offered(source: string, facts: LayoutFacts | undefined = FACTS): string[] {
    const structure = buildStructure(source);
    return containerTypeRewrites(structure, source, facts).map((one) => `${one.container} ${one.id}`);
}

test('an empty container block goes, and takes one of the blank lines around it', () => {
    const source = [
        'Widget Root {',
        '    AnchorData.SizeDelta = (0, 0)',
        '',
        '    + Overlay {}',
        '',
        '    Text Title { Text = "Hi" }',
        '}',
        '',
    ].join('\n');
    assert.equal(rewrite(source), [
        'Overlay Root {',
        '    AnchorData.SizeDelta = (0, 0)',
        '',
        '    Text Title { Text = "Hi" }',
        '}',
        '',
    ].join('\n'));
});

test('a block over several lines leaves its lines where it stood, one level out, comments kept', () => {
    const source = [
        'Widget Root {',
        '    Widget Column {',
        '        @slot HorizontalAlignment = Fill',
        '',
        '        + VerticalBox {',
        '            // between the rows',
        '            Spacing = 10',
        '            Padding = (24, 28, 24, 28)',
        '        }',
        '',
        '        Text A { Text = "A" }',
        '    }',
        '}',
        '',
    ].join('\n');
    const result = rewrite(source);
    assert.equal(result, [
        'Widget Root {',
        '    VerticalBox Column {',
        '        @slot HorizontalAlignment = Fill',
        '',
        '        // between the rows',
        '        Spacing = 10',
        '        Padding = (24, 28, 24, 28)',
        '',
        '        Text A { Text = "A" }',
        '    }',
        '}',
        '',
    ].join('\n'));
    const column = buildStructure(result).roots[0].children[0];
    assert.equal(column.tag, 'VerticalBox');
    assert.deepEqual(column.components, []);
    assert.deepEqual(column.properties.filter((p) => !p.isSlot).map((p) => p.path), ['Spacing', 'Padding']);
    assert.deepEqual(buildStructure(result).diagnostics, buildStructure(source).diagnostics);
});

test('a one-line block becomes its statement, on the line the + was', () => {
    const source = 'Widget Root {\n    + HorizontalBox { Spacing = 16 }\n    Text A { }\n}\n';
    assert.equal(rewrite(source), 'HorizontalBox Root {\n    Spacing = 16\n    Text A { }\n}\n');
});

test('CRLF stays CRLF, with no lone carriage return left behind', () => {
    const source = 'Widget Root {\r\n    Shown = true\r\n\r\n    + Overlay {}\r\n\r\n    Text A { }\r\n}\r\n';
    const result = rewrite(source);
    assert.equal(result, 'Overlay Root {\r\n    Shown = true\r\n\r\n    Text A { }\r\n}\r\n');
    assert.equal((result.match(/\r(?!\n)/g) ?? []).length, 0);
});

test('an unnamed node is offered too, and a file with none of the long form is left alone', () => {
    assert.deepEqual(offered('Widget Root {\n    Widget {\n        + VerticalBox {}\n    }\n}\n'), ['VerticalBox ']);
    assert.deepEqual(offered('VerticalBox Root {\n    Spacing = 4\n}\n'), []);
});

test('without a symbols dump nothing is offered', () => {
    // Called directly: `undefined` into the helper would be its default, the facts.
    const source = 'Widget Root {\n    + Overlay {}\n}\n';
    assert.deepEqual(containerTypeRewrites(buildStructure(source), source, undefined), []);
    assert.equal(layoutFactsFrom(undefined), undefined);
    assert.equal(layoutFactsFrom({ tags: {}, widgetProperties: [] }), undefined);
});

test('refused: a block line the widget would take, or the container does not have', () => {
    const clash = layoutFactsFrom({ ...DUMP, widgetProperties: [...DUMP.widgetProperties, { name: 'Spacing' }] });
    assert.deepEqual(offered('Widget Root {\n    + VerticalBox {\n        Spacing = 4\n    }\n}\n', clash), []);
    assert.deepEqual(offered('Widget Root {\n    + VerticalBox {\n        Gap = 4\n    }\n}\n'), []);
});

test('refused: a bare line of the node or its style that the container would capture', () => {
    // `Padding` on a Widget node reaches a behaviour (or nothing) today; on a VerticalBox it would reach the container.
    assert.deepEqual(offered('Widget Root {\n    Padding = 4\n    + VerticalBox {}\n}\n'), []);
    assert.deepEqual(offered('style S {\n    Padding = 4\n}\nWidget Root : S {\n    + VerticalBox {}\n}\n'), []);
    // A widget property stays the widget's either way.
    assert.deepEqual(offered('Widget Root {\n    AnchorData.SizeDelta = (1, 1)\n    + VerticalBox {}\n}\n'), ['VerticalBox Root']);
});

test('refused: anything that would move the container in creation order', () => {
    assert.deepEqual(offered('Widget Root {\n    + UIButton {}\n    + VerticalBox {}\n}\n'), []);
    assert.deepEqual(offered('style S {\n    + UIButton {}\n}\nWidget Root : S {\n    + VerticalBox {}\n}\n'), []);
    assert.deepEqual(offered('use "Lib.dui"\nWidget Root : Imported {\n    + VerticalBox {}\n}\n'), []);
    // A component after the container keeps its place.
    assert.deepEqual(offered('Widget Root {\n    + VerticalBox {}\n    + UIButton {}\n}\n'), ['VerticalBox Root']);
    // Two containers is DUI5022 already; not this hint's business.
    assert.deepEqual(offered('Widget Root {\n    + VerticalBox {}\n    + HorizontalBox {}\n}\n'), []);
});

test('refused: a block whose text cannot be moved untouched', () => {
    assert.deepEqual(offered('Widget Root {\n    + VerticalBox {\n        /* rows */ Spacing = 4\n    }\n}\n'), []);
    assert.deepEqual(offered('Widget Root {\n    + VerticalBox {\n        Spacing <- Gap()\n    }\n}\n'), []);
    assert.deepEqual(offered('Widget Root { + Overlay {} }\n'), []);
    assert.deepEqual(offered('Widget Root {\n    + VerticalBox { // note\n        Spacing = 4\n    }\n}\n'), []);
    assert.deepEqual(offered('Text Root {\n    + VerticalBox {}\n}\n'), []);
});

test('judgeDocument gives it as a hint on `Widget`, and only with the facts', () => {
    const text = 'Widget Root {\n    + Overlay {}\n}\n';
    const with_ = judgeDocument({ file: 'x.dui', text, layoutFacts: FACTS }).filter((d) => d.severity === 'hint');
    assert.equal(with_.length, 1);
    assert.equal(text.slice(with_[0].start, with_[0].end), 'Widget');
    assert.equal(with_[0].code, undefined);
    assert.match(with_[0].message, /'Overlay Root \{ … \}'/);
    assert.deepEqual(judgeDocument({ file: 'x.dui', text }).filter((d) => d.severity === 'hint'), []);
});

test('the starter a new file gets is already in the short form, and parses clean', () => {
    const starter = duiStarter('Menu.dui', '/Game/UI/WBP_Menu', 'WBP_Menu');
    assert.match(starter, /^Overlay Root \{$/m);
    assert.doesNotMatch(starter, /\+ Overlay/);
    assert.deepEqual(buildStructure(starter).diagnostics, []);
    assert.deepEqual(offered(starter), []);
});
