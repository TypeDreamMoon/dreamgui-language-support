/**
 * The lexer, held to the compiler's behaviour. Structure of this file: one block per DUI1xxx code
 * with at least one positive and one negative case, then the token-shape facts the port has to
 * preserve (arrow before number, comments before paths, CRLF line counting, CJK identifiers), then
 * the fixture sweep -- a real .dui from the project must produce zero lexical diagnostics.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scan, Token, NAME_SIZE, RESERVED_WORDS, CONTEXTUAL_KEYWORDS, isIdentifierChar } from '../src/core/scanner';

function kinds(source: string): string[] {
    return scan(source).tokens.map((token) => token.kind);
}

function codes(source: string): number[] {
    return scan(source).diagnostics.map((diagnostic) => diagnostic.code);
}

function nonSeparator(source: string): Token[] {
    return scan(source).tokens.filter((token) => token.kind !== 'separator' && token.kind !== 'end');
}

// ---- DUI1001 unexpected character --------------------------------------------------------------

test('DUI1001: a run of unlexable characters is one diagnostic, not many', () => {
    const result = scan('Widget Root {\n    $$$^^\n}\n');
    assert.deepEqual(result.diagnostics.map((d) => d.code), [1001]);
    assert.match(result.diagnostics[0].message, /cannot begin anything/);
    assert.equal(result.diagnostics[0].line, 2);
});

test('DUI1001: every punctuation mark the grammar owns lexes clean', () => {
    assert.deepEqual(codes('{ } ( ) , . : = + @ ; -> <- #FFF "x" /Game/A -3 Name'), []);
});

test('DUI1001: a lone & or | is unexpected; the doubled forms are operators', () => {
    assert.deepEqual(scan('A & B').diagnostics.map((d) => d.code), [1001]);
    assert.deepEqual(scan('A | B').diagnostics.map((d) => d.code), [1001]);
    assert.deepEqual(codes('A && B'), []);
    assert.deepEqual(codes('A || B'), []);
});

// ---- DUI1002 unterminated string ---------------------------------------------------------------

test('DUI1002: a string that reaches end of line unclosed', () => {
    assert.deepEqual(codes('Text = "hello\nFontSize = 12\n'), [1002]);
});

test('DUI1002: closed strings decode their escapes', () => {
    const result = scan('Text = "a\\"b\\\\c\\nd"');
    assert.deepEqual(result.diagnostics, []);
    const literal = result.tokens.find((token) => token.kind === 'string')!;
    assert.equal(literal.text, 'a"b\\c\nd');
});

test('an undefined escape keeps both characters instead of eating the backslash', () => {
    const literal = scan('Text = "a\\qb"').tokens.find((token) => token.kind === 'string')!;
    assert.equal(literal.text, 'a\\qb');
});

// ---- DUI1003 unterminated comment --------------------------------------------------------------

test('DUI1003: a block comment that never closes', () => {
    assert.deepEqual(codes('Widget Root {\n/* forever\n}\n'), [1003]);
});

test('a block comment that crosses lines still ends the statement it started on', () => {
    const result = scan('A = 1 /* x\n y */ B = 2');
    assert.deepEqual(result.diagnostics, []);
    // ... via a synthetic separator between the two statements.
    const sequence = result.tokens.map((token) => token.kind);
    const aIndex = sequence.indexOf('number');
    assert.ok(sequence.slice(aIndex + 1).includes('separator'));
});

test('block comments move the line counter', () => {
    const result = scan('/* a\nb\nc */\nWidget Root {}\n');
    const widget = result.tokens.find((token) => token.kind === 'identifier')!;
    assert.equal(widget.line, 4);
});

// ---- DUI1004 malformed number ------------------------------------------------------------------

test('DUI1004: two decimal points, a trailing dot, a lone minus, a broken exponent', () => {
    assert.deepEqual(codes('A = 1.2.3'), [1004]);
    assert.deepEqual(codes('A = 12.'), [1004]);
    assert.deepEqual(codes('A = -'), [1004]);
    assert.deepEqual(codes('A = 400e'), [1004]);
    assert.deepEqual(codes('A = 1e+'), [1004]);
    assert.deepEqual(codes('A = -3px'), [1004]);
});

test('DUI1004: the shapes the designer writes back all lex clean', () => {
    assert.deepEqual(codes('A = -12\nB = 0.95\nC = 1e-45\nD = 1e+20\nE = 3.25E5'), []);
});

test('24px is not reported by the lexer: digit-leading words are the parser position\'s call', () => {
    const result = scan('A = 24px');
    assert.deepEqual(result.diagnostics, []);
    const number = result.tokens.find((token) => token.kind === 'number')!;
    assert.equal(number.digitLeadingWord, true);
    assert.equal(number.text, '24px');
});

