/**
 * What one file borrows from others, answered over a small workspace that has every shape the language reference
 * describes: a component with props, events and slots; a library that names it and is used plainly by one screen and
 * under a namespace by another; and a palette library the first library opens as a namespace of its own, which a
 * plain `use` carries along.
 *
 * Every jump is checked by slicing the TARGET file at the offsets it returns: a definition one word off is the defect
 * this layer exists to avoid.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import {
    namespacesVisibleFrom, plainImportClosure, findBorrowed, borrowableNames, namespaceMembers, componentFacts,
    definitionAt, hoverAt, anonymousNodeAt, propSignature, eventSignature,
} from '../src/core/componentIntel';

const ROOT = 'D:/Proj/DUI/UI';

const FILES: Record<string, string> = {
    [`${ROOT}/Components/Row.dui`]: `class /Game/UI/WBP_Row
use "UI/Common.dui"

props {
    Text Label
    Number Index = 0
}
events {
    Picked(Number Index)
    Closed
}

Widget Root : Caption {
    Text LabelText { Text <- Label }
    Native.Button Next { OnClicked -> emit Picked(Index) }
    slot Detail
    slot Rows default
}
`,
    [`${ROOT}/Common.dui`]: `use "UI/Components/Row.dui" as Row
use "UI/Palette.dui" as pal

resources {
    Color Ink = #E6E9F0
}

style Caption {
    FontSize = 18
    Color = @Ink
}
`,
    [`${ROOT}/Palette.dui`]: `resources {
    Color Accent = #FF6600
}

style Loud {
    FontSize = 40
}
`,
    [`${ROOT}/Screen.dui`]: `class /Game/UI/WBP_Screen
use "UI/Common.dui" as ui

Widget Root {
    ui.Row Audio : ui.Caption {
        Label = "Audio"
        Picked -> HandlePicked
        Color = @ui.Ink
        slot Detail {
            Text Note { Text = "x" }
        }
    }
    HorizontalBox {
        Text : ui.Caption { Text = "a" }
    }
}
`,
    [`${ROOT}/Menu.dui`]: `class /Game/UI/WBP_Menu
use "UI/Common.dui"

Widget Root {
    Row Item : Caption { Label = "Item" }
    Text T { Color = @pal.Accent }
    Text U : pal.Loud {}
}
`,
};

const ROW = `${ROOT}/Components/Row.dui`;
const COMMON = `${ROOT}/Common.dui`;
const PALETTE = `${ROOT}/Palette.dui`;
const SCREEN = `${ROOT}/Screen.dui`;
const MENU = `${ROOT}/Menu.dui`;

function workspace(): WorkspaceIndex {
    const index = new WorkspaceIndex();
    for (const [file, text] of Object.entries(FILES)) {
        index.update(file, text);
    }
    return index;
}

/** `needle`'s offset in `file`, plus `ahead` characters into it. */
function at(file: string, needle: string, ahead = 1, from = 0): number {
    const offset = FILES[file].indexOf(needle, from);
    assert.ok(offset >= 0, `'${needle}' is in ${file}`);
    return offset + ahead;
}

/** Where F12 at `offset` lands, as [file, the text there]. */
function jump(file: string, offset: number): [string, string] | undefined {
    const hit = definitionAt(workspace(), file, buildStructure(FILES[file]), offset);
    if (!hit) {
        return undefined;
    }
    return [hit.target.file, FILES[hit.target.file].slice(hit.target.start, hit.target.end)];
}

// ---- the walk ----------------------------------------------------------------------------------------------------

test('a plain use is followed; an as is not part of the plain walk', () => {
    const index = workspace();
    assert.deepEqual(plainImportClosure(index, MENU), [COMMON]);
    // Common names Row and opens pal: neither merges into Common plainly.
    assert.deepEqual(plainImportClosure(index, COMMON), []);
});

test('namespaces: a file\'s own, and those a plain use carries', () => {
    const index = workspace();
    assert.deepEqual(namespacesVisibleFrom(index, SCREEN).map((ns) => [ns.name, ns.file]), [['ui', COMMON]]);
    assert.deepEqual(namespacesVisibleFrom(index, MENU).map((ns) => [ns.name, ns.file]), [['pal', PALETTE]]);
    // Row.dui uses Common plainly too, and so sees pal.
    assert.deepEqual(namespacesVisibleFrom(index, ROW).map((ns) => ns.name), ['pal']);
});

test('a borrowed name is found where it is declared: plain import, namespace, or here', () => {
    const index = workspace();
    const caption = findBorrowed(index, MENU, 'style', 'Caption')!;
    assert.equal(caption.site.file, COMMON);
    assert.equal(caption.local, false);
    const namespaced = findBorrowed(index, SCREEN, 'style', 'ui.Caption')!;
    assert.equal(namespaced.site.file, COMMON);
    assert.equal(namespaced.namespace?.name, 'ui');
    assert.equal(findBorrowed(index, MENU, 'resource', 'pal.Accent')?.site.file, PALETTE);
    assert.equal(findBorrowed(index, COMMON, 'resource', 'Ink')?.local, true);
    assert.equal(findBorrowed(index, MENU, 'style', 'Loud'), undefined, 'pal is a namespace: Loud is pal.Loud');
    assert.equal(findBorrowed(index, MENU, 'style', 'nope.Caption'), undefined);
});

