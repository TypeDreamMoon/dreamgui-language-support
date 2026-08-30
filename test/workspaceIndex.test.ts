/**
 * The cross-file layer: summaries, the class-path bridge (nested tag -> declaring file), nesting
 * references, symbol search, and the update/remove lifecycle.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { WorkspaceIndex, summarizeFile, packagePathOf } from '../src/core/workspaceIndex';

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

test('update replaces and remove forgets', () => {
    const index = makeIndex();
    index.update('I:/proj/DUI/Card.dui', 'class /Game/UI/WBP_Renamed\nWidget Root {}\n');
    assert.equal(index.fileForClass('/Game/UI/WBP_Card'), undefined);
    assert.equal(index.fileForClass('/Game/UI/WBP_Renamed')?.file, 'I:/proj/DUI/Card.dui');
    index.remove('I:/proj/DUI/Card.dui');
    assert.equal(index.fileForClass('/Game/UI/WBP_Renamed'), undefined);
    assert.equal(index.size, 1);
});
