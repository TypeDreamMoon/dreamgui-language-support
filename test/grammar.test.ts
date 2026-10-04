/**
 * The TextMate grammar, actually run. A broken tmLanguage rule does not error anywhere -- some
 * construct just quietly loses its colour -- so validating the JSON is not enough: these tests
 * tokenize real lines with vscode-textmate + oniguruma and assert the scopes that the grammar
 * promises, including the two stateful regions (resources blocks and block comments).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vsctm from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';

const root = path.join(__dirname, '..', '..');
const grammarPath = path.join(root, 'syntaxes', 'dui.tmLanguage.json');

const wasm = fs.readFileSync(path.join(root, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'));
const onigLib = oniguruma.loadWASM(wasm.buffer as ArrayBuffer).then(() => ({
    createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
    createOnigString: (content: string) => new oniguruma.OnigString(content),
}));

const registry = new vsctm.Registry({
    onigLib,
    loadGrammar: async (scopeName) => scopeName === 'source.dui'
        ? vsctm.parseRawGrammar(fs.readFileSync(grammarPath, 'utf8'), grammarPath)
        : null,
});

interface TokenizedLine {
    line: string;
    tokens: { start: number; end: number; scopes: string[] }[];
}

async function tokenize(lines: string[]): Promise<TokenizedLine[]> {
    const grammar = (await registry.loadGrammar('source.dui'))!;
    const out: TokenizedLine[] = [];
    let ruleStack = vsctm.INITIAL;
    for (const line of lines) {
        const result = grammar.tokenizeLine(line, ruleStack);
        ruleStack = result.ruleStack;
        out.push({
            line,
            tokens: result.tokens.map((token) => ({
                start: token.startIndex, end: token.endIndex, scopes: token.scopes,
            })),
        });
    }
    return out;
}

/**
 * The scopes on the token covering an occurrence of `substring` on that line -- the first one, or
 * the `occurrence`-th (0-based) when a line says the same word twice (`nier.Row Audio : nier.Label`).
 */
function scopesAt(tokenized: TokenizedLine[], lineIndex: number, substring: string, occurrence = 0): string[] {
    const entry = tokenized[lineIndex];
    let at = entry.line.indexOf(substring);
    for (let skipped = 0; skipped < occurrence && at >= 0; skipped++) {
        at = entry.line.indexOf(substring, at + 1);
    }
    assert.ok(at >= 0, `${JSON.stringify(substring)} (#${occurrence}) not in ${JSON.stringify(entry.line)}`);
    const covering = entry.tokens.find((token) => token.start <= at && at < token.end);
    assert.ok(covering, `no token covers ${JSON.stringify(substring)} in ${JSON.stringify(entry.line)}`);
    return covering.scopes;
}

function assertScope(tokenized: TokenizedLine[], lineIndex: number, substring: string, scope: string, occurrence = 0): void {
    const scopes = scopesAt(tokenized, lineIndex, substring, occurrence);
    assert.ok(scopes.includes(scope),
        `${JSON.stringify(substring)} carries [${scopes.join(', ')}], expected ${scope}`);
}

function assertNoScope(tokenized: TokenizedLine[], lineIndex: number, substring: string, scope: string, occurrence = 0): void {
    const scopes = scopesAt(tokenized, lineIndex, substring, occurrence);
    assert.ok(!scopes.includes(scope),
        `${JSON.stringify(substring)} carries [${scopes.join(', ')}], which should not include ${scope}`);
}

test('the class line: keyword and namespace', async () => {
    const lines = await tokenize(['class /Game/UI/WBP_Panel']);
    assertScope(lines, 0, 'class', 'keyword.control.class.dui');
    assertScope(lines, 0, '/Game/UI/WBP_Panel', 'entity.name.namespace.dui');
});

test('a node header: tag, id, worn style', async () => {
    const lines = await tokenize(['    Text Title : Label {']);
    assertScope(lines, 0, 'Text', 'entity.name.tag.dui');
    assertScope(lines, 0, 'Title', 'entity.name.section.id.dui');
    assertScope(lines, 0, 'Label', 'entity.other.inherited-class.style.dui');
});

test('a rename clause: was keyword and the old id', async () => {
    const lines = await tokenize(['Widget Root (was: OldRoot) {']);
    assertScope(lines, 0, 'was', 'keyword.control.was.dui');
    assertScope(lines, 0, 'OldRoot', 'entity.name.section.oldid.dui');
});

