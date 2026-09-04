/**
 * The corpus sweep: every real .dui the project owns must come out of the extension's own judging
 * without a single diagnostic -- the measured form of "no false reds".
 *
 * It sweeps through judgeDocument, WITH an index built from the whole corpus, because that is what
 * the editor does and the difference is the whole point. Judging these files one at a time and
 * index-less (which is what this test used to do) reports DUI3004 on every style ControlsGallery
 * imports from Styles/ShowcaseCommon.dui and DUI4007 on every colour it takes from there: fourteen
 * complaints about a file that compiles. A sweep that cannot see the workspace is not evidence
 * about a workspace.
 *
 * Point DREAMUI_CORPUS_DIR at a project's DUI/ directory to sweep it; without the variable the
 * bundled fixtures stand in, so the sweep never silently runs over nothing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { judgeDocument } from '../src/core/diagnose';
import { WorkspaceIndex } from '../src/core/workspaceIndex';

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

const index = new WorkspaceIndex();
const texts = new Map<string, string>();
for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    texts.set(file, text);
    index.update(file, text);
}

test(`the corpus at ${corpusDir} is not empty`, () => {
    assert.ok(files.length > 0, `no .dui files under ${corpusDir}`);
});

for (const file of files) {
    test(`corpus: ${path.basename(file)} is diagnostic-free`, () => {
        const text = texts.get(file)!;
        // No `tags`: the tag sweep needs the plugin's symbols dump, and a corpus checked into a
        // source tree has no business depending on what an Unreal editor last exported.
        const complaints = judgeDocument({ file, text, index })
            .map((d) => `${d.code === undefined ? '--' : 'DUI' + d.code} ${d.message}`);
        assert.deepEqual(complaints, []);
    });
}
