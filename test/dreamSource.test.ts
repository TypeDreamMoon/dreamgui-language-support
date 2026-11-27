/**
 * The DreamSource layout's decisions, held to the spec's section 11 without a disk: the ini
 * setting, the four states of table 11.2, plugin roots, the notice and the migration plan, and the
 * database rows put back into the shapes the old JSON files had.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    DREAM_UI, SourceFs, databasePath, deprecationNotice, diagnosticRowsToMailboxText, findProjectRoot,
    isUnder, parseSourceDirectorySetting, planMigration, pluginSourceRoots, reassembleSymbols,
    resolveProjectSourceRoot, revisionsFromMeta,
} from '../src/core/dreamSource';
import { parseMailbox } from '../src/core/mailbox';

const SECTION = DREAM_UI.settingsSection;
const join = (...parts: string[]): string => parts.join('/').replace(/\/+/g, '/');
const dirname = (path: string): string => {
    const index = path.lastIndexOf('/');
    return index <= 2 ? path.slice(0, 3) : path.slice(0, index);
};

/** A disk of directories and files, by absolute forward-slash path. */
function fakeFs(directories: string[], files: Record<string, string> = {}): SourceFs {
    const dirs = new Set<string>();
    const fileMap = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
    // Every ancestor of every directory and file exists, as on a real disk.
    const addWithAncestors = (directory: string): void => {
        for (let current = directory.toLowerCase(); !dirs.has(current); current = dirname(current)) {
            dirs.add(current);
            if (dirname(current) === current) {
                break;
            }
        }
    };
    directories.forEach(addWithAncestors);
    Object.keys(files).forEach((file) => addWithAncestors(dirname(file)));
    return {
        isDirectory: (path) => dirs.has(path.toLowerCase()),
        isFile: (path) => fileMap.has(path.toLowerCase()),
        readText: (path) => fileMap.get(path.toLowerCase()),
        list: (path) => {
            const prefix = path.toLowerCase().replace(/\/$/, '') + '/';
            const names = new Set<string>();
            for (const entry of [...dirs, ...fileMap.keys()]) {
                if (entry.startsWith(prefix)) {
                    const rest = entry.slice(prefix.length);
                    if (rest && !rest.includes('/')) {
                        // Original casing does not matter to any caller here.
                        names.add(rest);
                    }
                }
            }
            return [...names];
        },
    };
}

// ---- the setting ---------------------------------------------------------------------------

test('SourceDirectory is read as Unreal saves an FDirectoryPath, and as a person writes it', () => {
    assert.equal(parseSourceDirectorySetting(`[${SECTION}]\nSourceDirectory=(Path="Source/Dream/UI")\n`, SECTION),
        'Source/Dream/UI');
    assert.equal(parseSourceDirectorySetting(`[${SECTION}]\r\nSourceDirectory=Art\\UI\\\r\n`, SECTION), 'Art/UI');
    assert.equal(parseSourceDirectorySetting(`[${SECTION}]\nSourceDirectory="Quoted/UI"\n`, SECTION), 'Quoted/UI');
});

test('only its own section counts, comments do not, and the last assignment wins', () => {
    const ini = [
        '[/Script/DreamFXEditor.DreamFXSourceSettings]',
        'SourceDirectory=(Path="DreamSource/FX")',
        `[${SECTION}]`,
        '; SourceDirectory=Commented',
        'SourceDirectory=First',
        'SourceDirectory=Second',
    ].join('\n');
    assert.equal(parseSourceDirectorySetting(ini, SECTION), 'Second');
    assert.equal(parseSourceDirectorySetting('[/Script/Other.Settings]\nSourceDirectory=X\n', SECTION), undefined);
});

test('an absolute or empty SourceDirectory is not a setting: the default stands in', () => {
    for (const value of ['(Path="D:/Work/UI")', '/abs/UI', '\\\\share\\UI', '(Path="")', '']) {
        assert.equal(parseSourceDirectorySetting(`[${SECTION}]\nSourceDirectory=${value}\n`, SECTION), undefined, value);
    }
    const root = resolveProjectSourceRoot('X:/P', DREAM_UI,
        fakeFs([], { 'X:/P/Config/DefaultDreamSource.ini': `[${SECTION}]\nSourceDirectory=(Path="D:/UI")\n` }), join);
    assert.equal(root.configuredSetting, 'DreamSource/UI');
});

// ---- table 11.2 ----------------------------------------------------------------------------