test('a dot with no digit after it stays a dot token, not part of the number', () => {
    assert.deepEqual(kinds('AnchorData.SizeDelta = (0, 28)').slice(0, 3),
        ['identifier', 'dot', 'identifier']);
});

// ---- DUI1005 malformed hex colour --------------------------------------------------------------

test('DUI1005: wrong digit counts and non-hex digits', () => {
    assert.deepEqual(codes('A = #12345'), [1005]);
    assert.deepEqual(codes('A = #GGG'), [1005]);
    assert.deepEqual(codes('A = #FF'), [1005]);
});

test('DUI1005: 3, 4, 6 and 8 digits are the colours', () => {
    const result = scan('A = #FFF\nB = #FFFF\nC = #1B1D23\nD = #AABBCCDD\nE = #0077ff');
    assert.deepEqual(result.diagnostics, []);
    const colors = result.tokens.filter((token) => token.kind === 'hexColor').map((token) => token.text);
    assert.deepEqual(colors, ['FFF', 'FFFF', '1B1D23', 'AABBCCDD', '0077ff']);
});

// ---- DUI1006 identifier too long ---------------------------------------------------------------

test('DUI1006: a name at NAME_SIZE is refused, one below it is not', () => {
    assert.deepEqual(codes(`Text ${'A'.repeat(NAME_SIZE - 1)} {}`), []);
    assert.deepEqual(codes(`Text ${'A'.repeat(NAME_SIZE)} {}`), [1006]);
    assert.deepEqual(codes(`Text ${'A'.repeat(NAME_SIZE + 500)} {}`), [1006]);
});

test('DUI1006: the message ellipsizes the offender and names both lengths', () => {
    const result = scan(`Text ${'A'.repeat(NAME_SIZE)} {}`);
    assert.equal(result.diagnostics[0].message,
        `'${'A'.repeat(16)}...' is ${NAME_SIZE} characters long, and a name here holds at most ${NAME_SIZE - 1}`);
    assert.equal(result.diagnostics[0].line, 1);
    assert.equal(result.diagnostics[0].column, 6);
});

test('DUI1006: the token is emitted truncated, so the file goes on lexing', () => {
    const result = scan(`Text ${'A'.repeat(NAME_SIZE)} {\n    FontSize = 18\n}\n`);
    const identifiers = result.tokens.filter((token) => token.kind === 'identifier');
    assert.equal(identifiers[1].text.length, NAME_SIZE - 1);
    // Everything after it still lexes: one diagnostic, and the property is still a property.
    assert.deepEqual(result.diagnostics.map((d) => d.code), [1006]);
    assert.deepEqual(identifiers.map((token) => token.text.length),
        [4, NAME_SIZE - 1, 'FontSize'.length]);
});

test('DUI1006: length is counted in UTF-16 units, so a CJK name measures as the compiler measures it', () => {
    assert.deepEqual(codes(`Text ${'名'.repeat(NAME_SIZE - 1)} {}`), []);
    assert.deepEqual(codes(`Text ${'名'.repeat(NAME_SIZE)} {}`), [1006]);
});

// ---- token shapes the port must preserve -------------------------------------------------------

test('-> lexes as the event arrow, not a malformed negative', () => {
    assert.deepEqual(nonSeparator('OnClicked -> Confirm').map((token) => token.kind),
        ['identifier', 'eventArrow', 'identifier']);
});

test('<- lexes as the binding arrow', () => {
    assert.deepEqual(nonSeparator('Text <- GetTitle()').map((token) => token.kind),
        ['identifier', 'arrow', 'identifier', 'openParen', 'closeParen']);
});

// ---- the expression operators, born when `<-` learned expressions ------------------------------

test('<-> lexes as the two-way arrow, three characters and one token', () => {
    assert.deepEqual(nonSeparator('Value <-> Volume').map((token) => token.kind),
        ['identifier', 'twoWayArrow', 'identifier']);
    const arrow = scan('Value <-> Volume').tokens.find((token) => token.kind === 'twoWayArrow')!;
    assert.equal(arrow.text, '<->');
});

test('the comparison and logic operators all lex clean', () => {
    assert.deepEqual(nonSeparator('a == b != c <= d >= e < f > g').map((token) => token.kind),
        ['identifier', 'equalEqual', 'identifier', 'bangEqual', 'identifier', 'lessEqual',
            'identifier', 'greaterEqual', 'identifier', 'less', 'identifier', 'greater', 'identifier']);
    assert.deepEqual(nonSeparator('!IsBusy() && a || b').map((token) => token.kind),
        ['bang', 'identifier', 'openParen', 'closeParen', 'ampAmp', 'identifier', 'pipePipe', 'identifier']);
    assert.deepEqual(nonSeparator('a * b % c + d').map((token) => token.kind),
        ['identifier', 'star', 'identifier', 'percent', 'identifier', 'plus', 'identifier']);
});

