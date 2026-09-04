/**
 * The formatter: what it re-lays out, what it refuses to touch, and the guard rail that makes the
 * difference between the two safe to get wrong.
 *
 * Every case here is written as a whole file in and a whole file out, because that is the unit the
 * provider hands over and because a rule that reads fine on one line ("a '}' owns its line") is
 * only really specified by what it does to the line above and the line below.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatDui, tokenSignature } from '../src/core/format';

const SPACES = { indent: '    ', eol: '\n' } as const;

const format = (text: string): string => formatDui(text, SPACES);

test('block depth decides the indent, whatever the author left there', () => {
    const source = [
        'Widget Root {',
        'Text Title {',
        '        FontSize = 18',
        '  }',
        '}',
        '',
    ].join('\n');
    assert.equal(format(source), [
        'Widget Root {',
        '    Text Title {',
        '        FontSize = 18',
        '    }',
        '}',
        '',
    ].join('\n'));
});

test('operators take one space on each side', () => {
    const source = [
        'Widget Root {',
        '    Text Title:Heading {',
        '        FontSize=18',
        '        Text<-GetTitle()',
        '        OnClicked->Confirm',
        '        Value<->Volume',
        '    }',
        '}',
        '',
    ].join('\n');
    assert.equal(format(source), [
        'Widget Root {',
        '    Text Title : Heading {',
        '        FontSize = 18',
        '        Text <- GetTitle()',
        '        OnClicked -> Confirm',
        '        Value <-> Volume',
        '    }',
        '}',
        '',
    ].join('\n'));
});

test('padding that aligned an = is not alignment to this formatter', () => {
    // The reference corpus aligns its '=' into a column by hand. One space is what the designer's
    // write-back prints, and two tools writing one file have to agree; the collapse is the price.
    const source = 'style Heading {\n    Font     = /DreamGUI/Font\n    FontSize = 34\n}\n';
    assert.equal(format(source), 'style Heading {\n    Font = /DreamGUI/Font\n    FontSize = 34\n}\n');
});

test('a comma takes a space after it and none before, inside tuples and calls alike', () => {
    const source = 'Widget Root {\n    Padding=(24,20 , 24,16)\n    Text <- Join(A ,B)\n}\n';
    assert.equal(format(source),
        'Widget Root {\n    Padding = (24, 20, 24, 16)\n    Text <- Join(A, B)\n}\n');
});

test("a rename clause keeps the compiler's own spelling, and a call keeps none", () => {
    const source = 'Widget Root {\n    Text Ok(was:OkLabel) {}\n    Caption <- Describe( Ok )\n}\n';
    assert.equal(format(source),
        'Widget Root {\n    Text Ok (was: OkLabel) {}\n    Caption <- Describe(Ok)\n}\n');
});

test("a '}' owns its line, but an empty block stays where it is", () => {
    const source = 'Widget Root { + Overlay {} Text Title { FontSize = 18 } }\n';
    assert.equal(format(source), [
        'Widget Root {',
        '    + Overlay {}',
        '    Text Title {',
        '        FontSize = 18',
        '    }',
        '}',
        '',
    ].join('\n'));
});

test('runs of blank lines fold to one, trailing whitespace goes, the file ends in one newline', () => {
    const source = '\n\nWidget Root {   \n    A = 1\n\n\n\n    B = 2\n}\n\n\n';
    assert.equal(format(source), 'Widget Root {\n    A = 1\n\n    B = 2\n}\n');
});

test('a file with no line break at all still ends in exactly one', () => {
    assert.equal(format('Widget Root {}'), 'Widget Root {}\n');
});

test('comments keep their text; only the indent of the line they start moves', () => {
    const source = [
        '// a header',
        'Widget Root {   // trailing',
        '// a line of its own',
        '/* a block',
        '   with an aligned second line',
        '   and a third */',
        '    A = 1',
        '}',
        '',
    ].join('\n');
    assert.equal(format(source), [
        '// a header',
        'Widget Root { // trailing',
        '    // a line of its own',
        '    /* a block',
        '   with an aligned second line',
        '   and a third */',
        '    A = 1',
        '}',
        '',
    ].join('\n'));
});

test('a comment that rode along on an opening brace does not cancel the break it owes', () => {
    assert.equal(format('Widget Root { /* why */ A = 1 }\n'), [
        'Widget Root { /* why */',
        '    A = 1',
        '}',
        '',
    ].join('\n'));
});

test('nothing inside a string literal is touched, spacing and escapes alike', () => {
    const source = 'Widget Root {\n    Text="a  b : c = d,e \\" f"\n}\n';
    assert.equal(format(source), 'Widget Root {\n    Text = "a  b : c = d,e \\" f"\n}\n');
});

test('the eol and the indent come from the caller', () => {
    assert.equal(formatDui('Widget Root {\nA = 1\n}\n', { indent: '\t', eol: '\r\n' }),
        'Widget Root {\r\n\tA = 1\r\n}\r\n');
});

test('formatting twice changes nothing the second time', () => {
    const sources = [
        'Widget Root { + Overlay {} Text T:Heading { FontSize=18 } }\n',
        '\n\n// c\nstyle A:B{\nX=1;Y=2\n}\n\n\n',
        'class /Game/UI/WBP_X\nuse "Styles/Common.dui"\nWidget Root {\n  each Item in GetAll() {\n Text T { Text<-Item.Title }\n}\n}\n',
    ];
    for (const source of sources) {
        const once = format(source);
        assert.equal(format(once), once, source);
    }
});

test('a layout that would change what the file says returns the file instead', () => {
    // Three tokens -- number, dot, number -- that the spacing rules would print as '1.5', which
    // the scanner reads back as one. The guard rail sees the difference and declines the whole
    // file rather than quietly editing a value.
    const source = 'Widget Root {\n        X = 1 . 5\n}\n';
    assert.equal(format(source), source);
    assert.notDeepEqual(tokenSignature(source), tokenSignature('Widget Root {\n    X = 1.5\n}\n'));
});

test('the signature ignores separators and notices everything else', () => {
    assert.deepEqual(tokenSignature('A = 1\nB = 2\n'), tokenSignature('A = 1; B = 2'));
    assert.notDeepEqual(tokenSignature('A = 1'), tokenSignature('A = 2'));
    assert.notDeepEqual(tokenSignature('A = "x"'), tokenSignature('A = x'));
    assert.notDeepEqual(tokenSignature('// note'), tokenSignature('// other'));
});

// ---- the corpus ------------------------------------------------------------------------------

const corpusDir = process.env.DREAMUI_CORPUS_DIR
    ?? path.join(__dirname, '..', '..', 'test', 'fixtures');

function collectDuiFiles(directory: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collectDuiFiles(full, out);
        } else if (entry.name.toLowerCase().endsWith('.dui')) {
            out.push(full);
        }
    }
    return out;
}

for (const file of fs.existsSync(corpusDir) ? collectDuiFiles(corpusDir) : []) {
    test(`corpus: ${path.basename(file)} formats to a fixed point, and says the same thing`, () => {
        const source = fs.readFileSync(file, 'utf8');
        const once = format(source);
        assert.deepEqual(tokenSignature(once), tokenSignature(source), 'the formatter changed a token');
        assert.equal(format(once), once, 'the second pass moved something');
    });
}
