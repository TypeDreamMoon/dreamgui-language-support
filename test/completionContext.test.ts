/**
 * The line-context judgement, against the spellings people actually write -- the aligned ones
 * from the real SettingsPanel included, because alignment is exactly what the broken character
 * class silently mishandled.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { analyzeLine, LineContext } from '../src/core/completionContext';

function expectContext(line: string, expected: LineContext): void {
    assert.deepEqual(analyzeLine(line), expected, JSON.stringify(line));
}

test('values, aligned or not, dotted or not', () => {
    expectContext('    FontSize = 1', { kind: 'value', property: 'FontSize', isSlot: false });
    expectContext('    HAlign   = Ce', { kind: 'value', property: 'HAlign', isSlot: false });
    expectContext('    HAlign   = ', { kind: 'value', property: 'HAlign', isSlot: false });
    expectContext('    Brush.TintColor = #F0', { kind: 'value', property: 'Brush.TintColor', isSlot: false });
    expectContext('    字号 = ', { kind: 'value', property: '字号', isSlot: false });
});

test('@slot values carry the property, not the directive', () => {
    expectContext('    @slot SizeRule = Au', { kind: 'value', property: 'SizeRule', isSlot: true });
    expectContext('        @slot HorizontalAlignment = Fi', { kind: 'value', property: 'HorizontalAlignment', isSlot: true });
    expectContext('    @slot Padding  = ', { kind: 'value', property: 'Padding', isSlot: true });
});

test('an @ run at the tail is a resource reference, wherever it stands', () => {
    expectContext('    Brush.TintColor = @', { kind: 'resourceRef' });
    expectContext('    Brush.TintColor = @Acc', { kind: 'resourceRef' });
    expectContext('    @', { kind: 'resourceRef' });
    expectContext('    @sl', { kind: 'resourceRef' });
});

test('the @slot property-name position is not a resource reference', () => {
    expectContext('    @slot ', { kind: 'slotPropertyName' });
    expectContext('    @slot Si', { kind: 'slotPropertyName' });
});

test('component names, plain and script-path spelled', () => {
    expectContext('    + ', { kind: 'componentName' });
    expectContext('    + Vert', { kind: 'componentName' });
    expectContext('    + /Script/DreamGUI.UIBut', { kind: 'componentName' });
});

test('style clauses on headers, node and style alike', () => {
    expectContext('    Text Title : ', { kind: 'styleRef' });
    expectContext('    Text Title : Lab', { kind: 'styleRef' });
    expectContext('style Danger : ', { kind: 'styleRef' });
});

test('everything else is statement position', () => {
    expectContext('    HAl', { kind: 'statement' });
    expectContext('    Text Title {', { kind: 'statement' });
    expectContext('', { kind: 'statement' });
    // Mid-tuple: the value regex wants a spaceless tail, so this stays statement -- no enum
    // completion popping inside '(0, '.
    expectContext('    Padding = (0, ', { kind: 'statement' });
});
