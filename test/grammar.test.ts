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

/** The scopes on the token covering the first occurrence of `substring` on that line. */
function scopesAt(tokenized: TokenizedLine[], lineIndex: number, substring: string): string[] {
    const entry = tokenized[lineIndex];
    const at = entry.line.indexOf(substring);
    assert.ok(at >= 0, `${JSON.stringify(substring)} not in ${JSON.stringify(entry.line)}`);
    const covering = entry.tokens.find((token) => token.start <= at && at < token.end);
    assert.ok(covering, `no token covers ${JSON.stringify(substring)} in ${JSON.stringify(entry.line)}`);
    return covering.scopes;
}

function assertScope(tokenized: TokenizedLine[], lineIndex: number, substring: string, scope: string): void {
    const scopes = scopesAt(tokenized, lineIndex, substring);
    assert.ok(scopes.includes(scope),
        `${JSON.stringify(substring)} carries [${scopes.join(', ')}], expected ${scope}`);
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

test('every line of the real fixture gets at least the source scope', async () => {
    const fixture = fs.readFileSync(path.join(root, 'test', 'fixtures', 'SettingsPanel.dui'), 'utf8');
    const lines = await tokenize(fixture.split(/\r?\n/));
    for (const line of lines) {
        for (const token of line.tokens) {
            assert.ok(token.scopes.includes('source.dui'));
        }
    }
});
