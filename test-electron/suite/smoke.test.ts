/**
 * One question, asked inside a real editor: does opening a real .dui produce a red squiggle that
 * the compiler would not?
 *
 * DUI3004 is the one it asks about by name, because that code is what an empty index reports on
 * every style an import brings in, and an empty index is precisely what the window in launch 2 --
 * no folder, one file -- used to have. The unit tests can prove the judging is right given an
 * index; only this can prove the index is there by the time the judging runs.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const corpus = process.env.DREAMUI_CORPUS_DIR ?? '';
/** 'folder': the corpus is the open workspace. 'loose': no folder is open at all. */
const mode = process.env.DREAMUI_SHELL_MODE ?? 'folder';

function collect(directory: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collect(full, out);
        } else if (entry.name.toLowerCase().endsWith('.dui')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Diagnostics arrive when the extension is finished, not when the document opens, and "finished"
 * here includes a workspace sweep and possibly a filesystem scan. Polling until the collection
 * stops changing, rather than sleeping once, is what keeps this from being the flaky test that
 * gets skipped.
 */
async function settledDiagnostics(uri: vscode.Uri, budgetMs = 30000): Promise<vscode.Diagnostic[]> {
    const started = Date.now();
    let last = '';
    let stableFor = 0;
    while (Date.now() - started < budgetMs) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const now = JSON.stringify(vscode.languages.getDiagnostics(uri).map((d) => [d.code, d.message]));
        stableFor = now === last ? stableFor + 1 : 0;
        last = now;
        if (stableFor >= 4) {
            break;
        }
    }
    return vscode.languages.getDiagnostics(uri);
}

suite(`DreamUI shell (${mode})`, () => {
    test('the extension activates', async () => {
        const extension = vscode.extensions.getExtension('typedreammoon.dreamgui-language-support');
        assert.ok(extension, 'the extension under development is not installed in this window');
        await extension.activate();
    });

    test('the corpus opens without a single DUI3004', async function () {
        const files = corpus && fs.existsSync(corpus) ? collect(corpus) : [];
        assert.ok(files.length > 0, `no .dui files under ${corpus}`);

        // ControlsGallery is the file the question is about: it wears five styles it imports and
        // paints with four colours it imports, so an index that is empty or late reports nine.
        const wanted = files.find((file) => path.basename(file) === 'ControlsGallery.dui') ?? files[0];
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(wanted));
        await vscode.window.showTextDocument(document);

        if (mode === 'loose') {
            assert.equal(vscode.workspace.workspaceFolders, undefined,
                'launch 2 is only a test while no folder is open');
        }

        const diagnostics = await settledDiagnostics(document.uri);
        const imported = diagnostics.filter((d) => String(d.code) === 'DUI3004');
        assert.deepEqual(imported.map((d) => d.message), [],
            `${path.basename(wanted)} reported an imported style as undeclared`);
    });
});
