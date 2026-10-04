/**
 * The symbols dump, old and new: what the current plugin writes is taken as it is, and what an older plugin's dump
 * leaves out -- container node types, `Shown`, the keyword tables -- is supplied, so completion answers the same
 * questions against both.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    normalizeSymbols, nodeTypeNames, isContainerType, propertiesForTag, tailsAfter,
} from '../src/core/symbolFacts';
import { CONTAINER_TYPES, KEYWORDS, PROP_TYPES } from '../src/core/vocabulary';

/** The shape the plugin wrote before kinds, containers, keywords and propTypes existed. */
const OLD_DUMP = {
    version: 1,
    tags: {
        Widget: {},
        Text: { class: 'DreamText', properties: [{ name: 'FontSize', type: 'float' }, { name: 'Color', type: 'FLinearColor' }] },
        'Native.Button': { class: 'DreamButton', properties: [], events: ['OnClicked'] },
    },
    widgetProperties: [{ name: 'Visibility', type: 'EDreamVisibility', enum: 'EDreamVisibility' },
        { name: 'Color', type: 'FLinearColor', tooltip: 'the widget\'s' }],
    widgetEvents: [],
    slotProperties: [{ name: 'SizeRule', type: 'EDreamSizeRule', enum: 'EDreamSizeRule' }],
    components: {
        VerticalBox: { class: 'DreamLayoutContainerVerticalBox', properties: [{ name: 'Spacing', type: 'float' }] },
        UIButton: { class: 'UIButton', properties: [{ name: 'TransitionType', type: 'ETransition' }] },
    },
    enums: { EDreamSizeRule: { values: ['Auto', 'Fill'] } },
    resourceTypes: ['Color', 'Number', 'Vector2', 'String', 'Asset'],
};

/** The current plugin's shape (DreamUISymbolExport.cpp): every tag has a kind, containers are tags. */
const NEW_DUMP = {
    version: 1,
    tags: {
        Text: { kind: 'visual', class: 'DreamText', properties: [{ name: 'FontSize', type: 'float' }] },
        'Native.Button': { kind: 'widget', class: 'DreamButton', properties: [], events: ['OnClicked'] },
        VerticalBox: { kind: 'container', class: 'DreamLayoutContainerVerticalBox',
            properties: [{ name: 'Spacing', type: 'float' }, { name: 'Padding', type: 'FMargin', literal: 'tuple4' }] },
    },
    keywords: ['class', 'use', 'as', 'emit'],
    annotations: ['slot', 'fill', 'key'],
    widgetProperties: [{ name: 'Shown', type: 'bool', tooltip: 'Visibility as a yes or no' }],
    widgetEvents: [],
    slotProperties: [],
    components: { UIButton: { class: 'UIButton' } },
    enums: {},
    resourceTypes: ['Color'],
    propTypes: ['Text', 'Number', 'Enum'],
};

test('an old dump gets kinds, its containers as node types, Shown and the keyword tables', () => {
    const data = normalizeSymbols(OLD_DUMP);
    assert.equal(data.tags.Text.kind, 'visual');
    assert.equal(data.tags['Native.Button'].kind, 'widget');
    // The component's properties are the container node type's own.
    assert.equal(data.tags.VerticalBox.kind, 'container');
    assert.deepEqual(data.tags.VerticalBox.properties?.map((p) => p.name), ['Spacing']);
    // A container the dump never listed is still a type the language has.
    for (const name of CONTAINER_TYPES) {
        assert.equal(data.tags[name]?.kind, 'container', name);
    }
    assert.ok(data.widgetProperties.some((p) => p.name === 'Shown' && p.type === 'bool'));
    assert.deepEqual(data.keywords, [...KEYWORDS]);
    assert.deepEqual(data.propTypes, [...PROP_TYPES]);
    assert.deepEqual(data.annotations, ['slot', 'fill', 'key']);
    // What the old dump did say is kept as it was.
    assert.deepEqual(data.slotProperties, OLD_DUMP.slotProperties);
    assert.deepEqual(data.enums, OLD_DUMP.enums);
});

test('a new dump is taken as it is: no invented containers, no second Shown, its own tables', () => {
    const data = normalizeSymbols(NEW_DUMP);
    assert.deepEqual(Object.keys(data.tags), ['Text', 'Native.Button', 'VerticalBox']);
    assert.equal(data.widgetProperties.filter((p) => p.name === 'Shown').length, 1);
    assert.equal(data.widgetProperties[0].tooltip, 'Visibility as a yes or no');
    assert.deepEqual(data.keywords, ['class', 'use', 'as', 'emit']);
    assert.deepEqual(data.propTypes, ['Text', 'Number', 'Enum']);
    assert.deepEqual(data.resourceTypes, ['Color']);
});

test('nonsense in, an empty but usable dump out', () => {
    const data = normalizeSymbols({ tags: 'nope', widgetProperties: null });
    assert.deepEqual(data.widgetProperties.map((p) => p.name), ['Shown']);
    assert.ok(isContainerType(data, 'VerticalBox'));
    assert.deepEqual(data.components, {});
    assert.equal(normalizeSymbols(undefined).version, 1);
});

test('a container-typed node reaches the widget first, then its container, a shared name once', () => {
    const data = normalizeSymbols({
        ...NEW_DUMP,
        widgetProperties: [{ name: 'Padding', type: 'FMargin', tooltip: 'the widget\'s own' }],
    });
    const list = propertiesForTag(data, 'VerticalBox');
    assert.deepEqual(list.map((p) => p.name), ['Padding', 'Shown', 'Spacing']);
    // "A name the widget and the container both have means the widget's."
    assert.equal(list.find((p) => p.name === 'Padding')?.tooltip, 'the widget\'s own');
    assert.deepEqual(propertiesForTag(data, 'NoSuchTag').map((p) => p.name), ['Padding', 'Shown']);
    assert.deepEqual(propertiesForTag(undefined, 'Text'), []);
});

test('node types carry their kind; with no dump the containers are still offered', () => {
    const kinds = Object.fromEntries(nodeTypeNames(normalizeSymbols(NEW_DUMP)).map((t) => [t.name, t.kind]));
    assert.deepEqual(kinds, { Text: 'visual', 'Native.Button': 'widget', VerticalBox: 'container' });
    assert.deepEqual(nodeTypeNames(undefined).map((t) => t.name), [...CONTAINER_TYPES]);
    assert.ok(isContainerType(undefined, 'Overlay'));
    assert.ok(!isContainerType(normalizeSymbols(NEW_DUMP), 'Text'));
});

test('after a dot, what follows it: a word never holds a dot, so an item spelled whole would double the head', () => {
    const entries = [{ name: 'AnchorData.SizeDelta' }, { name: 'AnchorData.Pivot' }, { name: 'Native.Button' }, { name: 'Anchor' }];
    assert.deepEqual(tailsAfter(entries, 'AnchorData').map((t) => t.tail), ['SizeDelta', 'Pivot']);
    assert.deepEqual(tailsAfter(entries, 'native').map((t) => t.tail), ['Button']);
    assert.deepEqual(tailsAfter(entries, 'Anchor'), []);
});