test('a - after an operand is subtraction; anywhere else it starts a number', () => {
    // `A - 5` and `Count() - Base()`: the previous token is an operand, so the operator.
    assert.deepEqual(nonSeparator('A - 5').map((token) => token.kind),
        ['identifier', 'minus', 'number']);
    assert.deepEqual(nonSeparator('Count() - Base()').map((token) => token.kind).slice(3, 5),
        ['minus', 'identifier']);
    // `X = -5` and `(400, -240)`: the previous token is '=' or ',', so the sign.
    assert.deepEqual(nonSeparator('X = -5').map((token) => token.kind),
        ['identifier', 'equals', 'number']);
    assert.deepEqual(nonSeparator('P = (400, -240)').map((token) => token.kind),
        ['identifier', 'equals', 'openParen', 'number', 'comma', 'number', 'closeParen']);
    // A lone minus where a value belongs keeps reporting as the malformed number it always was.
    assert.deepEqual(codes('A = -'), [1004]);
});

test('a - with a word or a ( after it is negation, so `<- -Count()` is not a malformed number', () => {
    // The third reading, and the one the port dropped: DreamUISourceFile.cpp's bNegationFollows.
    // Without it lexNumber's trailing sweep swallowed the identifier and reported DUI1004 on a line
    // the compiler accepts -- a red squiggle the extension is never allowed to raise.
    assert.deepEqual(codes('Opacity <- -Count()'), []);
    assert.deepEqual(nonSeparator('Opacity <- -Count()').map((token) => token.kind),
        ['identifier', 'arrow', 'minus', 'identifier', 'openParen', 'closeParen']);
    assert.deepEqual(codes('Opacity <- -(A + B)'), []);
    assert.deepEqual(nonSeparator('Opacity <- -(A + B)').map((token) => token.kind),
        ['identifier', 'arrow', 'minus', 'openParen', 'identifier', 'plus', 'identifier', 'closeParen']);
    // Still narrow: a digit after the minus is a number's sign, as it always was.
    assert.deepEqual(nonSeparator('Opacity <- -5').map((token) => token.kind),
        ['identifier', 'arrow', 'number']);
});

test('a < against a negative number needs the space: `a < -1` compares, `a <-1` binds', () => {
    assert.deepEqual(nonSeparator('a < -1').map((token) => token.kind),
        ['identifier', 'less', 'number']);
    assert.deepEqual(nonSeparator('a <-1').map((token) => token.kind),
        ['identifier', 'arrow', 'number']);
});

test('<< is two less-thans now, and <<- still surfaces the arrow', () => {
    assert.deepEqual(nonSeparator('A << B').map((token) => token.kind),
        ['identifier', 'less', 'less', 'identifier']);
    assert.deepEqual(nonSeparator('A <<- B').map((token) => token.kind),
        ['identifier', 'less', 'arrow', 'identifier']);
});

test('a / that abuts an identifier separates node ids; anywhere else it starts an asset path', () => {
    // The timeline grammar's one new token. Without it `Row/Title` reads as the identifier `Row`
    // followed by the asset path `/Title.RenderOpacity`, and neither the compiler nor this mirror
    // can see one path -- DreamUISourceFile.cpp grew the same rule at the same time.
    assert.deepEqual(nonSeparator('Row/Title.RenderOpacity : 0 = 1').map((token) => token.kind),
        ['identifier', 'slash', 'identifier', 'dot', 'identifier', 'colon', 'number', 'equals', 'number']);
    // A space is enough to make it a path again, which is what keeps `class /Game/UI/X` a path.
    assert.deepEqual(nonSeparator('class /Game/UI/WBP_X').map((token) => token.kind),
        ['identifier', 'assetPath']);
    assert.deepEqual(nonSeparator('Content = /Game/UI/WBP_X').map((token) => token.kind),
        ['identifier', 'equals', 'assetPath']);
    // And the comment check still comes first, so an identifier followed by `//` is a comment.
    assert.deepEqual(nonSeparator('FontSize = 24 // note').map((token) => token.kind),
        ['identifier', 'equals', 'number']);
});

test('a comment can contain an asset path without producing a path token', () => {
    assert.deepEqual(nonSeparator('// see /Game/UI/WBP_X\nA = 1').map((token) => token.kind),
        ['identifier', 'equals', 'number']);
});

