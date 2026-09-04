/**
 * What the cursor is standing in, inside a binding expression. Every case here is a spelling the
 * corpus writes or a half-typed line on the way to one -- the point of the layer is that it
 * answers WHILE the line is wrong, so a finished line is the least interesting test in the file.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import {
    bindingTailOf, callContextAt, memberPrefixAt, parseEachSource, eachScopesOf, eachScopeNamed,
    enclosingEachScopes, signatureLabelOf, findByName, isIdentifier,
} from '../src/core/bindingIntel';

test('the arrow is found at the tail, and the three-character one wins its own prefix', () => {
    assert.deepEqual(bindingTailOf('    Text <- GetNowPlaying()')?.op, '<-');
    assert.deepEqual(bindingTailOf('    bIsOn <-> bMuted')?.op, '<->');
    assert.deepEqual(bindingTailOf('    OnClicked -> Confirm')?.op, '->');
    assert.equal(bindingTailOf('    AnchorData.SizeDelta = (420, 52)'), undefined);
});

test('the tail is everything after the arrow, from where the caller cut the line', () => {
    const tail = bindingTailOf('    Text <- Fmt(A, ')!;
    assert.equal(tail.tail, ' Fmt(A, ');
    assert.equal('    Text <- Fmt(A, '.slice(tail.tailStart), tail.tail);
});

test('an arrow inside a string or a comment is prose, not a binding', () => {
    // Straight out of MediaConsole.dui, where the tooltip documents the syntax it demonstrates.
    assert.equal(
        bindingTailOf('    ToolTipText = "RenderOpacity <- MasterVolume: a variable, into a float."'),
        undefined);
    assert.equal(bindingTailOf('    Value = 3 // was Value <- GetValue()'), undefined);
    // ...but a real binding whose ARGUMENT is a string still is one.
    assert.equal(bindingTailOf('    Text <- Fmt("a <- b", ')?.op, '<-');
});

test('the call the cursor is an argument of, and which argument', () => {
    assert.deepEqual(callContextAt(' Fmt('), { name: 'Fmt', argIndex: 0 });
    assert.deepEqual(callContextAt(' Fmt(A, '), { name: 'Fmt', argIndex: 1 });
    assert.deepEqual(callContextAt(' Fmt(A, B, C'), { name: 'Fmt', argIndex: 2 });
    // Nested: the innermost open call owns the cursor.
    assert.deepEqual(callContextAt(' Fmt(A, Inner(x, '), { name: 'Inner', argIndex: 1 });
    // A closed call is behind the cursor, not around it.
    assert.equal(callContextAt(' Fmt(A) * 2'), undefined);
    assert.equal(callContextAt(' MasterVolume'), undefined);
});

test('a bare paren groups, it does not call -- its commas are its own', () => {
    // `(1 + 2` is a subexpression; the cursor is still Fmt's second argument.
    assert.deepEqual(callContextAt(' Fmt(A, (1 + '), { name: 'Fmt', argIndex: 1 });
    // A tuple with nothing in front of it belongs to no call at all.
    assert.equal(callContextAt(' (420, '), undefined);
});

test('a member run at the tail, and one hop only', () => {
    assert.deepEqual(memberPrefixAt(' Track.Ti'), { base: 'Track', typed: 'Ti', baseStart: 1 });
    assert.deepEqual(memberPrefixAt(' Track.')?.typed, '');
    assert.equal(memberPrefixAt(' Track'), undefined);
    // A longer chain leaves the LAST segment as the base, which matches no loop variable --
    // offering nothing is the right answer until chained members exist.
    assert.equal(memberPrefixAt(' Track.Sub.')?.base, 'Sub');
});

test('an each source is a call or a variable, the two shapes the parser accepts', () => {
    assert.deepEqual(parseEachSource('GetHistory()'), { kind: 'call', name: 'GetHistory' });
    assert.deepEqual(parseEachSource('Tracks'), { kind: 'variable', name: 'Tracks' });
    assert.deepEqual(parseEachSource(' GetHistory ( ) '), { kind: 'call', name: 'GetHistory' });
    assert.equal(parseEachSource(''), undefined);
});

const NESTED = [
    'class /Game/UI/WBP_X',
    '',
    'Widget Root {',
    '    each Track in Tracks {',
    '        Text Title {',
    '            Text <- Track.Title',
    '        }',
    '        each Tag in GetTags() {',
    '            Text TagText {',
    '                Text <- Tag.Label',
    '            }',
    '        }',
    '    }',
    '}',
    '',
].join('\n');

test('every each is found, with the source expression the structure layer walks past', () => {
    const scopes = eachScopesOf(buildStructure(NESTED), NESTED);
    assert.deepEqual(scopes.map((scope) => [scope.variable, scope.sourceText]),
        [['Track', 'Tracks'], ['Tag', 'GetTags()']]);
    assert.deepEqual(scopes.map((scope) => NESTED.slice(scope.sourceStart, scope.sourceEnd).trim()),
        ['Tracks', 'GetTags()']);
});

test('scope is by body span, and the inner loop shadows the outer', () => {
    const structure = buildStructure(NESTED);
    const scopes = eachScopesOf(structure, NESTED);

    const inInner = NESTED.indexOf('Tag.Label');
    assert.deepEqual(enclosingEachScopes(scopes, inInner).map((s) => s.variable), ['Track', 'Tag']);
    assert.equal(eachScopeNamed(scopes, inInner, 'Tag')?.sourceText, 'GetTags()');
    assert.equal(eachScopeNamed(scopes, inInner, 'Track')?.sourceText, 'Tracks');

    const inOuterOnly = NESTED.indexOf('Track.Title');
    assert.equal(eachScopeNamed(scopes, inOuterOnly, 'Tag'), undefined);

    // Outside every loop body: no item is in scope, whatever it is called.
    assert.equal(eachScopeNamed(scopes, NESTED.indexOf('Widget Root'), 'Track'), undefined);
});

test('an unfinished each header yields a scope with no source, not a wrong one', () => {
    const source = 'Widget Root {\n    each Track in {\n        Text T { Text = "x" }\n    }\n}\n';
    const scopes = eachScopesOf(buildStructure(source), source);
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0].sourceText, '');
    assert.equal(parseEachSource(scopes[0].sourceText), undefined);
});

test('a signature reads like the declaration, and its parameter spans index into it', () => {
    const rendered = signatureLabelOf({
        name: 'Format', returnType: 'FText', paramCount: 2,
        params: [{ name: 'Value', type: 'float' }, { name: 'Digits', type: 'int32' }],
    });
    assert.equal(rendered.label, 'Format(Value: float, Digits: int32) : FText');
    assert.deepEqual(rendered.parameters.map(([start, end]) => rendered.label.slice(start, end)),
        ['Value: float', 'Digits: int32']);
});

test('a count without a list still says which argument out of how many', () => {
    const rendered = signatureLabelOf({ name: 'Fmt', paramCount: 3 });
    assert.equal(rendered.parameters.length, 3);
    assert.equal(rendered.label, 'Fmt(…, …, …)');

    const nullary = signatureLabelOf({ name: 'GetTitle', returnType: 'FText', paramCount: 0 });
    assert.equal(nullary.label, 'GetTitle() : FText');
    assert.deepEqual(nullary.parameters, []);
});

test('names compare the way FName would', () => {
    const list = [{ name: 'GetTitle' }, { name: 'bMuted' }];
    assert.equal(findByName(list, 'gettitle')?.name, 'GetTitle');
    assert.equal(findByName(list, 'Missing'), undefined);
    assert.ok(isIdentifier('Track'));
    assert.ok(isIdentifier('轨道'));
    assert.ok(!isIdentifier('Track.Title'));
    assert.ok(!isIdentifier('2nd'));
});