test('a component line: the + and the class', async () => {
    const lines = await tokenize(['    + Overlay {}', '    + /Script/DreamGUI.UIButton {']);
    assertScope(lines, 0, '+', 'keyword.operator.component.dui');
    assertScope(lines, 0, 'Overlay', 'entity.name.type.component.dui');
    assertScope(lines, 1, '/Script/DreamGUI.UIButton', 'entity.name.type.component.dui');
});

test('the @slot directive and its property', async () => {
    const lines = await tokenize(['        @slot HorizontalAlignment = Center']);
    assertScope(lines, 0, '@slot', 'keyword.control.directive.slot.dui');
    assertScope(lines, 0, 'HorizontalAlignment', 'variable.other.property.slot.dui');
});

test('a binding and an event route', async () => {
    const lines = await tokenize(['    Text <- GetTitle()', '    OnClicked -> Confirm']);
    assertScope(lines, 0, '<-', 'keyword.operator.binding.dui');
    assertScope(lines, 0, 'GetTitle', 'entity.name.function.binding.dui');
    assertScope(lines, 1, '->', 'keyword.operator.event-route.dui');
    assertScope(lines, 1, 'Confirm', 'entity.name.function.handler.dui');
});

test('a resources block holds its state across lines', async () => {
    const lines = await tokenize(['resources {', '    Color Accent = #FF6600', '}']);
    assertScope(lines, 0, 'resources', 'keyword.control.resources.dui');
    assertScope(lines, 1, 'Color', 'storage.type.resource.dui');
    assertScope(lines, 1, 'Accent', 'variable.other.constant.resource.dui');
    assertScope(lines, 1, '#FF6600', 'constant.other.color.dui');
});

test('comments, including a block comment spanning lines', async () => {
    const lines = await tokenize(['// a note', '/* first', 'still inside */']);
    assertScope(lines, 0, '// a note', 'comment.line.double-slash.dui');
    assertScope(lines, 2, 'still inside', 'comment.block.dui');
});

test('an indented comment, or one after a `{` or `;`, is not a node whose type is a path `//`', async () => {
    const lines = await tokenize([
        '    // The scroll track and its thumb.',
        '        /// Three slashes, too.',
        '    Overlay { // The note',
        '    Spacing = 4; // The note',
        '    /Game/UI/WBP_Row Row { }',
    ]);
    assertScope(lines, 0, '// The', 'comment.line.double-slash.dui');
    assertScope(lines, 0, 'The', 'comment.line.double-slash.dui');
    assertNoScope(lines, 0, 'The', 'entity.name.section.id.dui');
    assertScope(lines, 1, 'Three', 'comment.line.double-slash.dui');
    assertScope(lines, 2, 'Overlay', 'entity.name.tag.dui');
    assertScope(lines, 2, 'The', 'comment.line.double-slash.dui');
    assertScope(lines, 3, 'The', 'comment.line.double-slash.dui');
    assertScope(lines, 4, '/Game/UI/WBP_Row', 'entity.name.tag.dui');
    assertScope(lines, 4, 'Row {', 'entity.name.section.id.dui');
});

test('values: string, escape, number, colour, resource reference, asset path', async () => {
    const lines = await tokenize([
        '    Text = "a\\nb"',
        '    FontSize = -12.5',
        '    Tint = @Accent',
        '    Font = /DreamGUI/DefaultFont_DistanceField',
    ]);
    assertScope(lines, 0, '"', 'string.quoted.double.dui');
    assertScope(lines, 0, '\\n', 'constant.character.escape.dui');
    assertScope(lines, 1, '-12.5', 'constant.numeric.dui');
    assertScope(lines, 2, '@Accent', 'variable.other.constant.resource-ref.dui');
    assertScope(lines, 3, '/DreamGUI/DefaultFont_DistanceField', 'entity.name.namespace.assetpath.dui');
});

test('enum values are constants, aligned spelling included -- the blank-value defect', async () => {
    const lines = await tokenize([
        '        HAlign   = Left',
        '        @slot SizeRule = Auto',
        '        @slot VerticalAlignment   = Fill',
    ]);
    assertScope(lines, 0, 'HAlign', 'variable.other.property.dui');
    assertScope(lines, 0, '=', 'keyword.operator.assignment.dui');
    assertScope(lines, 0, 'Left', 'support.constant.property-value.dui');
    // The '@slot' line's '=' and value used to have no scope at all.
    assertScope(lines, 1, '=', 'keyword.operator.assignment.dui');
    assertScope(lines, 1, 'Auto', 'support.constant.property-value.dui');
    assertScope(lines, 2, 'Fill', 'support.constant.property-value.dui');
});