test('asset paths take engine spelling, dots and CJK included', () => {
    const result = scan('Font = /Game/UI/字体/WBP_Card.WBP_Card_C');
    assert.deepEqual(result.diagnostics, []);
    const asset = result.tokens.find((token) => token.kind === 'assetPath')!;
    assert.equal(asset.text, '/Game/UI/字体/WBP_Card.WBP_Card_C');
});

test('CJK identifiers are ordinary identifiers', () => {
    const tokens = nonSeparator('Text 标题 { }');
    assert.deepEqual(tokens.map((token) => token.kind), ['identifier', 'identifier', 'openBrace', 'closeBrace']);
    assert.equal(tokens[1].text, '标题');
});

test('a semicolon is a separator, exactly like a newline', () => {
    assert.deepEqual(kinds('A = 1; B = 2').filter((kind) => kind === 'separator').length, 1);
});

test('line and column are 1-based and agree across LF, CRLF and CR', () => {
    for (const lineBreak of ['\n', '\r\n', '\r']) {
        const result = scan(`Widget Root {${lineBreak}    FontSize = 18${lineBreak}}`);
        const fontSize = result.tokens.find((token) => token.text === 'FontSize')!;
        assert.equal(fontSize.line, 2, `line break ${JSON.stringify(lineBreak)}`);
        assert.equal(fontSize.column, 5, `line break ${JSON.stringify(lineBreak)}`);
    }
});

test('token offsets slice the source back out verbatim', () => {
    const source = 'Image ConfirmButton {\n    Brush.TintColor = #0077ff\n}';
    const result = scan(source);
    for (const token of result.tokens) {
        if (token.kind === 'identifier' || token.kind === 'assetPath' || token.kind === 'number') {
            assert.equal(source.slice(token.start, token.end), token.text);
        }
    }
});

// ---- fixture sweep -----------------------------------------------------------------------------

test('the real SettingsPanel.dui produces zero lexical diagnostics', () => {
    const fixture = fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'SettingsPanel.dui'), 'utf8');
    const result = scan(fixture);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.tokens.length > 100);
});

// ---- the words the language grew -----------------------------------------------------------------

test('the reserved words are the compiler\'s twelve, and the contextual ones are none of them', () => {
    assert.deepEqual([...RESERVED_WORDS].sort(),
        ['class', 'each', 'ease', 'external', 'for', 'in', 'resources', 'slot', 'style', 'timeline', 'use', 'was']);
    assert.deepEqual([...CONTEXTUAL_KEYWORDS].sort(),
        ['as', 'default', 'else', 'emit', 'events', 'fill', 'global', 'if', 'new', 'parent', 'props', 'viewmodels']);
    for (const word of CONTEXTUAL_KEYWORDS) {
        assert.equal(RESERVED_WORDS.has(word), false, word);
    }
});

test('the newer spellings lex from the tokens there were: @fill 2, ns.Name, use … as, emit, a condition', () => {
    assert.deepEqual(kinds('@fill 2'), ['at', 'identifier', 'number', 'end']);
    assert.deepEqual(kinds(': nier.Label'), ['colon', 'identifier', 'dot', 'identifier', 'end']);
    assert.deepEqual(kinds('use "Row.dui" as Row'), ['identifier', 'string', 'identifier', 'identifier', 'end']);
    assert.deepEqual(kinds('use /Game/UI/WBP_Row as Row'), ['identifier', 'assetPath', 'identifier', 'identifier', 'end']);
    assert.deepEqual(kinds('OnClick -> emit Picked(-1)'),
        ['identifier', 'eventArrow', 'identifier', 'identifier', 'openParen', 'number', 'closeParen', 'end']);
    assert.deepEqual(kinds('if !HasSave() && -Count() < 0 {'),
        ['identifier', 'bang', 'identifier', 'openParen', 'closeParen', 'ampAmp', 'minus', 'identifier', 'openParen',
            'closeParen', 'less', 'number', 'openBrace', 'end']);
    assert.deepEqual(codes('Enum /Script/Game.EKind Kind = Cycle'), []);
});

test('isIdentifierChar is the rule a made id sanitizes a type with', () => {
    const sanitized = (type: string): string =>
        [...type].map((char) => (isIdentifierChar(char.charCodeAt(0)) ? char : '_')).join('');
    assert.equal(sanitized('nier.Row'), 'nier_Row');
    assert.equal(sanitized('@Row'), '_Row');
    assert.equal(sanitized('/Game/UI/WBP_行'), '_Game_UI_WBP_行');
});