test('the four states of the project root', () => {
    const resolve = (dirs: string[]) => resolveProjectSourceRoot('X:/P', DREAM_UI, fakeFs(dirs), join);

    const configured = resolve(['X:/P/DreamSource/UI']);
    assert.equal(configured.state, 'configured');
    assert.equal(configured.activeDir, 'X:/P/DreamSource/UI');

    const both = resolve(['X:/P/DreamSource/UI', 'X:/P/DUI']);
    assert.equal(both.state, 'configuredAndLegacy');
    assert.equal(both.activeDir, 'X:/P/DreamSource/UI', 'the old folder is ignored');

    const legacy = resolve(['X:/P/DUI']);
    assert.equal(legacy.state, 'legacy');
    assert.equal(legacy.activeDir, 'X:/P/DUI', 'still read until it moves');

    const none = resolve([]);
    assert.equal(none.state, 'none');
    assert.equal(none.activeDir, undefined);
    assert.equal(none.configuredDir, 'X:/P/DreamSource/UI', 'where a new file goes');
});

test('a configured folder elsewhere is the one used, and a setting naming DUI itself is not "both"', () => {
    const custom = resolveProjectSourceRoot('X:/P', DREAM_UI, fakeFs(['X:/P/Src/Widgets', 'X:/P/DUI'], {
        'X:/P/Config/DefaultDreamSource.ini': `[${SECTION}]\nSourceDirectory=(Path="Src/Widgets")\n`,
    }), join);
    assert.equal(custom.state, 'configuredAndLegacy');
    assert.equal(custom.activeDir, 'X:/P/Src/Widgets');

    const pinnedToOld = resolveProjectSourceRoot('X:/P', DREAM_UI, fakeFs(['X:/P/DUI'], {
        'X:/P/Config/DefaultDreamSource.ini': `[${SECTION}]\nSourceDirectory=DUI\n`,
    }), join);
    assert.equal(pinnedToOld.state, 'configured');
    assert.equal(deprecationNotice(pinnedToOld, DREAM_UI), undefined);
});

test('plugin roots: DreamSource/UI first, the old DUI/ otherwise, nested plugin folders included', () => {
    const fs = fakeFs(
        ['X:/P/Plugins/A/DreamSource/UI', 'X:/P/Plugins/A/DUI', 'X:/P/Plugins/Market/B/DUI', 'X:/P/Plugins/C/Source'],
        {
            'X:/P/Plugins/A/A.uplugin': '{}',
            'X:/P/Plugins/Market/B/B.uplugin': '{}',
            'X:/P/Plugins/C/C.uplugin': '{}',
        });
    const roots = pluginSourceRoots('X:/P', DREAM_UI, fs, join).sort((a, b) => a.plugin.localeCompare(b.plugin));
    assert.deepEqual(roots.map((r) => [r.plugin.toLowerCase(), r.directory.toLowerCase(), r.legacy]), [
        ['a', 'x:/p/plugins/a/dreamsource/ui', false],
        ['b', 'x:/p/plugins/market/b/dui', true],
    ]);
});

test('the project is the nearest folder holding a .uproject', () => {
    const fs = fakeFs(['X:/P/DreamSource/UI/Panels'], { 'X:/P/Game.uproject': '{}' });
    assert.equal(findProjectRoot('X:/P/DreamSource/UI/Panels', fs, dirname), 'X:/P');
    assert.equal(findProjectRoot('X:/Elsewhere', fakeFs(['X:/Elsewhere']), dirname), undefined);
    assert.equal(databasePath('X:/P', DREAM_UI, join), 'X:/P/Intermediate/DreamSource/ui.db');
});

test('isUnder is case- and slash-blind and does not match a sibling with a shared prefix', () => {
    assert.ok(isUnder('x:\\p\\dreamsource\\ui\\a.dui', 'X:/P/DreamSource/UI'));
    assert.ok(!isUnder('X:/P/DreamSource/UIKit/a.dui', 'X:/P/DreamSource/UI'));
});

// ---- notice and migration ------------------------------------------------------------------

