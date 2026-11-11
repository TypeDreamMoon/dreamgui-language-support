/**
 * `@slot Size = (w, h)`: the front end's shorthand for MinDesiredSize and MaxDesiredSize with one value. The extension
 * reads it as the slot line it is and offers the name in completion; the expansion is the compiler's.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import { slotPropertyOffers } from '../src/core/symbolFacts';

test('@slot Size is offered with the dump\'s slot properties, once, and never when the dump has its own', () => {
    const listed = [{ name: 'SizeRule', type: 'EDreamSizeRule' }, { name: 'Padding', type: 'FMargin' }];
    const offers = slotPropertyOffers(listed);
    assert.deepEqual(offers.map((info) => info.name), ['SizeRule', 'Padding', 'Size']);
    assert.match(offers[2].tooltip!, /MinDesiredSize and MaxDesiredSize/);
    assert.deepEqual(slotPropertyOffers(undefined).map((info) => info.name), ['Size']);
    assert.deepEqual(slotPropertyOffers([{ name: 'size', type: 'FVector2D' }]).map((info) => info.name), ['size']);
});

test('@slot Size = (w, h) reads as an ordinary slot line, one-line and in a block, in a node and in a style', () => {
    const source = [
        'style Fixed {',
        '    @slot Size = (64, 64)',
        '}',
        'Widget Root {',
        '    Image A { @slot Size = (120, 48) }',
        '    Image B {',
        '        @slot { Size = (120, 48)  Padding = (4, 0, 4, 0) }',
        '    }',
        '}',
        '',
    ].join('\n');
    const built = buildStructure(source);
    assert.deepEqual(built.diagnostics, []);
    const sizes = [built.styles[0].properties, ...built.roots[0].children.map((child) => child.properties)]
        .flat().filter((stmt) => stmt.path === 'Size');
    assert.equal(sizes.length, 3);
    assert.ok(sizes.every((stmt) => stmt.isSlot && stmt.op === 'equals'));
    assert.deepEqual(sizes.map((stmt) => source.slice(stmt.valueStart, stmt.valueEnd)), ['(64, 64)', '(120, 48)', '(120, 48)']);
});
