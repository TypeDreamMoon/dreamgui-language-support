/**
 * The translations hover's lookup: which text the cursor is on, keyed as the compiler keys it, and its entry in a
 * DreamLoc .dloc file.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import { dlocPathOf, findEntry, textAt } from '../src/core/translations';

const dui = [
    'class /Game/UI/WBP_Settings',
    '',
    'Widget Root {',
    '    Text Title {',
    '        Text = "设置" @note("页面标题") @max(12)',
    '    }',
    '    Widget Footer {',
    '        Text Apply {',
    '            Text = "应用" @key("Settings.Apply")',
    '        }',
    '        Text Version {',
    '            Text = "v1.0.3" @noloc',
    '        }',
    '    }',
    '}',
].join('\n');

const dloc = [
    'dloc 1',
    'culture en',
    'namespace /Game/UI/WBP_Settings',
    '',
    'Title.Text {',
    '    at    DUI/UI/Settings.dui#Title',
    '    src   "设置"',
    '    text  "Settings // the page"  // a comment',
    '    state done',
    '}',
    '',
    'Settings.Apply {',
    '    at    DUI/UI/Settings.dui#Footer/Apply',
    '    prev  "应用更改"',
    '    src   "应用"',
    '    text  "Apply \\"now\\"\\nplease"',
    '}',
    '',
    'removed {',
    '    Old.Text {',
    '        at    DUI/UI/Settings.dui#Title',
    '        src   "设置"',
    '        text  "Old"',
    '    }',
    '}',
].join('\n');

test('the text under the cursor is keyed as the compiler keys it', () => {
    const structure = buildStructure(dui);
    const title = textAt(structure, dui, dui.indexOf('"设置"') + 1);
    assert.deepEqual(title, { nodePath: 'Title', key: 'Title.Text', source: '设置' });
    const apply = textAt(structure, dui, dui.indexOf('"应用"') + 1);
    assert.deepEqual(apply, { nodePath: 'Footer/Apply', key: 'Settings.Apply', source: '应用' });
    assert.equal(textAt(structure, dui, dui.indexOf('"v1.0.3"') + 1), undefined, '@noloc has no translations');
    assert.equal(textAt(structure, dui, dui.indexOf('Widget Footer')), undefined, 'not on a string');
    assert.equal(structure.diagnostics.length, 0, 'and the annotations parse');
});

test('its entry in the .dloc, outside the removed block', () => {
    assert.equal(dlocPathOf('DUI/UI/Settings.dui', 'en'), 'DLoc/en/DUI/UI/Settings.dloc');
    assert.deepEqual(findEntry(dloc, 'Title.Text', 'DUI/UI/Settings.dui#Title'), { text: 'Settings // the page', line: 8, stale: false, state: 'done' });
    assert.deepEqual(findEntry(dloc, 'Settings.Apply', 'DUI/UI/Settings.dui#Footer/Apply'), { text: 'Apply "now"\nplease', line: 16, stale: true, state: undefined });
    assert.equal(findEntry(dloc, 'Old.Text', 'DUI/UI/Settings.dui#Title'), undefined);
    assert.equal(findEntry(dloc, 'Title.Text', 'DUI/UI/Other.dui#Title'), undefined, 'another file\'s at');
});
