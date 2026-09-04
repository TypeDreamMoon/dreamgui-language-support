/**
 * The judging layer: which refusals this extension makes, and -- more of the file than that -- the
 * three it WITHHOLDS on workspace knowledge one file's characters cannot carry.
 *
 * The exemptions are the part worth testing hardest. Each one is the extension deciding not to say
 * something the structural layer wanted to say, on evidence from another file, and every one of
 * them has a failure mode in both directions: withhold too eagerly and a real mistake goes quiet,
 * withhold too rarely and a compiling project opens covered in red.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { judgeDocument } from '../src/core/diagnose';
import { WorkspaceIndex } from '../src/core/workspaceIndex';

const LIBRARY = `// Styles and resources, no root: a file that exists to be imported.
style Heading {
    FontSize = 22
}

resources {
    Color Accent = #FF6600
}
`;

const CONSUMER = `class /Game/UI/WBP_Panel

use "Styles/Common.dui"

Widget Root {
    Text Title : Heading {
        Brush.TintColor = @Accent
    }
}
`;

const codes = (text: string, index?: WorkspaceIndex, tags?: readonly string[]): string[] =>
    judgeDocument({ file: 'I:/proj/DUI/Panel.dui', text, index, tags })
        .map((d) => `${d.code === undefined ? '--' : 'DUI' + d.code}`);

function indexWith(entries: Record<string, string>): WorkspaceIndex {
    const index = new WorkspaceIndex();
    for (const [file, text] of Object.entries(entries)) {
        index.update(file, text);
    }
    return index;
}

// ---- what an import exempts --------------------------------------------------------------------

test('without an index nothing is imported, and the imported style and colour both report', () => {
    assert.deepEqual(codes(CONSUMER), ['DUI3004', 'DUI4007']);
});

test('a use that resolves to exactly one file exempts its styles and its resources', () => {
    const index = indexWith({ 'I:/proj/DUI/Styles/Common.dui': LIBRARY });
    assert.deepEqual(codes(CONSUMER, index), []);
});

test('an ambiguous use imports nothing: two files, and the refusals stand', () => {
    // Both spellings end with the authored suffix on a segment boundary, so the index cannot say
    // which the compiler's roots would pick. Guessing here is how a wrong exemption hides a typo.
    const index = indexWith({
        'I:/proj/DUI/Styles/Common.dui': LIBRARY,
        'I:/other/DUI/Styles/Common.dui': LIBRARY,
    });
    assert.deepEqual(codes(CONSUMER, index), ['DUI3004', 'DUI4007']);
});

test('a use nothing in the workspace answers exempts nothing', () => {
    const index = indexWith({ 'I:/proj/DUI/Styles/Other.dui': LIBRARY });
    assert.deepEqual(codes(CONSUMER, index), ['DUI3004', 'DUI4007']);
});

test('a style may inherit a base an import brought in', () => {
    // FindStyle chains local styles into imported ones and the base walk goes through it, so the
    // compiler resolves this; only a mirror that can see one file at a time refuses it.
    const text = [
        'use "Styles/Common.dui"',
        '',
        'style Card : Heading {',
        '    FontSize = 18',
        '}',
        '',
        'Widget Root {',
        '    Text T : Card {}',
        '}',
        '',
    ].join('\n');
    assert.deepEqual(codes(text, indexWith({ 'I:/proj/DUI/Styles/Common.dui': LIBRARY })), []);
    // ...and the refusal still stands when the base is nowhere at all.
    assert.deepEqual(codes(text.replace('Heading', 'Nowhere'),
        indexWith({ 'I:/proj/DUI/Styles/Common.dui': LIBRARY })), ['DUI3004']);
});

test('an import exempts by name, not by spelling: the fold is case insensitive', () => {
    const index = indexWith({ 'I:/proj/DUI/Styles/Common.dui': LIBRARY });
    const shouting = CONSUMER.replace('Heading', 'HEADING').replace('@Accent', '@ACCENT');
    assert.deepEqual(codes(shouting, index), []);
});

// ---- what a file with no root is allowed to be -------------------------------------------------

test('a file of styles and resources declares no root on purpose', () => {
    assert.deepEqual(codes(LIBRARY), []);
});

test('a file with a node and no root still has to have one', () => {
    // Nothing declared, so nothing makes it a library; DUI2006 is the compiler's own verdict.
    assert.deepEqual(codes('use "Styles/Common.dui"\n'), ['DUI2006']);
});

test('an empty file opens quiet', () => {
    assert.deepEqual(codes(''), []);
    assert.deepEqual(codes('\n\n'), []);
});

// ---- '@' against a resources block --------------------------------------------------------------

test('a local resource covers its own uses, and an unknown one is named where it stands', () => {
    const text = 'resources {\n    Color Ink = #101010\n}\n\nWidget Root {\n    A = @Ink\n    B = @Missing\n}\n';
    const judged = judgeDocument({ file: 'I:/proj/DUI/Panel.dui', text });
    assert.deepEqual(judged.map((d) => d.code), [4007]);
    assert.equal(judged[0].message, "'@Missing' names no entry in a resources block");
    assert.equal(judged[0].severity, 'warning');
    // The '@' and the name after it, and not one character more.
    assert.equal(text.slice(judged[0].start, judged[0].end), '@Missing');
});

test('a resource an import brings in is not a missing one', () => {
    const index = indexWith({ 'I:/proj/DUI/Styles/Common.dui': LIBRARY });
    const text = 'use "Styles/Common.dui"\n\nWidget Root {\n    A = @Accent\n}\n';
    assert.deepEqual(codes(text, index), []);
    assert.deepEqual(codes(text), ['DUI4007']);
});

// ---- the checks the compiler has no code for ----------------------------------------------------

test("a '}' that closes nothing is an error with no code at all", () => {
    const text = 'Widget Root {\n}\n}\n';
    const judged = judgeDocument({ file: 'I:/proj/DUI/Panel.dui', text });
    assert.equal(judged.length, 1);
    assert.equal(judged[0].code, undefined);
    assert.equal(judged[0].severity, 'error');
    assert.equal(judged[0].message, "'}' closes nothing");
    assert.equal(text.slice(judged[0].start, judged[0].end), '}');
});

test('the tag sweep says nothing until a symbols dump is loaded, and then only as information', () => {
    const text = 'Widget Root {\n    Sparkle Thing {}\n    /Game/UI/WBP_Card.WBP_Card_C Card {}\n}\n';
    assert.deepEqual(codes(text), []);

    const judged = judgeDocument({ file: 'I:/proj/DUI/Panel.dui', text, tags: ['Widget', 'Text'] });
    assert.equal(judged.length, 1);
    assert.equal(judged[0].severity, 'information');
    // An asset path is a tag the compiler accepts and this dump could never list.
    assert.equal(text.slice(judged[0].start, judged[0].end), 'Sparkle');
});

test('a lexical refusal comes through first, with the code and span the scanner gave it', () => {
    const text = 'Widget Root {\n    Color = #GG\n}\n';
    const judged = judgeDocument({ file: 'I:/proj/DUI/Panel.dui', text });
    assert.equal(judged[0].code, 1005);
    assert.equal(judged[0].severity, 'error');
    assert.equal(text.slice(judged[0].start, judged[0].end), '#GG');
});
