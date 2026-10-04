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

test('an @ run in value position is a resource reference', () => {
    expectContext('    Brush.TintColor = @', { kind: 'resourceRef' });
    expectContext('    Brush.TintColor = @Acc', { kind: 'resourceRef' });
    expectContext('    Text <- @Bra', { kind: 'resourceRef' });
});

test('an @ leading a statement is an annotation: @slot, @fill, an Asset resource as a type', () => {
    expectContext('    @', { kind: 'annotation' });
    expectContext('    @sl', { kind: 'annotation' });
    expectContext('    Text LabelText : Label { @fi', { kind: 'annotation' });
});

test('@ns. names a namespace, and what follows is one of its resources', () => {
    expectContext('    Color = @nier.', { kind: 'resourceRef', namespace: 'nier' });
    expectContext('    Color = @nier.In', { kind: 'resourceRef', namespace: 'nier' });
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

test('a one-line block: the statement after its last brace', () => {
    expectContext('    + UIButton { TransitionType = No', { kind: 'value', property: 'TransitionType', isSlot: false });
    expectContext('    @slot { SizeRule = Fi', { kind: 'value', property: 'SizeRule', isSlot: true });
    expectContext('    @slot { SizeRule = Fill  Pad', { kind: 'slotPropertyName' });
    expectContext('    Text T : Label { Text = "Re', { kind: 'value', property: 'Text', isSlot: false });
});

test('style clauses through a namespace', () => {
    expectContext('    Text T : nier.', { kind: 'styleRef', namespace: 'nier' });
    expectContext('    Text T : nier.La', { kind: 'styleRef', namespace: 'nier' });
});

test('binding expressions: <-, <->, a condition, a loop source, emit arguments', () => {
    expectContext('    Text <- ', { kind: 'expression', op: '<-' });
    // The '==' of an expression is no '=' of a value.
    expectContext('    Shown <- Count() == Ma', { kind: 'expression', op: '<-' });
    expectContext('    Value <-> Vol', { kind: 'expression', op: '<->' });
    expectContext('    if Has', { kind: 'expression', op: 'if' });
    expectContext('    if ', { kind: 'expression', op: 'if' });
    expectContext('    } else if !IsLo', { kind: 'expression', op: 'if' });
    expectContext('    for Item in Get', { kind: 'expression', op: 'in' });
    expectContext('    OnClick -> emit Picked(Ind', { kind: 'expression', op: 'emit' });
});

test('after ->: a handler or emit, then after emit one of the file\'s events', () => {
    expectContext('    OnClicked -> ', { kind: 'route' });
    expectContext('    OnClicked -> em', { kind: 'route' });
    expectContext('    OnClicked -> emit ', { kind: 'emitTarget' });
    expectContext('    OnClicked -> emit Pi', { kind: 'emitTarget' });
});

test('keywords where the grammar makes them keywords, and only there', () => {
    expectContext('use "UI/Lib.dui" ', { kind: 'keyword', words: ['as'] });
    expectContext('use /Game/UI/WBP_Slider a', { kind: 'keyword', words: ['as'] });
    expectContext('    slot Rows ', { kind: 'keyword', words: ['default'] });
    expectContext('    for Item ', { kind: 'keyword', words: ['in'] });
    expectContext('    each Item i', { kind: 'keyword', words: ['in'] });
    expectContext('    } ', { kind: 'keyword', words: ['else'] });
    expectContext('    } el', { kind: 'keyword', words: ['else'] });
    expectContext('    } else ', { kind: 'keyword', words: ['if'] });
    expectContext('    else ', { kind: 'keyword', words: ['if'] });
    // A property named `if` is still a property.
    expectContext('    if = ', { kind: 'value', property: 'if', isSlot: false });
});

test('a name being chosen completes nothing: an id, an alias, a use path', () => {
    expectContext('    Text ', { kind: 'nodeId' });
    expectContext('    Text Ti', { kind: 'nodeId' });
    expectContext('    Native.Button Ok', { kind: 'nodeId' });
    expectContext('    nier.Row Au', { kind: 'nodeId' });
    expectContext('    Text Label', { kind: 'nodeId' }); // a props line's name, too
    expectContext('use ', { kind: 'nodeId' });
    expectContext('use "UI/Ro', { kind: 'nodeId' });
    expectContext('use "UI/Lib.dui" as ', { kind: 'nodeId' });
    // A plugin path's ':' is no style clause.
    expectContext('use "Plugin.Mine:Pan', { kind: 'nodeId' });
});

test('slot names, event parameters and dotted heads', () => {
    expectContext('    slot ', { kind: 'slotName' });
    expectContext('    slot De', { kind: 'slotName' });
    expectContext('    Picked(', { kind: 'eventParam', position: 'type' });
    expectContext('    Picked(Number ', { kind: 'eventParam', position: 'name' });
    expectContext('    Picked(Number Index, ', { kind: 'eventParam', position: 'type' });
    expectContext('    Picked(Number Index, Bo', { kind: 'eventParam', position: 'type' });
    expectContext('    nier.', { kind: 'dotted', head: 'nier' });
    expectContext('    nier.Ro', { kind: 'dotted', head: 'nier' });
    expectContext('    Native.', { kind: 'dotted', head: 'Native' });
    expectContext('    AnchorData.Si', { kind: 'dotted', head: 'AnchorData' });
});

test('everything else is statement position', () => {
    expectContext('    HAl', { kind: 'statement' });
    expectContext('    Text Title {', { kind: 'statement' });
    expectContext('', { kind: 'statement' });
    // Mid-tuple: the value regex wants a spaceless tail, so this stays statement -- no enum
    // completion popping inside '(0, '.
    expectContext('    Padding = (0, ', { kind: 'statement' });
});