test('booleans and trailing comments keep their own scopes inside a value', async () => {
    const lines = await tokenize([
        '        bOverrideWidth = true',
        '        FontSize = 18 // aligned',
    ]);
    assertScope(lines, 0, 'true', 'constant.language.boolean.dui');
    assertScope(lines, 1, '// aligned', 'comment.line.double-slash.dui');
});

test('a loop header: keyword, variable, in', async () => {
    const lines = await tokenize(['    for Row in GetRows() {']);
    assertScope(lines, 0, 'for', 'keyword.control.loop.dui');
    assertScope(lines, 0, 'Row', 'variable.parameter.loop.dui');
});

test('a loop source: parens make it a call, their absence a variable', async () => {
    const lines = await tokenize(['    each Row in GetRows() {', '    each Item in Rows {']);
    assertScope(lines, 0, 'GetRows', 'entity.name.function.binding.dui');
    assertScope(lines, 1, 'Rows', 'variable.other.dui');
});

test('the use directive: keyword and quoted path', async () => {
    const lines = await tokenize(['use "Styles/Common.dui"']);
    assertScope(lines, 0, 'use', 'keyword.control.use.dui');
    assertScope(lines, 0, '"Styles/Common.dui"', 'string.quoted.double.import.dui');
});

test('a two-way binding: the arrow is its own operator and the right side a variable', async () => {
    const lines = await tokenize(['        Value <-> Volume']);
    assertScope(lines, 0, '<->', 'keyword.operator.binding.two-way.dui');
    assertScope(lines, 0, 'Volume', 'variable.other.dui');
});

test('a binding expression: calls, operators, bare variables, dotted item refs', async () => {
    const lines = await tokenize([
        '        Enabled <- !IsBusy() && Count() > 0',
        '        Text <- Item.Title',
        '        RenderOpacity <- GetScale() * 0.5 - Base',
    ]);
    assertScope(lines, 0, '<-', 'keyword.operator.binding.dui');
    assertScope(lines, 0, '!', 'keyword.operator.expression.dui');
    assertScope(lines, 0, 'IsBusy', 'entity.name.function.binding.dui');
    assertScope(lines, 0, '&&', 'keyword.operator.expression.dui');
    assertScope(lines, 0, '>', 'keyword.operator.expression.dui');
    assertScope(lines, 1, 'Item', 'variable.other.dui');
    assertScope(lines, 2, '*', 'keyword.operator.expression.dui');
    assertScope(lines, 2, 'Base', 'variable.other.dui');
});

// ---- the component syntax: use ... as, props, events, emit, slots, containers, if/for --------------

test('use ... as: a component file, a class path and a namespace, each with its name', async () => {
    const lines = await tokenize([
        'use "UI/Components/Row.dui" as Row',
        'use /Game/UI/WBP_Slider as Slider',
        'use "UI/NieR_Common.dui" as nier // a library, under a namespace',
    ]);
    assertScope(lines, 0, 'use', 'keyword.control.use.dui');
    assertScope(lines, 0, '"UI/Components/Row.dui"', 'string.quoted.double.import.dui');
    assertScope(lines, 0, 'as', 'keyword.control.as.dui');
    assertScope(lines, 0, 'Row', 'entity.name.type.alias.dui', 1);
    // The class form has no quotes: the path is a path, as it is everywhere else.
    assertScope(lines, 1, '/Game/UI/WBP_Slider', 'entity.name.namespace.assetpath.dui');
    assertScope(lines, 1, 'as', 'keyword.control.as.dui');
    assertScope(lines, 1, 'Slider', 'entity.name.type.alias.dui', 1);
    assertScope(lines, 2, 'nier', 'entity.name.type.alias.dui');
    assertScope(lines, 2, '// a library', 'comment.line.double-slash.dui');
});

