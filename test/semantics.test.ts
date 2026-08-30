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
