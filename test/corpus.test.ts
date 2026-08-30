/**
 * The corpus sweep: every real .dui the project owns must come through the scanner and the
 * structure layer without a single diagnostic -- the measured form of "no false reds".
 *
 * Point DREAMUI_CORPUS_DIR at a project's DUI/ directory to sweep it; without the variable the
 * bundled fixtures stand in, so the sweep never silently runs over nothing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildStructure } from '../src/core/structure';

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

const corpusDir = process.env.DREAMUI_CORPUS_DIR
    ?? path.join(__dirname, '..', '..', 'test', 'fixtures');
const files = fs.existsSync(corpusDir) ? collectDuiFiles(corpusDir) : [];

test(`the corpus at ${corpusDir} is not empty`, () => {
    assert.ok(files.length > 0, `no .dui files under ${corpusDir}`);
});

for (const file of files) {
    test(`corpus: ${path.basename(file)} is diagnostic-free`, () => {
        const built = buildStructure(fs.readFileSync(file, 'utf8'));
        const complaints = [...built.lexical, ...built.diagnostics]
            .map((d) => `${d.line}:${d.column} DUI${d.code} ${d.message}`);
        assert.deepEqual(complaints, []);
    });
}