test('a props block: type words, names, an enum path and defaults -- and the block closes', async () => {
    const lines = await tokenize([
        'props {',
        '    Text   Label',
        '    Number ValueIndex = 0',
        '    Enum   /Script/MyGame.ERowKind Kind = Cycle',
        '    Bool Ready = true; Color Tint = #FF6600',
        '}',
        'Widget Root {',
    ]);
    assertScope(lines, 0, 'props', 'keyword.control.props.dui');
    assertScope(lines, 1, 'Text', 'storage.type.prop.dui');
    assertScope(lines, 1, 'Label', 'entity.name.variable.prop.dui');
    assertScope(lines, 2, 'Number', 'storage.type.prop.dui');
    assertScope(lines, 2, 'ValueIndex', 'entity.name.variable.prop.dui');
    assertScope(lines, 2, '0', 'constant.numeric.dui');
    assertScope(lines, 3, 'Enum', 'storage.type.prop.dui');
    assertScope(lines, 3, '/Script/MyGame.ERowKind', 'entity.name.namespace.assetpath.dui');
    assertScope(lines, 3, 'Kind', 'entity.name.variable.prop.dui', 1);
    assertScope(lines, 3, 'Cycle', 'support.constant.property-value.dui');
    // A ';' ends an entry the way a line break does.
    assertScope(lines, 4, 'Color', 'storage.type.prop.dui');
    assertScope(lines, 4, 'Tint', 'entity.name.variable.prop.dui');
    assertScope(lines, 4, '#FF6600', 'constant.other.color.dui');
    assertScope(lines, 5, '}', 'punctuation.section.block.end.dui');
    // Nothing of the block leaks past its '}'.
    assertScope(lines, 6, 'Widget', 'entity.name.tag.dui');
    assertScope(lines, 6, 'Root', 'entity.name.section.id.dui');
});

test('an unknown props type is left uncoloured, so the typo shows before the compiler says DUI6008', async () => {
    const lines = await tokenize(['props {', '    Float Gap = 4', '}']);
    assertNoScope(lines, 1, 'Float', 'storage.type.prop.dui');
});

test('an events block: names, typed parameters, and the one-line form', async () => {
    const lines = await tokenize([
        'events {',
        '    Changed(Number Index, Enum /Script/Game.EKind Kind)',
        '    Closed',
        '}',
        'events { Picked(Number Index); Closed }',
        'Widget Root {',
    ]);
    assertScope(lines, 0, 'events', 'keyword.control.events.dui');
    assertScope(lines, 1, 'Changed', 'entity.name.function.event.dui');
    assertScope(lines, 1, 'Number', 'storage.type.parameter.dui');
    assertScope(lines, 1, 'Index', 'variable.parameter.event.dui');
    assertScope(lines, 1, '/Script/Game.EKind', 'entity.name.namespace.assetpath.dui');
    assertScope(lines, 1, 'Kind', 'variable.parameter.event.dui', 1);
    assertScope(lines, 2, 'Closed', 'entity.name.function.event.dui');
    assertScope(lines, 4, 'Picked', 'entity.name.function.event.dui');
    assertScope(lines, 4, 'Index', 'variable.parameter.event.dui');
    assertScope(lines, 4, 'Closed', 'entity.name.function.event.dui');
    assertScope(lines, 4, '}', 'punctuation.section.block.end.dui');
    assertScope(lines, 5, 'Widget', 'entity.name.tag.dui');
});

test('emit: the keyword, the event it raises, its arguments -- and a bare emit is still a handler', async () => {
    const lines = await tokenize([
        '        OnClicked -> emit Changed(Index, -1)',
        '        OnPressed -> emit Closed',
        '        OnReleased -> emit',
        '    + UIButton { OnClick -> emit Picked(Base() + 1, @Gap) }',
    ]);
    assertScope(lines, 0, 'OnClicked', 'variable.other.event.dui');
    assertScope(lines, 0, '->', 'keyword.operator.event-route.dui');
    assertScope(lines, 0, 'emit', 'keyword.control.emit.dui');
    assertScope(lines, 0, 'Changed', 'entity.name.function.event.dui');
    assertScope(lines, 0, 'Index', 'variable.other.dui');
    assertScope(lines, 0, '-1', 'constant.numeric.dui');
    assertScope(lines, 1, 'emit', 'keyword.control.emit.dui');
    assertScope(lines, 1, 'Closed', 'entity.name.function.event.dui');
    // `emit` with no event after it names a handler, as the parser reads it.
    assertScope(lines, 2, 'emit', 'entity.name.function.handler.dui');
    assertScope(lines, 3, 'Picked', 'entity.name.function.event.dui');
    assertScope(lines, 3, 'Base', 'entity.name.function.binding.dui');
    assertScope(lines, 3, '@Gap', 'variable.other.constant.resource-ref.dui');
});

