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