test('what a file can name without a namespace, and what one offers after its dot', () => {
    const index = workspace();
    assert.deepEqual(borrowableNames(index, MENU, 'style').map((entry) => entry.name), ['Caption']);
    assert.deepEqual(namespaceMembers(index, SCREEN, 'ui', 'style').map((entry) => entry.name), ['Caption']);
    assert.deepEqual(namespaceMembers(index, SCREEN, 'ui', 'resource').map((entry) => entry.name), ['Ink']);
    assert.deepEqual(namespaceMembers(index, SCREEN, 'ui', 'alias').map((entry) => entry.name), ['Row']);
    assert.deepEqual(namespaceMembers(index, SCREEN, 'nope', 'style'), []);
});

test('a component\'s facts: its file, its class, its props, events and slots', () => {
    const facts = componentFacts(workspace(), MENU, 'Row')!;
    assert.equal(facts.summary?.file, ROW);
    assert.equal(facts.classPath, '/Game/UI/WBP_Row');
    assert.deepEqual(facts.summary?.props.map((prop) => propSignature(prop)), ['Text Label', 'Number Index = 0']);
    assert.deepEqual(facts.summary?.events.map((event) => event.name), ['Picked', 'Closed']);
    assert.deepEqual(facts.summary?.slots.map((slot) => [slot.name, slot.isDefault]), [['Detail', false], ['Rows', true]]);
    assert.equal(componentFacts(workspace(), SCREEN, 'ui.Row')?.summary?.file, ROW);
    assert.equal(componentFacts(workspace(), MENU, 'Text'), undefined);
    assert.equal(componentFacts(workspace(), MENU, '/Game/UI/WBP_Row')?.summary?.file, ROW);
});

// ---- go to definition --------------------------------------------------------------------------------------------

test('F12 on an alias lands on the component\'s class line; on use … as, on its target', () => {
    assert.deepEqual(jump(MENU, at(MENU, 'Row Item')), [ROW, '/Game/UI/WBP_Row']);
    assert.deepEqual(jump(COMMON, at(COMMON, 'as Row', 4)), [ROW, '/Game/UI/WBP_Row']);
});

test('F12 on ns.Row: the head goes to the library, the tail to the component', () => {
    const head = jump(SCREEN, at(SCREEN, 'ui.Row', 0));
    assert.equal(head?.[0], COMMON);
    assert.deepEqual(jump(SCREEN, at(SCREEN, 'ui.Row', 4)), [ROW, '/Game/UI/WBP_Row']);
});

test('F12 on a borrowed style or resource: the library\'s declaration', () => {
    assert.deepEqual(jump(SCREEN, at(SCREEN, 'ui.Caption', 5)), [COMMON, 'Caption']);
    assert.deepEqual(jump(SCREEN, at(SCREEN, '@ui.Ink', 5)), [COMMON, 'Ink']);
    assert.deepEqual(jump(MENU, at(MENU, ': Caption', 3)), [COMMON, 'Caption']);
    assert.deepEqual(jump(MENU, at(MENU, '@pal.Accent', 6)), [PALETTE, 'Accent']);
    assert.deepEqual(jump(MENU, at(MENU, 'pal.Loud', 5)), [PALETTE, 'Loud']);
    // The file's own: its own entry.
    assert.deepEqual(jump(COMMON, at(COMMON, '@Ink', 2)), [COMMON, 'Ink']);
});

test('F12 on an instance\'s lines: the component\'s prop, event and slot', () => {
    assert.deepEqual(jump(SCREEN, at(SCREEN, 'Label = "Audio"')), [ROW, 'Label']);
    assert.deepEqual(jump(SCREEN, at(SCREEN, 'Picked -> HandlePicked')), [ROW, 'Picked']);
    assert.deepEqual(jump(SCREEN, at(SCREEN, 'slot Detail', 6)), [ROW, 'Detail']);
    // A widget property of the instance is nobody's prop.
    assert.equal(jump(SCREEN, at(SCREEN, 'Color = @ui.Ink')), undefined);
});

test('F12 inside a component: emit to its events entry, a binding to its props entry', () => {
    assert.deepEqual(jump(ROW, at(ROW, 'emit Picked', 6)), [ROW, 'Picked']);
    const target = definitionAt(workspace(), ROW, buildStructure(FILES[ROW]), at(ROW, 'emit Picked', 6))!;
    assert.equal(target.target.start, FILES[ROW].indexOf('Picked(Number'));
    assert.deepEqual(jump(ROW, at(ROW, '<- Label', 4)), [ROW, 'Label']);
    assert.deepEqual(jump(ROW, at(ROW, 'Picked(Index)', 8)), [ROW, 'Index']);
});