test('slot declarations: default, a style, a rename, in any order -- and a host\'s fill', async () => {
    const lines = await tokenize([
        '    slot Rows default : RowList {',
        '    slot Detail : nier.DetailPanel default',
        '    slot Footer (was: Bottom)',
        '    slot Detail {',
        '        Text Note { Text = "A length of wire." }',
    ]);
    assertScope(lines, 0, 'slot', 'keyword.control.slot.dui');
    assertScope(lines, 0, 'Rows', 'entity.name.tag.namedslot.dui');
    assertScope(lines, 0, 'default', 'storage.modifier.default.dui');
    assertScope(lines, 0, 'RowList', 'entity.other.inherited-class.style.dui');
    assertScope(lines, 1, 'DetailPanel', 'entity.other.inherited-class.style.dui');
    assertScope(lines, 1, 'default', 'storage.modifier.default.dui');
    assertScope(lines, 2, 'was', 'keyword.control.was.dui');
    assertScope(lines, 2, 'Bottom', 'entity.name.section.oldid.dui');
    assertScope(lines, 3, 'Detail', 'entity.name.tag.namedslot.dui');
    assertScope(lines, 4, 'Text', 'entity.name.tag.dui');
    assertScope(lines, 4, 'Note', 'entity.name.section.id.dui');
});

test('containers as node types, and nodes with no id', async () => {
    const lines = await tokenize([
        '    VerticalBox Categories : Lists {',
        '    HorizontalBox {',
        '        Text : Caption { Text = "Ready" }',
        '        Text { Text = "Status" }',
    ]);
    assertScope(lines, 0, 'VerticalBox', 'entity.name.tag.dui');
    assertScope(lines, 0, 'Categories', 'entity.name.section.id.dui');
    assertScope(lines, 0, 'Lists', 'entity.other.inherited-class.style.dui');
    assertScope(lines, 1, 'HorizontalBox', 'entity.name.tag.dui');
    assertScope(lines, 2, 'Text', 'entity.name.tag.dui');
    assertScope(lines, 2, 'Caption', 'entity.other.inherited-class.style.dui');
    // The second Text is the property of the block, not another node.
    assertScope(lines, 2, 'Text', 'variable.other.property.dui', 1);
    assertScope(lines, 3, 'Text', 'entity.name.tag.dui');
    assertScope(lines, 3, 'Text', 'variable.other.property.dui', 1);
});

test('a type alone on a line is not a node header -- it is the DUI2004 it always was', async () => {
    const lines = await tokenize(['    Text']);
    assertNoScope(lines, 0, 'Text', 'entity.name.tag.dui');
});

test('namespaced names: a node type, a style clause and a resource reference', async () => {
    const lines = await tokenize([
        '    nier.Row Audio : nier.Label {',
        '        Color = @nier.Ink',
        '    Native.Button Apply { }',
        '    @Row Video { }',
        'style Warning : ui.Caption {',
        '    /Script/MyGame.MyWidget Thing { }',
    ]);
    assertScope(lines, 0, 'nier', 'entity.name.tag.dui');
    assertScope(lines, 0, 'nier', 'entity.name.namespace.qualifier.dui');
    assertScope(lines, 0, 'Row', 'entity.name.tag.dui');
    assertNoScope(lines, 0, 'Row', 'entity.name.namespace.qualifier.dui');
    assertScope(lines, 0, 'Audio', 'entity.name.section.id.dui');
    assertScope(lines, 0, 'nier', 'entity.other.inherited-class.style.dui', 1);
    assertScope(lines, 0, 'nier', 'entity.name.namespace.qualifier.dui', 1);
    assertScope(lines, 0, 'Label', 'entity.other.inherited-class.style.dui');
    assertScope(lines, 1, 'nier', 'variable.other.constant.resource-ref.dui');
    assertScope(lines, 1, 'Ink', 'variable.other.constant.resource-ref.dui');
    // A registry scope is written like a namespace and reads like one.
    assertScope(lines, 2, 'Native', 'entity.name.namespace.qualifier.dui');
    assertScope(lines, 2, 'Button', 'entity.name.tag.dui');
    // `@Row`: the widget class a resources Asset entry names, as a node type.
    assertScope(lines, 3, '@Row', 'entity.name.tag.dui');
    assertScope(lines, 3, 'Video', 'entity.name.section.id.dui');
    assertScope(lines, 4, 'ui', 'entity.name.namespace.qualifier.dui');
    assertScope(lines, 4, 'Caption', 'entity.other.inherited-class.style.dui');
    // A class path's module is not a namespace.
    assertScope(lines, 5, 'MyGame', 'entity.name.tag.dui');
    assertNoScope(lines, 5, 'MyGame', 'entity.name.namespace.qualifier.dui');
});