test('the notice: legacy asks to move, both says the old one is ignored, otherwise silence', () => {
    const at = (dirs: string[]) => resolveProjectSourceRoot('X:/P', DREAM_UI, fakeFs(dirs), join);
    assert.match(deprecationNotice(at(['X:/P/DUI']), DREAM_UI)!, /DUI\/ is deprecated.*DreamSource\/UI\//);
    assert.match(deprecationNotice(at(['X:/P/DUI', 'X:/P/DreamSource/UI']), DREAM_UI)!, /ignored/);
    assert.equal(deprecationNotice(at(['X:/P/DreamSource/UI']), DREAM_UI), undefined);
    assert.equal(deprecationNotice(at([]), DREAM_UI), undefined);
});

test('a migration moves DUI/ only from the legacy state and only with no editor running', () => {
    const at = (dirs: string[]) => resolveProjectSourceRoot('X:/P', DREAM_UI, fakeFs(dirs), join);
    const plan = planMigration(at(['X:/P/DUI']), DREAM_UI, false, join);
    assert.ok(plan.ok);
    if (plan.ok) {
        assert.equal(plan.from, 'X:/P/DUI');
        assert.equal(plan.to, 'X:/P/DreamSource/UI');
        assert.ok(plan.staleFiles.includes('X:/P/DreamSource/UI/.dui-symbols.json'));
        assert.ok(plan.staleFiles.includes('X:/P/DreamSource/UI/.dui-diagnostics.json'));
    }
    const running = planMigration(at(['X:/P/DUI']), DREAM_UI, true, join);
    assert.ok(!running.ok && /Close it first/.test(running.reason));
    const both = planMigration(at(['X:/P/DUI', 'X:/P/DreamSource/UI']), DREAM_UI, false, join);
    assert.ok(!both.ok && /merge/.test(both.reason));
    assert.ok(!planMigration(at(['X:/P/DreamSource/UI']), DREAM_UI, false, join).ok);
    assert.ok(!planMigration(at([]), DREAM_UI, false, join).ok);
});

// ---- rows back into objects ----------------------------------------------------------------

test('symbol rows reassemble into the dump: object sections by member, the rest whole', () => {
    const rows = [
        { section: 'version', name: '', json: '2' },
        { section: 'tags', name: 'Image', json: '{"kind":"visual","properties":[]}' },
        { section: 'tags', name: 'Text', json: '{"kind":"visual"}' },
        { section: 'keywords', name: '', json: '[{"name":"style"}]' },
        { section: 'viewModels', name: '', json: '{}' },
        { section: 'enums', name: 'EAlign', json: '{"values":["Left","Right"]}' },
        { section: 'enums', name: 'Broken', json: '{not json' },
    ];
    assert.deepEqual(reassembleSymbols(rows), {
        version: 2,
        tags: { Image: { kind: 'visual', properties: [] }, Text: { kind: 'visual' } },
        keywords: [{ name: 'style' }],
        viewModels: {},
        enums: { EAlign: { values: ['Left', 'Right'] } },
    });
});

test('an empty-object row and member rows of the same section merge, whichever comes first', () => {
    const forward = reassembleSymbols([
        { section: 'components', name: '', json: '{}' },
        { section: 'components', name: 'A', json: '1' },
    ]);
    const backward = reassembleSymbols([
        { section: 'components', name: 'A', json: '1' },
        { section: 'components', name: '', json: '{}' },
    ]);
    assert.deepEqual(forward, { components: { A: 1 } });
    assert.deepEqual(backward, { components: { A: 1 } });
});

test('diagnostic rows read back through parseMailbox as the version-1 mailbox did', () => {
    const text = diagnosticRowsToMailboxText([
        {
            path: 'X:/P/DreamSource/UI/Main.dui', compiled_at_utc: '2026-11-26T10:00:00Z',
            json: '[{"code":5004,"severity":"error","line":12,"column":5,"message":"Bad value."}]',
        },
        { path: 'X:/P/DreamSource/UI/Clean.dui', compiled_at_utc: '2026-11-26T10:00:01Z', json: '[]' },
        { path: 'X:/P/DreamSource/UI/Torn.dui', compiled_at_utc: '2026-11-26T10:00:02Z', json: '[{' },
    ]);
    const mailbox = parseMailbox(text)!;
    assert.equal(mailbox.version, 1);
    assert.deepEqual(Object.keys(mailbox.files).sort(),
        ['X:/P/DreamSource/UI/Clean.dui', 'X:/P/DreamSource/UI/Main.dui']);
    assert.equal(mailbox.files['X:/P/DreamSource/UI/Main.dui'].diagnostics[0].code, 5004);
    assert.equal(mailbox.files['X:/P/DreamSource/UI/Main.dui'].compiledAt, '2026-11-26T10:00:00Z');
    assert.deepEqual(mailbox.files['X:/P/DreamSource/UI/Clean.dui'].diagnostics, [], 'clean clears squiggles');
});

test('meta rows become numeric revisions; missing ones stay undefined', () => {
    assert.deepEqual(revisionsFromMeta([
        { key: 'schema', value: '1' }, { key: 'revision', value: '7' }, { key: 'symbols_revision', value: '3' },
        { key: 'producer', value: 'DreamGUI@1.0.0' },
    ]), { schema: 1, revision: 7, symbols: 3, diagnostics: undefined });
});
