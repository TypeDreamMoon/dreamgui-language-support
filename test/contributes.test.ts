/**
 * The package manifest, held to what the rest of the extension assumes about it. Cheap on purpose:
 * this suite exists so `npm test` has something real to run from the first commit, and so a rename
 * in package.json cannot silently orphan the grammar or the snippets.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scan } from '../src/core/scanner';

const root = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the language id is dui and claims the .dui extension', () => {
    const language = manifest.contributes.languages[0];
    assert.equal(language.id, 'dui');
    assert.ok(language.extensions.includes('.dui'));
});

test('every contributed file path exists', () => {
    const paths: string[] = [
        manifest.contributes.languages[0].configuration,
        manifest.contributes.languages[0].icon.light,
        manifest.contributes.languages[0].icon.dark,
        manifest.contributes.grammars[0].path,
        manifest.contributes.snippets[0].path,
    ];
    for (const contributed of paths) {
        assert.ok(fs.existsSync(path.join(root, contributed)), `${contributed} is contributed but missing`);
    }
});

test('the grammar is wired to the language by scope name', () => {
    const grammar = manifest.contributes.grammars[0];
    assert.equal(grammar.language, 'dui');
    const parsed = JSON.parse(fs.readFileSync(path.join(root, grammar.path), 'utf8'));
    assert.equal(parsed.scopeName, grammar.scopeName);
});

interface Snippet {
    prefix: string;
    body: string[];
    description?: string;
}

const snippets: Record<string, Snippet> = JSON.parse(
    fs.readFileSync(path.join(root, manifest.contributes.snippets[0].path), 'utf8'));

/**
 * A snippet as it lands when every tab stop is accepted as offered: variables become a file name,
 * placeholders their default text (innermost first, so `${1:/Game/UI/WBP_${TM_FILENAME_BASE}}`
 * comes out whole), a choice its first option, a bare tab stop nothing.
 */
function expand(body: string[]): string {
    let text = body.join('\n')
        .replace(/\$\{TM_FILENAME\}/g, 'Panel.dui')
        .replace(/\$\{TM_FILENAME_BASE\}/g, 'Panel');
    for (let previous = ''; previous !== text;) {
        previous = text;
        text = text.replace(/\$\{\d+:([^${}]*)\}/g, '$1');
    }
    return text
        .replace(/\$\{\d+\|([^,|]*)[^}]*\|\}/g, '$1')
        .replace(/\$\{\d+\}|\$\d+/g, '');
}

test('every snippet has a prefix of its own and a body', () => {
    const seen = new Map<string, string>();
    for (const [name, snippet] of Object.entries(snippets)) {
        assert.ok(snippet.prefix.length > 0, `${name} has no prefix`);
        assert.ok(Array.isArray(snippet.body) && snippet.body.length > 0, `${name} has no body`);
        assert.ok(!seen.has(snippet.prefix), `${name} and ${seen.get(snippet.prefix)} share the prefix ${snippet.prefix}`);
        seen.set(snippet.prefix, name);
    }
});

/**
 * Expanded, every snippet lexes clean and closes every brace and parenthesis it opens. Lexical only,
 * on purpose: a fragment (`Shown <- HasDetail()`) is not a file, and whether a whole one parses is
 * the structure layer's to say, not the manifest's.
 */
test('every snippet expands to text that lexes clean, braces and parentheses balanced', () => {
    for (const [name, snippet] of Object.entries(snippets)) {
        const text = expand(snippet.body);
        assert.doesNotMatch(text, /\$/, `${name} leaves a tab stop unexpanded: ${JSON.stringify(text)}`);
        const scanned = scan(text);
        assert.deepEqual(scanned.diagnostics.map((d) => `DUI${d.code} ${d.message}`), [], `${name}: ${JSON.stringify(text)}`);
        let braces = 0;
        let parens = 0;
        for (const token of scanned.tokens) {
            braces += token.kind === 'openBrace' ? 1 : token.kind === 'closeBrace' ? -1 : 0;
            parens += token.kind === 'openParen' ? 1 : token.kind === 'closeParen' ? -1 : 0;
            assert.ok(braces >= 0 && parens >= 0, `${name} closes something it never opened`);
        }
        assert.equal(braces, 0, `${name} leaves a '{' open`);
        assert.equal(parens, 0, `${name} leaves a '(' open`);
    }
});

test('the component syntax has its snippets', () => {
    const prefixes = new Set(Object.values(snippets).map((snippet) => snippet.prefix));
    for (const prefix of ['use-as', 'use-class', 'dui-component', 'props', 'events', 'emit', 'if', 'ifelse', 'for',
        'slot-default', 'slot-fill', 'slotblock', 'vbox', 'hbox', 'shown']) {
        assert.ok(prefixes.has(prefix), `no snippet with the prefix ${prefix}`);
    }
});