test('@slot blocks and the @fill shorthands', async () => {
    const lines = await tokenize([
        '        @slot { HorizontalAlignment = Fill  Padding = (0, 8, 0, 0) }',
        '        @fill',
        '        @fill 2',
        '        Text Label : Caption { @fill }',
        '        @fill Filler { }',
        '        @slot {',
        '            MinDesiredSize = (515, 0)',
        '        }',
        '        Text After {',
    ]);
    assertScope(lines, 0, '@slot', 'keyword.control.directive.slot.dui');
    assertScope(lines, 0, 'HorizontalAlignment', 'variable.other.property.slot.dui');
    assertScope(lines, 0, 'Fill', 'support.constant.property-value.dui');
    // The second line of the block is a slot property too, not the first one's value.
    assertScope(lines, 0, 'Padding', 'variable.other.property.slot.dui');
    assertScope(lines, 0, '8', 'constant.numeric.dui');
    assertScope(lines, 1, '@fill', 'keyword.control.directive.fill.dui');
    assertNoScope(lines, 1, '@fill', 'variable.other.constant.resource-ref.dui');
    assertScope(lines, 2, '@fill', 'keyword.control.directive.fill.dui');
    assertScope(lines, 2, '2', 'constant.numeric.dui');
    assertScope(lines, 3, '@fill', 'keyword.control.directive.fill.dui');
    // `@fill Filler { }` is a node whose type a resource called fill names, as the parser reads it.
    assertScope(lines, 4, '@fill', 'entity.name.tag.dui');
    assertScope(lines, 4, 'Filler', 'entity.name.section.id.dui');
    assertScope(lines, 6, 'MinDesiredSize', 'variable.other.property.slot.dui');
    assertScope(lines, 8, 'Text', 'entity.name.tag.dui');
});

test('a style carries components and slot lines', async () => {
    const lines = await tokenize([
        'style RowColumn : Column {',
        '    + VerticalBox { Spacing = 15 }',
        '    @fill',
        '    @slot Padding = (0, 4, 0, 0)',
        '}',
    ]);
    assertScope(lines, 0, 'RowColumn', 'entity.name.type.style.dui');
    assertScope(lines, 1, 'VerticalBox', 'entity.name.type.component.dui');
    assertScope(lines, 1, 'Spacing', 'variable.other.property.dui');
    assertScope(lines, 2, '@fill', 'keyword.control.directive.fill.dui');
    assertScope(lines, 3, 'Padding', 'variable.other.property.slot.dui');
});

test('if / else if / else: keywords and conditions -- and a property named if stays a property', async () => {
    const lines = await tokenize([
        '    if HasSave() {',
        '    } else if IsLoading() && Count() > 0 {',
        '    } else {',
        '    }',
        '    else {',
        '    if = 1',
        '    if bShowCount {',
    ]);
    assertScope(lines, 0, 'if', 'keyword.control.conditional.dui');
    assertScope(lines, 0, 'HasSave', 'entity.name.function.binding.dui');
    assertNoScope(lines, 0, 'if', 'entity.name.tag.dui');
    assertScope(lines, 1, 'else', 'keyword.control.conditional.dui');
    assertScope(lines, 1, 'if', 'keyword.control.conditional.dui');
    assertScope(lines, 1, 'IsLoading', 'entity.name.function.binding.dui');
    assertScope(lines, 1, '&&', 'keyword.operator.expression.dui');
    assertScope(lines, 2, 'else', 'keyword.control.conditional.dui');
    assertScope(lines, 4, 'else', 'keyword.control.conditional.dui');
    assertScope(lines, 5, 'if', 'variable.other.property.dui');
    assertScope(lines, 6, 'bShowCount', 'variable.other.dui');
});

test('for: the header, and the template\'s Item.Member bindings', async () => {
    const lines = await tokenize([
        '    for Item in GetItems() {',
        '        Row : Counted { Label <- Item.Label  Count <- Item.Count }',
        '    for Hint in KeyHints {',
    ]);
    assertScope(lines, 0, 'for', 'keyword.control.loop.dui');
    assertScope(lines, 0, 'Item', 'variable.parameter.loop.dui');
    assertScope(lines, 0, 'in', 'keyword.control.loop.dui');
    assertScope(lines, 0, 'GetItems', 'entity.name.function.binding.dui');
    assertScope(lines, 1, 'Row', 'entity.name.tag.dui');
    assertScope(lines, 1, 'Label', 'variable.other.property.dui');
    assertScope(lines, 1, 'Item.Label', 'variable.other.dui');
    // The second binding of the one-line block is its own property, not part of the first expression.
    assertScope(lines, 1, 'Count', 'variable.other.property.dui', 1);
    assertScope(lines, 1, '<-', 'keyword.operator.binding.dui', 1);
    assertScope(lines, 2, 'KeyHints', 'variable.other.dui');
});

