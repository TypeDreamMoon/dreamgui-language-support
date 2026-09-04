/**
 * The shell test's launcher: downloads a VS Code, starts it with this extension loaded, and runs
 * the suite inside it.
 *
 * It exists because `npm test` cannot reach the half of this extension that matters most. Those
 * tests run against src/core/, which is exactly the half with no editor in it; everything the
 * providers do -- when the index is filled, when diagnostics are re-judged, what a document open
 * outside a workspace folder actually sees -- lives on the other side of a `vscode` import and has
 * only ever been checked by opening the editor and looking.
 *
 * Two launches, on purpose, because the two are different code paths and only one of them was ever
 * exercised:
 *
 *   1. with the corpus folder open, where `workspace.findFiles` fills the index; and
 *   2. with NO folder at all, where findFiles returns nothing and the index has to be filled by
 *      finding the DUI root of the one open file. That window is the one this extension has been
 *      wrong in, and it is the launch worth having.
 *
 * Deliberately not part of `npm test`: it downloads an editor and takes a minute, and a test suite
 * people stop running is worse than one that covers less.
 */
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
    const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');
    const corpus = process.env.DREAMUI_CORPUS_DIR
        ?? path.join(extensionDevelopmentPath, 'test', 'fixtures');

    // --disable-extensions leaves only the one under development, so nothing another extension
    // publishes can be mistaken for a .dui diagnostic.
    const common = ['--disable-extensions', '--disable-gpu'];

    console.log(`[dui] corpus: ${corpus}`);

    console.log('[dui] launch 1/2: with the corpus folder open');
    await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [corpus, ...common],
        extensionTestsEnv: { DREAMUI_CORPUS_DIR: corpus, DREAMUI_SHELL_MODE: 'folder' },
    });

    console.log('[dui] launch 2/2: with no folder open, the way a single .dui is read');
    await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [...common],
        extensionTestsEnv: { DREAMUI_CORPUS_DIR: corpus, DREAMUI_SHELL_MODE: 'loose' },
    });
}

main().catch((error) => {
    console.error('[dui] shell tests failed to run:', error);
    process.exit(1);
});
