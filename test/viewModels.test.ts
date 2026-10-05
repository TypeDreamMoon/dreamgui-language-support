/**
 * View models (DreamGUI plan 17): the `viewmodels` block, member paths in bindings, loops and routes, the `+=` and
 * `=` route operators -- held to the compiler's parser (DreamUISourceFile.cpp) -- and the completion that follows a
 * path through the plugin's export.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import { scan } from '../src/core/scanner';
import { formatDui } from '../src/core/format';
import { bindingTailOf } from '../src/core/bindingIntel';
import { normalizeSymbols } from '../src/core/symbolFacts';
import {
    classAtPath, classOfMemberType, memberRunAt, resolveViewModelType, viewModelMembersAt,
} from '../src/core/viewModelIntel';

const lines = (...text: string[]): string => text.join('\n');
const codes = (source: string): number[] => buildStructure(source).diagnostics.map((diagnostic) => diagnostic.code);

const FILE = lines(
    'class /Game/UI/WBP_Inventory',
    'use /Script/Game.StatsVM as Stats',
    '',
    'viewmodels {',
    '    PlayerVM    Player',
    '    SettingsVM  Settings = new',
    '    InventoryVM Inventory = global',
    '    InventoryVM Stash = global "Stash"',
    '    PartyVM     Party = parent; PartyVM Other = parent "Other"',
    '}',
    '',
    'VerticalBox Root {',
    '    Text Gold { Text <- Inventory.GoldText }',
    '    Text Name { Text <- Player.FormatName(Player.Name) }',
    '    Native.Slider Volume { Value <-> Settings.MasterVolume  OnValueChanged += Settings.SetVolume(Value) }',
    '    Native.Button Apply { OnClicked += Settings.Apply()  OnPressed -> Settings.Ping }',
    '    Widget Pick { OnInit = Party.Ready  OnPicked = emit Picked(1)  OnOther = HandleOther }',
    '    for Item in Inventory.Items {',
    '        HorizontalBox { Text { Text <- Item.Name }  Native.Button { OnClicked += Item.Use() } }',
    '    }',
    '    for Row in Inventory.Filtered() {',
    '        Text { Text <- Row.Name }',
    '    }',
    '}');

test('+= is one token, and a + before anything else is still the component plus', () => {
    assert.deepEqual(scan('OnClicked += Go').tokens.map((token) => token.kind), ['identifier', 'plusEquals', 'identifier', 'end']);
    assert.deepEqual(scan('+ VerticalBox { }').tokens.map((token) => token.kind),
        ['plus', 'identifier', 'openBrace', 'closeBrace', 'end']);
    assert.deepEqual(scan('A <- B + C').tokens.map((token) => token.kind), ['identifier', 'arrow', 'identifier', 'plus', 'identifier', 'end']);
});

test('a file using every new form reads clean', () => {
    const built = buildStructure(FILE);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.viewModels?.map((decl) => [decl.type, decl.name, decl.source, decl.sourceName ?? '']), [
        ['PlayerVM', 'Player', 'host', ''],
        ['SettingsVM', 'Settings', 'new', ''],
        ['InventoryVM', 'Inventory', 'global', ''],
        ['InventoryVM', 'Stash', 'global', 'Stash'],
        ['PartyVM', 'Party', 'parent', ''],
        ['PartyVM', 'Other', 'parent', 'Other'],
    ]);
    assert.ok(built.scopes.some((scope) => scope.kind === 'viewmodels'));
});

test('a viewmodels entry records its name where the compiler does, and its type beside it', () => {
    const decl = buildStructure(lines('viewmodels {', '    PlayerVM Player', '}', 'Widget Root { }')).viewModels![0];
    assert.equal(decl.line, 2);
    assert.equal(decl.column, 14);
    assert.equal(decl.typeColumn, 5);
});

test('DUI2021: every malformed viewmodels line, and the block inside a node', () => {
    const root = 'Widget Root { }';
    assert.deepEqual(codes(lines('viewmodels { PlayerVM }', root)), [2021]);
    assert.deepEqual(codes(lines('viewmodels { PlayerVM Player = sometimes }', root)), [2021]);
    assert.deepEqual(codes(lines('viewmodels { PlayerVM Player = global "" }', root)), [2021]);
    assert.deepEqual(codes(lines('viewmodels { PlayerVM Player Extra }', root)), [2021]);
    assert.deepEqual(codes(lines('Widget Root {', '    viewmodels { PlayerVM Player }', '}')), [2021]);
    // The rest of the block still reads after a bad line.
    const built = buildStructure(lines('viewmodels {', '    PlayerVM', '    SettingsVM Settings = new', '}', root));
    assert.deepEqual(built.diagnostics.map((diagnostic) => diagnostic.code), [2021]);
    assert.deepEqual(built.viewModels?.map((decl) => decl.name), ['Settings']);
});

test('DUI3024: a second view model of one name, case insensitive, the first kept', () => {
    const built = buildStructure(lines('viewmodels {', '    PlayerVM Player', '    OtherVM player', '}', 'Widget Root { }'));
    assert.deepEqual(built.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.line]), [[3024, 3]]);
    assert.deepEqual(built.viewModels?.map((decl) => decl.type), ['PlayerVM']);
});

test('the words viewmodels, new, global and parent stay names everywhere else', () => {
    const built = buildStructure(lines(
        'Widget Root {',
        '    viewmodels = 1',
        '    Text new { Text = "a" }',
        '    Text global { }',
        '    Text parent { }',
        '}'));
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.roots[0].children.map((child) => child.id), ['new', 'global', 'parent']);
});

test('routes: += and a dotted = are routes, one word after = is a value', () => {
    const built = buildStructure(FILE);
    const statements = (id: string) => built.roots[0].children.find((child) => child.id === id)!.properties;
    assert.deepEqual(statements('Apply').map((stmt) => [stmt.path, stmt.op, stmt.routeOperator ?? '']),
        [['OnClicked', 'eventArrow', 'append'], ['OnPressed', 'eventArrow', '']]);
    assert.deepEqual(statements('Pick').map((stmt) => [stmt.path, stmt.op, stmt.routeOperator ?? '']), [
        ['OnInit', 'eventArrow', 'assign'],
        ['OnPicked', 'eventArrow', 'assign'],
        ['OnOther', 'equals', ''],
    ]);
    const routes = built.bindings.filter((binding) => binding.isMemberRoute).map((binding) => binding.name);
    assert.deepEqual(routes, ['Settings.SetVolume', 'Settings.Apply', 'Settings.Ping', 'Party.Ready', 'Item.Use']);
    // The arguments of a member route are names like any expression's.
    assert.ok(built.bindings.some((binding) => binding.name === 'Value' && binding.isVariable));
});

test('member paths: a dotted call is one name, a two-way and a loop source take a path', () => {
    const built = buildStructure(FILE);
    assert.ok(built.bindings.some((binding) => binding.name === 'Player.FormatName' && !binding.isVariable));
    assert.ok(built.bindings.some((binding) => binding.name === 'Player.Name' && binding.isVariable));
    assert.ok(built.bindings.some((binding) => binding.name === 'Settings.MasterVolume' && binding.isVariable));
    const loops = built.roots[0].children.filter((child) => child.kind === 'loop');
    assert.deepEqual(loops.map((loop) => [loop.loopSource, loop.loopSourceIsFunction]),
        [['Inventory.Items', false], ['Inventory.Filtered', true]]);
});

test('a dotted path with nothing after its dot is the compiler\'s refusal, not a new mistake', () => {
    assert.ok(!codes(lines('Widget Root {', '    Value <-> Settings.', '}')).includes(2021));
    assert.ok(!codes(lines('Widget Root {', '    OnClicked += Settings.', '}')).includes(2021));
});

test('the formatter keeps every new form', () => {
    const formatted = formatDui(FILE, { indent: '    ', eol: '\n' });
    assert.ok(formatted.includes('OnClicked += Settings.Apply()'));
    assert.ok(formatted.includes('OnInit = Party.Ready'));
    assert.ok(formatted.includes('InventoryVM Stash = global "Stash"'));
});

test('completion: += opens a route the way -> does', () => {
    assert.equal(bindingTailOf('    OnClicked += Sett')?.op, '->');
    assert.equal(bindingTailOf('    OnClicked += Sett')?.tail, ' Sett');
});

const SYMBOLS = normalizeSymbols({
    version: 2,
    viewModels: {
        PlayerVM: {
            class: '/Script/Game.PlayerVM',
            members: {
                Name: { kind: 'property', type: 'Text', fieldNotify: true, writable: true },
                Stats: { kind: 'property', type: 'Object<StatsVM>', fieldNotify: true },
                FormatName: { kind: 'function', type: 'Text', params: [{ name: 'InName', type: 'Text' }] },
            },
        },
        StatsVM: { class: '/Script/Game.StatsVM', members: { Title: { kind: 'property', type: 'Text' } } },
        InventoryVM: {
            class: '/Script/Game.InventoryVM',
            members: {
                Items: { kind: 'property', type: 'Array<Object<ItemVM>>', fieldNotify: true },
                GoldText: { kind: 'property', type: 'Text', fieldNotify: true },
            },
        },
        ItemVM: {
            class: '/Script/Game.ItemVM',
            members: { Name: { kind: 'property', type: 'Text' }, Use: { kind: 'function', type: 'Void' } },
        },
        BP_ShopVM: { class: '/Game/UI/BP_ShopVM.BP_ShopVM_C', members: { Open: { kind: 'function', type: 'Void' } } },
    },
});

test('an old export has no view models, and a new one keeps only well-formed members', () => {
    assert.deepEqual(normalizeSymbols({ version: 1 }).viewModels, {});
    const odd = normalizeSymbols({ viewModels: { X: { members: { Bad: { kind: 'other', type: 'Text' }, Good: { kind: 'property', type: 'Text' } } } } });
    assert.deepEqual(Object.keys(odd.viewModels.X.members), ['Good']);
});

test('a viewmodels type resolves by name, by U-prefixed name, by path, by Blueprint path, by use … as', () => {
    const structure = buildStructure(FILE);
    assert.equal(resolveViewModelType(SYMBOLS, structure, 'PlayerVM')?.name, 'PlayerVM');
    assert.equal(resolveViewModelType(SYMBOLS, structure, 'UPlayerVM')?.name, 'PlayerVM');
    assert.equal(resolveViewModelType(SYMBOLS, structure, '/Script/Game.InventoryVM')?.name, 'InventoryVM');
    assert.equal(resolveViewModelType(SYMBOLS, structure, '/Game/UI/BP_ShopVM')?.name, 'BP_ShopVM');
    assert.equal(resolveViewModelType(SYMBOLS, structure, 'Stats')?.name, 'StatsVM');
    assert.equal(resolveViewModelType(SYMBOLS, structure, 'Nothing'), undefined);
});

test('a member path is followed through object members, and through a loop over a view model\'s list', () => {
    assert.deepEqual(memberRunAt('    Text <- Player.Stats.Ti'), { segments: ['Player', 'Stats'], partial: 'Ti' });
    assert.equal(memberRunAt('    Color = @nier.In'), undefined);
    assert.deepEqual(classOfMemberType('Array<Object<ItemVM>>'), { name: 'ItemVM', array: true });

    const structure = buildStructure(FILE);
    const members = (line: string, offset: number) =>
        viewModelMembersAt(SYMBOLS, structure, line, offset)?.members.map(([name]) => name);
    assert.deepEqual(members('    Text <- Player.', 0), ['FormatName', 'Name', 'Stats']);
    assert.deepEqual(members('    Text <- Player.Stats.', 0), ['Title']);
    assert.equal(members('    Text <- Player.Name.', 0), undefined);
    assert.equal(members('    Text <- Nobody.', 0), undefined);

    const inLoop = FILE.indexOf('Item.Name');
    assert.deepEqual(members('        Text <- Item.', inLoop), ['Name', 'Use']);
    assert.equal(classAtPath(SYMBOLS, structure, ['Item'], 0), undefined, 'outside its loop, Item is nothing');
});