test('one-line blocks: each statement is its own property, after spaces or a ";"', async () => {
    const lines = await tokenize([
        '    + UIButton { TransitionType = None  bCanNavigateHere = false }',
        '    Tab Tab_0 : NavTab { Label = "MAP"; Icon = @IconMap }',
        '    RectBlock Key0 : KeyCap { Text KeyText0 : KeyCapText {} }',
        '    Text Note { Text = "OK" @key("Dialog.Confirm") }',
    ]);
    assertScope(lines, 0, 'bCanNavigateHere', 'variable.other.property.dui');
    assertNoScope(lines, 0, 'bCanNavigateHere', 'support.constant.property-value.dui');
    assertScope(lines, 0, 'false', 'constant.language.boolean.dui');
    assertScope(lines, 1, 'Icon', 'variable.other.property.dui');
    assertScope(lines, 1, '@IconMap', 'variable.other.constant.resource-ref.dui');
    // A child node written inside a one-line body is a node.
    assertScope(lines, 2, 'Text', 'entity.name.tag.dui');
    assertScope(lines, 2, 'KeyText0', 'entity.name.section.id.dui');
    assertScope(lines, 2, 'KeyCapText', 'entity.other.inherited-class.style.dui');
    // `@key` after a string value is the key override, not a resource reference.
    assertScope(lines, 3, '@key', 'keyword.control.directive.key.dui');
});

test('a binding comparing with == does not end at the second =', async () => {
    const lines = await tokenize(['        Shown <- Count == 0 && !IsLocked()']);
    assertScope(lines, 0, 'Shown', 'variable.other.property.dui');
    assertScope(lines, 0, 'IsLocked', 'entity.name.function.binding.dui');
});

test('a timeline: settings, tracks, eases and event keys, then the file goes on', async () => {
    const lines = await tokenize([
        'timeline Pulse {',
        '    duration = 0.6',
        '    loop     = PingPong',
        '    Icon.RenderScale : 0.0 = (1, 1, 1), 0.3 = (1.25, 1.25, 1) ease InOutQuad, 0.6 = (1, 1, 1)',
        '    Row/Title.RenderTranslation : 0.0 = (-40, 0, 0), 0.2 = (0, 0, 0) ease OutCubic',
        '    @0.3 -> Landed',
        '}',
        'timeline Celebrate external',
        'Widget After {',
    ]);
    assertScope(lines, 0, 'timeline', 'keyword.control.timeline.dui');
    assertScope(lines, 0, 'Pulse', 'entity.name.type.timeline.dui');
    assertScope(lines, 1, 'duration', 'keyword.other.timeline.dui');
    assertScope(lines, 1, '0.6', 'constant.numeric.dui');
    assertScope(lines, 2, 'PingPong', 'support.constant.property-value.dui');
    assertScope(lines, 3, 'Icon.RenderScale', 'variable.other.property.track.dui');
    assertNoScope(lines, 3, 'Icon.RenderScale', 'entity.name.tag.dui');
    assertScope(lines, 3, 'ease', 'keyword.other.ease.dui');
    assertScope(lines, 3, 'InOutQuad', 'support.function.ease.dui');
    assertScope(lines, 4, 'Row/Title.RenderTranslation', 'variable.other.property.track.dui');
    assertScope(lines, 4, '-40', 'constant.numeric.dui');
    assertScope(lines, 5, '->', 'keyword.operator.event-route.dui');
    assertScope(lines, 5, 'Landed', 'entity.name.function.event.dui');
    assertScope(lines, 6, '}', 'punctuation.section.block.end.dui');
    assertScope(lines, 7, 'timeline', 'keyword.control.timeline.dui');
    assertScope(lines, 7, 'external', 'storage.modifier.external.dui');
    assertScope(lines, 8, 'Widget', 'entity.name.tag.dui');
});

/**
 * The plugin's worked example (Docs/DuiLanguage.md, "A worked example"), the screen and the component
 * together: every token keeps the source scope, the key constructs carry theirs, and no region is
 * left open at the end -- a line after the file's last '}' is still a node header.
 */
