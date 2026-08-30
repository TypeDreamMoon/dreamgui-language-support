/**
 * The package manifest, held to what the rest of the extension assumes about it. Cheap on purpose:
 * this suite exists so `npm test` has something real to run from the first commit, and so a rename
 * in package.json cannot silently orphan the grammar or the snippets.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
