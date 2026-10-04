/**
 * The identity layer: which word is a widget id, a style, a resource, a function. Snapshot-style
 * over a sample that exercises every span kind, asserting text + type + modifiers -- if a span
 * lands on the wrong word, the sliced text betrays it immediately.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import { collectSemanticSpans } from '../src/core/semantics';

const SAMPLE = `class /Game/UI/WBP_X

style Label {
    FontSize = 18
}
style Danger : Label {
}

resources {
    Color Accent = #F00
}

Widget Root {
    + Overlay {}

    Text Title : Danger {
        Brush.TintColor = @Accent
        Text <- GetTitle()
        OnClicked -> Confirm
    }

    slot Footer

    for Row in GetRows() {
        Text RowLabel {}
    }
}
`;

test('every span kind lands on its word', () => {
    const structure = buildStructure(SAMPLE);
    const spans = collectSemanticSpans(structure).map((span) => ({
        text: SAMPLE.slice(span.start, span.start + span.length),
        type: span.type,
        modifiers: span.modifiers.join(','),
    }));

    assert.deepEqual(spans, [
        { text: 'Label', type: 'class', modifiers: 'declaration' },
        { text: 'Danger', type: 'class', modifiers: 'declaration' },
        { text: 'Label', type: 'class', modifiers: '' },
        { text: 'Accent', type: 'variable', modifiers: 'declaration,readonly' },
        { text: 'Root', type: 'variable', modifiers: 'declaration' },
        { text: 'Overlay', type: 'type', modifiers: '' },
        { text: 'Title', type: 'variable', modifiers: 'declaration' },
        { text: 'Danger', type: 'class', modifiers: '' },
        { text: 'Accent', type: 'variable', modifiers: 'readonly' },
        { text: 'GetTitle', type: 'function', modifiers: '' },
        { text: 'OnClicked', type: 'event', modifiers: '' },
        { text: 'Confirm', type: 'function', modifiers: '' },
        { text: 'Footer', type: 'variable', modifiers: 'declaration' },
        { text: 'Row', type: 'parameter', modifiers: 'declaration' },
        { text: 'RowLabel', type: 'variable', modifiers: 'declaration' },
    ]);
});

test('bindings carry their sides for other consumers too', () => {
    const structure = buildStructure(SAMPLE);
    assert.deepEqual(structure.bindings.map((b) => `${b.isEvent ? '->' : '<-'} ${b.name}`),
        ['<- GetTitle', '-> Confirm']);
    const event = structure.bindings.find((b) => b.isEvent)!;
    assert.equal(SAMPLE.slice(event.pathStart, event.pathEnd), 'OnClicked');
});

// ---- expressions, <-> and each: the identity of every name on an arrow's right ------------------

const EXPRESSION_SAMPLE = `Widget Root {
    + UIRecyclableScrollView {}

    Slider Vol {
        Value <-> Volume
        Enabled <- !IsBusy() && Count() > Base
    }

    each Item in Rows {
        Text Cell {
            Text <- Item.Title
        }
    }
}
`;

test('expression names colour by what they are: calls functions, bare names variables', () => {
    const structure = buildStructure(EXPRESSION_SAMPLE);
    assert.deepEqual(structure.diagnostics, []);
    const spans = collectSemanticSpans(structure).map((span) => ({
        text: EXPRESSION_SAMPLE.slice(span.start, span.start + span.length),
        type: span.type,
    }));

    assert.deepEqual(spans.filter((span) => span.text === 'Volume'), [{ text: 'Volume', type: 'variable' }]);
    assert.deepEqual(spans.filter((span) => span.text === 'IsBusy'), [{ text: 'IsBusy', type: 'function' }]);
    assert.deepEqual(spans.filter((span) => span.text === 'Count'), [{ text: 'Count', type: 'function' }]);
    assert.deepEqual(spans.filter((span) => span.text === 'Base'), [{ text: 'Base', type: 'variable' }]);
});

test('Item.Title splits: the loop variable is the parameter it declares, the member a variable', () => {
    const structure = buildStructure(EXPRESSION_SAMPLE);
    const spans = collectSemanticSpans(structure).map((span) => ({
        text: EXPRESSION_SAMPLE.slice(span.start, span.start + span.length),
        type: span.type,
        modifiers: span.modifiers.join(','),
    }));

    // The declaration in the loop header, then the use inside the binding expression.
    assert.deepEqual(spans.filter((span) => span.text === 'Item'), [
        { text: 'Item', type: 'parameter', modifiers: 'declaration' },
        { text: 'Item', type: 'parameter', modifiers: '' },
    ]);
    assert.deepEqual(spans.filter((span) => span.text === 'Title'),
        [{ text: 'Title', type: 'variable', modifiers: '' }]);
});

test('the same name outside its loop stays a plain variable', () => {
    const outside = 'Widget Root {\n    Text T {\n        Text <- Item.Title\n    }\n}\n';
    const spans = collectSemanticSpans(buildStructure(outside));
    const item = spans.find((span) => outside.slice(span.start, span.start + span.length) === 'Item.Title');
    assert.ok(item, 'the dotted ref outside a loop is one span');
    assert.equal(item!.type, 'variable');
});

// ---- the component grammar: aliases, namespaces, props, events, emit ----------------------------

const COMPONENT_SAMPLE = `use "UI/Row.dui" as Row
use "UI/Lib.dui" as ui

props {
    Text Label
    Number Index = 0
}
events {
    Picked(Number Index)
}

Widget Root : ui.Card {
    Row Item { Label = "x" }
    ui.Row Other {}
    HorizontalBox {
        Text { Text <- Label }
    }
    Text T {
        Color = @ui.Ink
    }
    Native.Button B { OnClicked -> emit Picked(Index) }
}
`;

function spansOf(source: string, context = {}) {
    return collectSemanticSpans(buildStructure(source), context).map((span) => ({
        text: source.slice(span.start, span.start + span.length),
        type: span.type,
        modifiers: span.modifiers.join(','),
    }));
}

test('a use … as name is a type for a component, a namespace when the file writes it with a dot', () => {
    const spans = spansOf(COMPONENT_SAMPLE);
    const declarations = spans.filter((span) => span.modifiers === 'declaration'
        && (span.text === 'Row' || span.text === 'ui'));
    assert.deepEqual(declarations, [
        { text: 'Row', type: 'type', modifiers: 'declaration' },
        { text: 'ui', type: 'namespace', modifiers: 'declaration' },
    ]);
});

test('a namespaced name splits: the head a namespace, the tail what it names', () => {
    const spans = spansOf(COMPONENT_SAMPLE);
    assert.deepEqual(spans.filter((span) => span.text === 'ui' && span.modifiers === ''),
        [{ text: 'ui', type: 'namespace', modifiers: '' }, { text: 'ui', type: 'namespace', modifiers: '' },
            { text: 'ui', type: 'namespace', modifiers: '' }]);
    assert.ok(spans.some((span) => span.text === 'Card' && span.type === 'class'), 'the style after ui.');
    assert.ok(spans.some((span) => span.text === 'Ink' && span.type === 'variable' && span.modifiers === 'readonly'),
        'the resource after @ui.');
    // `Row` as a type: the alias on its own and the tail of ui.Row.
    assert.equal(spans.filter((span) => span.text === 'Row' && span.type === 'type' && span.modifiers === '').length, 2);
});

test('props are properties and events are events, declared and used', () => {
    const spans = spansOf(COMPONENT_SAMPLE);
    assert.deepEqual(spans.filter((span) => span.type === 'property'), [
        { text: 'Label', type: 'property', modifiers: 'declaration' },
        { text: 'Index', type: 'property', modifiers: 'declaration' },
        { text: 'Label', type: 'property', modifiers: '' },
        { text: 'Index', type: 'property', modifiers: '' },
    ]);
    assert.deepEqual(spans.filter((span) => span.text === 'Picked'), [
        { text: 'Picked', type: 'event', modifiers: 'declaration' },
        { text: 'Picked', type: 'event', modifiers: '' },
    ]);
});

test('an unnamed node has no id to colour', () => {
    const spans = spansOf(COMPONENT_SAMPLE);
    assert.ok(!spans.some((span) => span.text === 'HorizontalBox'));
    assert.ok(!spans.some((span) => span.text.startsWith('Root__')));
});

test('the workspace can say an alias is a namespace the text never dots', () => {
    const source = 'use "UI/Lib.dui" as ui\n\nWidget Root {\n}\n';
    assert.deepEqual(spansOf(source).filter((span) => span.text === 'ui'),
        [{ text: 'ui', type: 'type', modifiers: 'declaration' }]);
    assert.deepEqual(spansOf(source, { namespaces: ['UI'] }).filter((span) => span.text === 'ui'),
        [{ text: 'ui', type: 'namespace', modifiers: 'declaration' }]);
});

test('a re-exported alias the workspace names is a type here too', () => {
    const source = 'use "UI/Lib.dui"\n\nWidget Root {\n    Row A {}\n}\n';
    assert.ok(!spansOf(source).some((span) => span.text === 'Row'));
    assert.deepEqual(spansOf(source, { aliases: ['Row'] }).filter((span) => span.text === 'Row'),
        [{ text: 'Row', type: 'type', modifiers: '' }]);
});

test('a loop variable shadows a prop of the same name', () => {
    const source = 'props {\n    Text Item\n}\nWidget Root {\n    for Item in Items {\n        Text T { Text <- Item.Name }\n    }\n}\n';
    const spans = spansOf(source);
    const inLoop = source.indexOf('Item.Name');
    const use = collectSemanticSpans(buildStructure(source)).find((span) => span.start === inLoop)!;
    assert.equal(use.type, 'parameter');
    assert.ok(spans.some((span) => span.text === 'Item' && span.type === 'property' && span.modifiers === 'declaration'));
});