const WORKED_EXAMPLE = [
    'class /Game/UI/Settings/WBP_SettingsRow',
    'use "Settings/SettingsLibrary.dui"',
    '',
    'props {',
    '    Text   Label',
    '    Text   Value',
    '    Number Index = 0',
    '}',
    'events {',
    '    Changed(Number Index, Number Step)',
    '}',
    '',
    'Widget Root : RowBox {',
    '    + HorizontalBox { Padding = (16, 0, 16, 0)  Spacing = 12 }',
    '    + UIButton { TransitionType = None }',
    '',
    '    Text LabelText : Caption {',
    '        Text <- Label',
    '        @fill',
    '    }',
    '    Native.Button Previous : Arrow {',
    '        OnClicked -> emit Changed(Index, -1)',
    '        Text { Text = "◀" }',
    '    }',
    '}',
    '',
    'Widget Root {',
    '    + Overlay { }',
    '    Image Backdrop {',
    '        Brush.TintColor = @ui.Panel',
    '        @slot { HorizontalAlignment = Fill  VerticalAlignment = Fill }',
    '    }',
    '    VerticalBox Page {',
    '        Spacing = 24',
    '        Widget Rows : ui.Column {',
    '            ui.Row Audio {',
    '                Label = "Master volume"',
    '                Changed -> HandleVolumeChanged',
    '            }',
    '        }',
    '        if HasUnsavedChanges() {',
    '            Text UnsavedHint : ui.Caption {',
    '                Color = @ui.Muted',
    '            }',
    '        }',
    '        HorizontalBox {',
    '            Native.Button Apply { OnClicked -> HandleApply }',
    '            for Hint in KeyHints {',
    '                Text : ui.Caption { Text <- Hint.Label }',
    '            }',
    '        }',
    '    }',
    '}',
    'Widget After {',
];

test('the worked example tokenizes whole, and leaves no region open', async () => {
    const lines = await tokenize(WORKED_EXAMPLE);
    for (const line of lines) {
        for (const token of line.tokens) {
            assert.ok(token.scopes.includes('source.dui'));
        }
    }
    const lineOf = (text: string) => {
        const index = WORKED_EXAMPLE.indexOf(text);
        assert.ok(index >= 0, `${JSON.stringify(text)} is not a line of the example`);
        return index;
    };
    assertScope(lines, lineOf('    Number Index = 0'), 'Index', 'entity.name.variable.prop.dui');
    assertScope(lines, lineOf('        OnClicked -> emit Changed(Index, -1)'), 'emit', 'keyword.control.emit.dui');
    assertScope(lines, lineOf('            ui.Row Audio {'), 'Audio', 'entity.name.section.id.dui');
    assertScope(lines, lineOf('                Changed -> HandleVolumeChanged'), 'HandleVolumeChanged', 'entity.name.function.handler.dui');
    assertScope(lines, lineOf('        if HasUnsavedChanges() {'), 'if', 'keyword.control.conditional.dui');
    assertScope(lines, lineOf('            for Hint in KeyHints {'), 'for', 'keyword.control.loop.dui');
    assertScope(lines, lineOf('Widget After {'), 'Widget', 'entity.name.tag.dui');
    assertScope(lines, lineOf('Widget After {'), 'After', 'entity.name.section.id.dui');
});

test('every line of the real fixture gets at least the source scope', async () => {
    const fixture = fs.readFileSync(path.join(root, 'test', 'fixtures', 'SettingsPanel.dui'), 'utf8');
    const lines = await tokenize(fixture.split(/\r?\n/));
    for (const line of lines) {
        for (const token of line.tokens) {
            assert.ok(token.scopes.includes('source.dui'));
        }
    }
});

test('a rows table: the header keyword, type, style and columns; the rows are values', async () => {
    const lines = await tokenize([
        'Widget Root {',
        '    rows nier.Row : ListRow (Label, Anchor.SizeDelta) {',
        '        "City Ruins", (12, 4)',
        '        "Factory",    @Gap { Kind = Count }',
        '    }',
        '    rows = 3',
        '    rows Grid { }',
        '}',
    ]);
    assertScope(lines, 1, 'rows', 'keyword.control.rows.dui');
    assertScope(lines, 1, 'Row', 'entity.name.tag.dui');
    assertScope(lines, 1, 'ListRow', 'entity.other.inherited-class.style.dui');
    assertScope(lines, 1, 'Label', 'variable.other.property.dui');
    assertScope(lines, 1, 'SizeDelta', 'variable.other.property.dui');
    assertScope(lines, 2, '"City Ruins"', 'string.quoted.double.dui');
    assertScope(lines, 3, 'Kind', 'variable.other.property.dui');
    assertNoScope(lines, 5, 'rows', 'keyword.control.rows.dui');
    assertNoScope(lines, 6, 'rows', 'keyword.control.rows.dui');
});
