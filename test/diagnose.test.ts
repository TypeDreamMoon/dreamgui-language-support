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

test('an import is followed transitively, the way ParseUseDeclaration merges one', () => {
    // A layered style library: Common uses Base, and the consumer only names Common. The compiler
    // merges Base's styles and resources into Common's AST and then Common's whole AST -- imports
    // included -- into the consumer's, so `Heading` and `@Accent` are in scope two hops away. One
    // hop of following made every second-hand name a false DUI3004 / DUI4007 on a file that builds.
    const consumer = CONSUMER.replace('use "Styles/Common.dui"', 'use "Styles/Layered.dui"');
    const index = indexWith({
        'I:/proj/DUI/Styles/Base.dui': LIBRARY,
        'I:/proj/DUI/Styles/Layered.dui': 'use "Styles/Base.dui"\n\nstyle Layered {\n    FontSize = 9\n}\n',
    });
    assert.deepEqual(codes(consumer, index), []);
});

test('a cycle of uses is walked once and does not hang the judge', () => {
    // The compiler refuses this with an ImportFailed of its own; what this asserts is only that the
    // follow terminates, because a visited set is the difference between a diagnostic and an editor
    // that stops responding while the author is still typing the second `use`.
    const index = indexWith({
        'I:/proj/DUI/Styles/A.dui': 'use "Styles/B.dui"\n\nstyle Heading {\n    FontSize = 22\n}\n',
        'I:/proj/DUI/Styles/B.dui': 'use "Styles/A.dui"\n\nresources {\n    Color Accent = #FF6600\n}\n',
    });
    assert.deepEqual(codes(CONSUMER.replace('use "Styles/Common.dui"', 'use "Styles/A.dui"'), index), []);
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

// ---- use … as, namespaces and component names ----------------------------------------------------
//
// A family written the NieR way: a library names its components and styles them, a component styles itself from the
// library that names it (no cycle: a component's class is all an importer takes from it), and screens use the
// library plainly or under a namespace.

const FAMILY: Record<string, string> = {
    'I:/proj/DUI/UI/Palette.dui': 'resources {\n    Color Swatch = #E6E9F0\n}\nstyle Base {\n    RenderOpacity = 1\n}\n',
    'I:/proj/DUI/UI/Common.dui': [
        'use "UI/Components/Row.dui" as Row',
        'use /Game/UI/WBP_Slider as Slider',
        'use "UI/Palette.dui" as pal',
        'resources {',
        '    Color Ink = #514D42',
        '    Asset Card = /Game/UI/WBP_Card',
        '}',
        'style Caption : pal.Base {',
        '    Color = @Ink',
        '}',
        '',
    ].join('\n'),
    'I:/proj/DUI/UI/Components/Row.dui': [
        'class /Game/UI/WBP_Row',
        'use "UI/Common.dui"',
        'props {',
        '    Text Label',
        '}',
        'Widget Root : Caption {',
        '    Text : Caption { Text <- Label }',
        '}',
        'style RowOnly {',
        '    RenderOpacity = 0.5',
        '}',
        '',
    ].join('\n'),
};

const TAGS = ['Widget', 'Text', 'Image', 'VerticalBox', 'Native.Button'];
const TAG_INFO = {
    Widget: { kind: 'visual' }, Text: { kind: 'visual', class: 'DreamText' }, Image: { kind: 'visual' },
    VerticalBox: { kind: 'container', class: 'DreamLayoutContainerVerticalBox' }, 'Native.Button': { kind: 'widget' },
};

const judged = (text: string, index?: WorkspaceIndex, tags?: readonly string[]): string[] =>
    judgeDocument({ file: 'I:/proj/DUI/UI/Screen.dui', text, index, tags, tagInfo: tags ? TAG_INFO : undefined })
        .map((d) => `${d.code === undefined ? '--' : 'DUI' + d.code} ${d.severity} ${d.message}`);

test('the family judges clean: library, component and a screen using the library plainly', () => {
    const index = indexWith(FAMILY);
    for (const [file, text] of Object.entries(FAMILY)) {
        assert.deepEqual(judgeDocument({ file, text, index, tags: TAGS, tagInfo: TAG_INFO }), [], file);
    }
    const screen = [
        'use "UI/Common.dui"',
        'Widget Root {',
        '    Row Item_0 : Caption { Label = "Warped Wire" }',
        '    Slider Volume { }',
        '    @Card { }',
        '    Text { Color = @Ink  Text <- Title }',
        '    VerticalBox { Native.Button Ok { } }',
        '}',
        '',
    ].join('\n');
    assert.deepEqual(judged(screen, index, TAGS), []);
});

test('under a namespace, everything the library has reads ns. -- and only that way', () => {
    const index = indexWith(FAMILY);
    const screen = [
        'use "UI/Common.dui" as ui',
        'Widget Root : ui.Caption {',
        '    ui.Row Item_0 { Color = @ui.Ink  Tint = @ui.pal.Swatch }',
        '    ui.Slider Volume { }',
        '}',
        '',
    ].join('\n');
    assert.deepEqual(judged(screen, index, TAGS), []);
    // Unqualified, the same names are not in scope: the compiler entered them under `ui.` only.
    const unqualified = screen.replace(': ui.Caption', ': Caption').replace('@ui.Ink', '@Ink');
    assert.deepEqual(judged(unqualified, index).map((line) => line.split(' ')[0]), ['DUI3004', 'DUI4007']);
});

test('a namespaced name the library lacks is said, as a warning, once every import was followed', () => {
    const index = indexWith(FAMILY);
    const screen = 'use "UI/Common.dui" as ui\nWidget Root : ui.Caption {\n    Text T : ui.Lable { Color = @ui.Inc }\n}\n';
    assert.deepEqual(judged(screen, index), [
        "DUI3004 warning 'ui.Lable' names a style this file does not declare",
        "DUI4007 warning '@ui.Inc' names no entry in a resources block",
    ]);
    // A library the index cannot find: nothing can be said about what it holds.
    assert.deepEqual(judged(screen, indexWith({})), []);
});

test('DUI3021 from the index: a prefix no import declares, carried or written', () => {
    const index = indexWith(FAMILY);
    // `pal` is the library's own namespace; a plain use brings it along, so `@pal.Swatch` is fine here...
    assert.deepEqual(judged('use "UI/Common.dui"\nWidget Root { Tint = @pal.Swatch }\n', index), []);
    // ...and `nier` is nobody's.
    assert.deepEqual(judged('use "UI/Common.dui"\nWidget Root { Tint = @nier.Ink }\n', index), [
        `DUI3021 warning 'nier.Ink' is qualified by 'nier', which no 'use "..." as nier' declares`,
    ]);
    // A component's `as` name is not a namespace either, and the index can tell which one a file is.
    assert.deepEqual(judged('use "UI/Components/Row.dui" as row\nWidget Root : row.RowOnly { }\n', index), [
        `DUI3021 warning 'row.RowOnly' is qualified by 'row', which no 'use "..." as row' declares`,
    ]);
});

test('a component used `as` brings its name and nothing else: its styles stay its own', () => {
    const index = indexWith(FAMILY);
    assert.deepEqual(judged('use "UI/Components/Row.dui" as Row\nWidget Root : RowOnly {\n    Row R { }\n}\n', index)
        .map((line) => line.split(' ')[0]), ['DUI3004']);
});

test('DUI3018: an alias a built-in tag or a container already answers to', () => {
    const index = indexWith(FAMILY);
    assert.deepEqual(judged('use /Game/UI/WBP_Text as Text\nWidget Root { }\n', index, TAGS), [
        "DUI3018 error 'Text' is already a built-in tag, which a node type means before any alias -- choose another name",
    ]);
    // A file's name is a component's only when the index sees a root in it -- and then a warning, the index's word.
    assert.deepEqual(judged('use "UI/Components/Row.dui" as VerticalBox\nWidget Root { }\n', index, TAGS), [
        "DUI3018 warning 'VerticalBox' is already a layout container (DreamLayoutContainerVerticalBox), which a node type means before any alias -- choose another name",
    ]);
    // A library under that name is a namespace, which no built-in shadows; nor does a spelling the dump does not have.
    assert.deepEqual(judged('use "UI/Palette.dui" as Text\nWidget Root { }\n', index, TAGS), []);
    assert.deepEqual(judged('use /Game/UI/WBP_Text as text\nWidget Root { }\n', index, TAGS), []);
});

test('the tag sweep knows aliases, own and imported, and says nothing while an import is out of sight', () => {
    const index = indexWith(FAMILY);
    assert.deepEqual(judged('use /Game/UI/WBP_Row as Row\nWidget Root {\n    Row A { }\n    Sparkle B { }\n}\n', index, TAGS),
        ["-- information 'Sparkle' is not a built-in tag (the compiler also accepts /asset paths)"]);
    // `use "Elsewhere.dui"` resolves to nothing here, and may well name Sparkle.
    assert.deepEqual(judged('use "Elsewhere.dui"\nWidget Root {\n    Sparkle B { }\n}\n', index, TAGS), []);
});

test('an @Name node type is a resource reference, said in the compiler\'s words when it is missing', () => {
    assert.deepEqual(judged('Widget Root {\n    @Row R { }\n}\n'), [
        "DUI4007 warning '@Row' names no entry in a resources block; a node type written with '@' is an Asset resource, as in 'Asset Row = /Game/UI/WBP_Row'",
    ]);
});

test('a library of component names alone declares no root on purpose', () => {
    assert.deepEqual(judged('use "UI/Components/Row.dui" as Row\nuse /Game/UI/WBP_Tab as Tab\n'), []);
});

test('the new grammar judges clean where it is well formed: props bound, emit, if/else, for, slots', () => {
    const text = [
        'class /Game/UI/WBP_Card',
        'props {',
        '    Text Label',
        '}',
        'events { Picked(Number Index); Closed }',
        'Widget Root {',
        '    Text Caption { Text <- Label }',
        '    Native.Button Ok { OnClicked -> emit Picked(1) }',
        '    if HasDetail() {',
        '        Image Detail { }',
        '    } else {',
        '        Text { Text = "none" }',
        '    }',
        '    VerticalBox List {',
        '        for Item in GetItems() {',
        '            Text { Text <- Item.Name }',
        '        }',
        '    }',
        '    slot Body default',
        '}',
        '',
    ].join('\n');
    assert.deepEqual(judged(text, indexWith({}), TAGS), []);
});