test('local answers need no index', () => {
    const hit = definitionAt(undefined, ROW, buildStructure(FILES[ROW]), at(ROW, '<- Label', 4))!;
    assert.equal(FILES[ROW].slice(hit.target.start, hit.target.end), 'Label');
    assert.equal(hit.target.start, FILES[ROW].indexOf('Label'));
});

// ---- hover ------------------------------------------------------------------------------------------------------

function hover(file: string, offset: number): string | undefined {
    return hoverAt(workspace(), file, buildStructure(FILES[file]), offset)?.markdown;
}

test('hover on an alias: what it resolves to, and what it offers its hosts', () => {
    const text = hover(MENU, at(MENU, 'Row Item'))!;
    assert.match(text, /\*\*Row\*\* — component `Row\.dui` → `\/Game\/UI\/WBP_Row`/);
    assert.match(text, /named by `use … as Row` in `Common\.dui`/);
    assert.match(text, /`Text Label`, `Number Index = 0`/);
    assert.match(text, /`Picked\(Number Index\)`, `Closed`/);
    assert.match(text, /`Detail`, `Rows` \(default\)/);
});

test('hover on a namespace and on a borrowed name: where it comes from', () => {
    assert.match(hover(SCREEN, at(SCREEN, 'ui.Row', 0))!, /namespace: library `Common\.dui`/);
    assert.match(hover(SCREEN, at(SCREEN, 'as ui', 3))!, /namespace/);
    assert.match(hover(SCREEN, at(SCREEN, 'ui.Caption', 5))!, /style declared in `Common\.dui`.*use … as ui/);
    assert.match(hover(MENU, at(MENU, '@pal.Accent', 6))!, /`Color pal\.Accent` — resource declared in `Palette\.dui`/);
});

test('hover on emit, a prop and an event: their signatures', () => {
    assert.match(hover(ROW, at(ROW, 'emit Picked', 6))!, /`emit Picked\(Number Index\)` — raises the event declared on line 9/);
    assert.match(hover(ROW, at(ROW, 'Number Index = 0', 8))!, /`Number Index = 0` — prop/);
    assert.match(hover(ROW, at(ROW, '<- Label', 4))!, /`Text Label` — prop of this class \(line 5\)/);
    assert.match(hover(ROW, at(ROW, 'Closed'))!, /`Closed` — event dispatcher/);
    assert.match(hover(SCREEN, at(SCREEN, 'Label = "Audio"'))!, /`Text Label` — prop of `ui\.Row`/);
});

test('an unnamed node: the id it compiles to', () => {
    const structure = buildStructure(FILES[SCREEN]);
    assert.equal(anonymousNodeAt(structure, at(SCREEN, 'HorizontalBox'))?.id, 'Root__HorizontalBox0');
    assert.equal(anonymousNodeAt(structure, at(SCREEN, 'Text : ui.Caption'))?.id, 'Root__HorizontalBox0__Text0');
    assert.equal(anonymousNodeAt(structure, at(SCREEN, 'Text Note')), undefined);
});

test('signatures read like the file writes them', () => {
    const structure = buildStructure(FILES[ROW]);
    assert.deepEqual(structure.events.map(eventSignature), ['Picked(Number Index)', 'Closed']);
    assert.equal(propSignature({ type: 'Enum', enumPath: '/Script/M.EKind', name: 'Kind', defaultText: 'Cycle' }),
        'Enum /Script/M.EKind Kind = Cycle');
});

test('@Row as a type: the component when the workspace has its class, else the resource entry', () => {
    const source = 'resources {\n    Asset Row = /Game/UI/WBP_Row\n}\nWidget Root {\n    @Row Audio { Label = "x" }\n}\n';
    const component = 'class /Game/UI/WBP_Row\nprops {\n    Text Label\n}\nWidget Root {\n}\n';
    const structure = buildStructure(source);
    const at = source.indexOf('@Row') + 2;

    const full = new WorkspaceIndex();
    full.update('D:/P/DUI/Screen.dui', source);
    full.update('D:/P/DUI/Row.dui', component);
    const toClass = definitionAt(full, 'D:/P/DUI/Screen.dui', structure, at)!;
    assert.equal(toClass.target.file, 'D:/P/DUI/Row.dui');
    assert.equal(component.slice(toClass.target.start, toClass.target.end), '/Game/UI/WBP_Row');
    const toProp = definitionAt(full, 'D:/P/DUI/Screen.dui', structure, source.indexOf('Label') + 1)!;
    assert.equal(component.slice(toProp.target.start, toProp.target.end), 'Label');

    const alone = new WorkspaceIndex();
    alone.update('D:/P/DUI/Screen.dui', source);
    const toEntry = definitionAt(alone, 'D:/P/DUI/Screen.dui', structure, at)!;
    assert.equal(toEntry.target.file, 'D:/P/DUI/Screen.dui');
    assert.equal(source.slice(toEntry.target.start, toEntry.target.end), 'Row');
});
