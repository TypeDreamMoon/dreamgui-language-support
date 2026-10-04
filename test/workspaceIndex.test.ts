/**
 * The cross-file layer: summaries, the class-path bridge (nested tag -> declaring file), nesting
 * references, symbol search, and the update/remove lifecycle.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { WorkspaceIndex, summarizeFile, packagePathOf, referencesAt } from '../src/core/workspaceIndex';

const PANEL = `class /Game/UI/WBP_Panel

style Label {
    FontSize = 18
}

resources {
    Color Accent = #F00
}

Widget Root {
    Text Title : Label {
        Brush.TintColor = @Accent
    }
    /Game/UI/WBP_Card.WBP_Card_C TheCard {
    }
    slot Footer
}
`;

const CARD = `class /Game/UI/WBP_Card

Widget Root {
    Text CardTitle {}
}
`;

function makeIndex(): WorkspaceIndex {
    const index = new WorkspaceIndex();
    index.update('I:/proj/DUI/Panel.dui', PANEL);
    index.update('I:/proj/DUI/Card.dui', CARD);
    return index;
}

test('package paths normalise: with or without the object suffix, any case', () => {
    assert.equal(packagePathOf('/Game/UI/WBP_Card.WBP_Card_C'), '/game/ui/wbp_card');
    assert.equal(packagePathOf('/Game/UI/WBP_Card'), '/game/ui/wbp_card');
});

test('a summary carries ids, styles, resources, uses and nested classes', () => {
    const summary = summarizeFile('x.dui', PANEL);
    assert.equal(summary.classPath?.name, '/Game/UI/WBP_Panel');
    assert.deepEqual(summary.nodes.map((n) => `${n.kind}:${n.id}`),
        ['node:Root', 'node:Title', 'node:TheCard', 'namedSlot:Footer']);
    assert.deepEqual(summary.styles.map((s) => s.name), ['Label']);
    assert.deepEqual(summary.styleUses.map((s) => s.name), ['Label']);
    assert.deepEqual(summary.resources.map((r) => `${r.type} ${r.name}`), ['Color Accent']);
    assert.deepEqual(summary.resourceUses.map((r) => r.name), ['Accent']);
    assert.deepEqual(summary.nestedClasses.map((n) => n.name), ['/Game/UI/WBP_Card.WBP_Card_C']);
});

test('a style base counts as a use', () => {
    const summary = summarizeFile('x.dui', 'style A : B {\n}\nWidget Root {}\n');
    assert.deepEqual(summary.styleUses.map((s) => s.name), ['B']);
});

test('fileForClass bridges a nested tag to its declaring file', () => {
    const index = makeIndex();
    const hit = index.fileForClass('/Game/UI/WBP_Card.WBP_Card_C');
    assert.equal(hit?.file, 'I:/proj/DUI/Card.dui');
    assert.equal(index.fileForClass('/Game/UI/WBP_Nowhere'), undefined);
});

test('nestingSitesOf answers who nests a class', () => {
    const index = makeIndex();
    const sites = index.nestingSitesOf('/Game/UI/WBP_Card');
    assert.equal(sites.length, 1);
    assert.equal(sites[0].file, 'I:/proj/DUI/Panel.dui');
});

test('findSymbols searches ids, styles and resources, case-insensitively', () => {
    const index = makeIndex();
    assert.deepEqual(index.findSymbols('title').map((h) => `${h.kind}:${h.name}`).sort(),
        ['id:CardTitle', 'id:Title']);
    assert.deepEqual(index.findSymbols('label').map((h) => `${h.kind}:${h.name}`), ['style:Label']);
    assert.deepEqual(index.findSymbols('accent').map((h) => `${h.kind}:${h.name}`), ['resource:Accent']);
    assert.equal(index.findSymbols('').length > 5, true); // empty query = everything
});

test('references: a style answers its declaration and every wearing site, from either end', () => {
    const index = makeIndex();
    const file = 'I:/proj/DUI/Panel.dui';
    const declarationOffset = PANEL.indexOf('Label');           // in 'style Label'
    const useOffset = PANEL.indexOf(': Label') + 3;             // worn on Title
    for (const offset of [declarationOffset, useOffset]) {
        const answer = referencesAt(index, file, offset)!;
        assert.equal(answer.declaration?.name, 'Label');
        assert.equal(answer.uses.length, 1);
        assert.equal(PANEL.slice(answer.uses[0].start, answer.uses[0].end), 'Label');
    }
});

test('references: a resource answers from the declaration or any @use', () => {
    const index = makeIndex();
    const file = 'I:/proj/DUI/Panel.dui';
    const answer = referencesAt(index, file, PANEL.indexOf('@Accent') + 2)!;
    assert.equal(answer.declaration?.name, 'Accent');
    assert.deepEqual(answer.uses.map((use) => PANEL.slice(use.start, use.end)), ['@Accent']);
});

test('references: a class path crosses files, from the nested tag or the class line', () => {
    const index = makeIndex();
    const fromTag = referencesAt(index, 'I:/proj/DUI/Panel.dui', PANEL.indexOf('/Game/UI/WBP_Card') + 4)!;
    assert.equal(fromTag.declaration?.file, 'I:/proj/DUI/Card.dui');
    assert.equal(fromTag.uses.length, 1);
    assert.equal(fromTag.uses[0].file, 'I:/proj/DUI/Panel.dui');

    const fromClassLine = referencesAt(index, 'I:/proj/DUI/Card.dui', CARD.indexOf('/Game/UI/WBP_Card') + 4)!;
    assert.equal(fromClassLine.uses.length, 1);
    assert.equal(fromClassLine.uses[0].file, 'I:/proj/DUI/Panel.dui');
});

test('references: a node id gets no answer -- its references live in Blueprints', () => {
    const index = makeIndex();
    assert.equal(referencesAt(index, 'I:/proj/DUI/Panel.dui', PANEL.indexOf('Title') + 1), undefined);
});

test('a use spelling resolves by suffix, segment-aligned, unique or nothing', () => {
    const index = makeIndex();
    index.update('I:/proj/DUI/Styles/Common.dui', 'style Base { FontSize = 12 }\n');
    index.update('I:/other/DUI/Styles/Common.dui', 'style Base { FontSize = 14 }\n');

    // Segment-aligned: 'Common.dui' must not match a file merely ENDING in those letters.
    index.update('I:/proj/DUI/UnCommon.dui', 'Widget Root {}\n');
    assert.deepEqual(index.resolveImportSpelling('ard.dui'), []);

    // Two candidates: both reported -- the caller treats anything but one as no answer.
    assert.equal(index.resolveImportSpelling('Styles/Common.dui').length, 2);
    assert.equal(index.resolveImportSpelling('Common.dui').length, 2);

    // One candidate, back slashes and case forgiven.
    assert.deepEqual(index.resolveImportSpelling('proj\\DUI\\styles\\common.dui'),
        ['I:/proj/DUI/Styles/Common.dui']);
    assert.deepEqual(index.resolveImportSpelling('Panel.dui'), ['I:/proj/DUI/Panel.dui']);
    assert.deepEqual(index.resolveImportSpelling(''), []);
});

test('update replaces and remove forgets', () => {
    const index = makeIndex();
    index.update('I:/proj/DUI/Card.dui', 'class /Game/UI/WBP_Renamed\nWidget Root {}\n');
    assert.equal(index.fileForClass('/Game/UI/WBP_Card'), undefined);
    assert.equal(index.fileForClass('/Game/UI/WBP_Renamed')?.file, 'I:/proj/DUI/Card.dui');
    index.remove('I:/proj/DUI/Card.dui');
    assert.equal(index.fileForClass('/Game/UI/WBP_Renamed'), undefined);
    assert.equal(index.size, 1);
});

// ---- components, libraries and namespaces --------------------------------------------------------

const KIT: Record<string, string> = {
    'I:/proj/DUI/Kit/Palette.dui': 'resources {\n    Color Swatch = #E6E9F0\n}\nstyle Base {\n}\n',
    'I:/proj/DUI/Kit/Library.dui': [
        'use "Kit/Row.dui" as Row',
        'use /Game/UI/WBP_Slider as Slider',
        'use "Kit/Palette.dui" as pal',
        'use "Kit/Missing.dui" as Ghost',
        'resources {',
        '    Asset Card = /Game/UI/WBP_Card',
        '    Color Ink = #514D42',
        '}',
        'style Caption : pal.Base {',
        '}',
        '',
    ].join('\n'),
    'I:/proj/DUI/Kit/Row.dui': [
        'class /Game/UI/WBP_Row',
        'use "Kit/Library.dui"',
        'props {',
        '    Text Label',
        '    Enum /Script/Kit.EKind Kind = Cycle',
        '}',
        'events {',
        '    Changed(Number Index, Enum /Script/Kit.EStep Step); Closed',
        '}',
        'Widget Root : Caption {',
        '    HorizontalBox {',
        '        Text { }',
        '    }',
        '    slot Body default',
        '    slot Footer',
        '}',
        '',
    ].join('\n'),
    'I:/proj/DUI/Kit/Card.dui': 'class /Game/UI/WBP_Card\nWidget Root { }\n',
    'I:/proj/DUI/Screen.dui': [
        'use "Kit/Library.dui"',
        'use "Kit/Library.dui" as kit',
        'use /Game/UI/WBP_Row as Row',
        'Widget Root {',
        '    Row R {',
        '        slot Footer { Text Note { } }',
        '    }',
        '}',
        '',
    ].join('\n'),
};

function kitIndex(): WorkspaceIndex {
    const index = new WorkspaceIndex();
    for (const [file, text] of Object.entries(KIT)) {
        index.update(file, text);
    }
    return index;
}

test('a summary carries aliases, uses, props, events, slots and the made ids of unnamed nodes', () => {
    const row = summarizeFile('I:/proj/DUI/Kit/Row.dui', KIT['I:/proj/DUI/Kit/Row.dui']);
    assert.equal(row.hasRoot, true);
    assert.deepEqual(row.uses, [{ path: 'Kit/Library.dui', targetKind: 'file' }]);
    assert.deepEqual(row.props.map((p) => `${p.type} ${p.name}${p.defaultText ? ' = ' + p.defaultText : ''}`),
        ['Text Label', 'Enum /Script/Kit.EKind Kind = Cycle']);
    assert.deepEqual(row.events.map((e) => `${e.name}(${e.params})`),
        ['Changed(Number Index, Enum /Script/Kit.EStep Step)', 'Closed()']);
    assert.deepEqual(row.slots.map((s) => `${s.name}${s.isDefault ? ' default' : ''}`), ['Body default', 'Footer']);
    assert.deepEqual(row.nodes.map((n) => `${n.kind}:${n.id}${n.anonymous ? ' (made)' : ''}`),
        ['node:Root', 'node:Root__HorizontalBox0 (made)', 'node:Root__HorizontalBox0__Text0 (made)', 'namedSlot:Body', 'namedSlot:Footer']);
    // An unnamed node is sited at its type, the word the author wrote for it.
    const box = row.nodes[1];
    assert.equal(KIT['I:/proj/DUI/Kit/Row.dui'].slice(box.start, box.end), 'HorizontalBox');

    const library = summarizeFile('I:/proj/DUI/Kit/Library.dui', KIT['I:/proj/DUI/Kit/Library.dui']);
    assert.equal(library.hasRoot, false);
    assert.deepEqual(library.aliases.map((a) => `${a.name}=${a.targetKind}:${a.target}`),
        ['Row=file:Kit/Row.dui', 'Slider=class:/Game/UI/WBP_Slider', 'pal=file:Kit/Palette.dui', 'Ghost=file:Kit/Missing.dui']);
    assert.deepEqual(library.imports, ['Kit/Row.dui', 'Kit/Palette.dui', 'Kit/Missing.dui']);
    assert.equal(library.resources[0].value, '/Game/UI/WBP_Card');

    // A host's fill names the component's slot, not an id of the host's class.
    const screen = summarizeFile('I:/proj/DUI/Screen.dui', KIT['I:/proj/DUI/Screen.dui']);
    assert.deepEqual(screen.nodes.map((n) => n.id), ['Root', 'R', 'Note']);
    assert.deepEqual(screen.slots, []);
});

test('aliasesVisibleFrom: own first, then what plain uses re-export, then a namespace\'s under its prefix', () => {
    const index = kitIndex();
    assert.deepEqual(index.aliasesVisibleFrom('I:/proj/DUI/Screen.dui').map((a) => `${a.name}@${a.file.slice(12)}`),
        ['Row@Screen.dui', 'Slider@Kit/Library.dui', 'Ghost@Kit/Library.dui', 'kit.Row@Kit/Library.dui',
            'kit.Slider@Kit/Library.dui', 'kit.Ghost@Kit/Library.dui']);
    // A library's own `as` on a file with no root is a namespace, never a type; one that resolves to nothing is kept.
    assert.deepEqual(index.aliasesVisibleFrom('I:/proj/DUI/Kit/Library.dui').map((a) => a.name), ['Row', 'Slider', 'Ghost']);
    assert.deepEqual(index.aliasesVisibleFrom('I:/proj/DUI/Nowhere.dui'), []);
});

test('resolveComponent: a file alias to its class line, a class alias to its path, @Name through an Asset entry', () => {
    const index = kitIndex();
    const viaLibrary = index.resolveComponent('I:/proj/DUI/Kit/Card.dui', 'Row');
    assert.equal(viaLibrary, undefined); // Card uses nothing

    const fromRow = index.resolveComponent('I:/proj/DUI/Kit/Row.dui', 'row')!;
    assert.deepEqual([fromRow.file, fromRow.classPath, fromRow.declaredAt?.file],
        ['I:/proj/DUI/Kit/Row.dui', '/Game/UI/WBP_Row', 'I:/proj/DUI/Kit/Library.dui']);
    const namespaced = index.resolveComponent('I:/proj/DUI/Screen.dui', 'kit.Row')!;
    assert.deepEqual([namespaced.file, namespaced.classPath], ['I:/proj/DUI/Kit/Row.dui', '/Game/UI/WBP_Row']);
    const slider = index.resolveComponent('I:/proj/DUI/Screen.dui', 'Slider')!;
    assert.deepEqual([slider.file, slider.classPath], [undefined, '/Game/UI/WBP_Slider']);
    // The screen's own `as Row` wins over the library's.
    assert.equal(index.resolveComponent('I:/proj/DUI/Screen.dui', 'Row')?.declaredAt?.file, 'I:/proj/DUI/Screen.dui');

    const card = index.resolveComponent('I:/proj/DUI/Screen.dui', '@Card')!;
    assert.deepEqual([card.classPath, card.file, card.declaredAt], ['/Game/UI/WBP_Card', 'I:/proj/DUI/Kit/Card.dui', undefined]);
    assert.equal(index.resolveComponent('I:/proj/DUI/Screen.dui', '@Ink'), undefined); // a Color is no class
    assert.equal(index.resolveComponent('I:/proj/DUI/Screen.dui', 'Sparkle'), undefined);
});

test('importScopeOf merges as the compiler merges: plain, under a namespace, and transitively', () => {
    const index = kitIndex();
    const screen = index.summaryOf('I:/proj/DUI/Screen.dui')!;
    const scope = index.importScopeOf(screen.uses, screen.file);
    assert.deepEqual([...scope.styles].sort(), ['caption', 'kit.caption', 'kit.pal.base', 'pal.base']);
    assert.deepEqual([...scope.resources.keys()].sort(),
        ['card', 'ink', 'kit.card', 'kit.ink', 'kit.pal.swatch', 'pal.swatch']);
    assert.deepEqual([...scope.namespaces].sort(), ['kit', 'pal']);
    // Library.dui names Kit/Missing.dui, which nothing here answers: what it may bring is unknown.
    assert.equal(scope.complete, false);

    // A component that styles itself from the library naming it is no cycle: the library takes its class only.
    const row = index.summaryOf('I:/proj/DUI/Kit/Row.dui')!;
    index.update('I:/proj/DUI/Kit/Library.dui', KIT['I:/proj/DUI/Kit/Library.dui'].replace('use "Kit/Missing.dui" as Ghost\n', ''));
    const rowScope = index.importScopeOf(row.uses, row.file);
    assert.equal(rowScope.complete, true);
    assert.deepEqual(rowScope.aliases.map((a) => a.name), ['Row', 'Slider']);
});

test('a real cycle of plain uses is followed once, and leaves the scope incomplete', () => {
    const index = new WorkspaceIndex();
    index.update('I:/p/DUI/A.dui', 'use "B.dui"\nstyle InA { }\n');
    index.update('I:/p/DUI/B.dui', 'use "A.dui"\nstyle InB { }\n');
    const scope = index.importScopeOf([{ path: 'A.dui', targetKind: 'file' }], 'I:/p/DUI/Main.dui');
    assert.deepEqual([...scope.styles].sort(), ['ina', 'inb']);
    assert.equal(scope.complete, false);
});

test('classifyAlias: a class path is a component, a file with a root too, one without a namespace', () => {
    const index = kitIndex();
    assert.equal(index.classifyAlias({ target: '/Game/X', targetKind: 'class' }), 'component');
    assert.equal(index.classifyAlias({ target: 'Kit/Row.dui', targetKind: 'file' }), 'component');
    assert.equal(index.classifyAlias({ target: 'Kit/Palette.dui', targetKind: 'file' }), 'namespace');
    assert.equal(index.classifyAlias({ target: 'Kit/Missing.dui', targetKind: 'file' }), 'unresolved');
});
