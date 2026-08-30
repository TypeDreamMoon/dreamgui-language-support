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
