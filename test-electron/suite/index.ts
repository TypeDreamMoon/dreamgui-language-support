/**
 * The entry point VS Code calls inside the test window: hands the suite to mocha and resolves when
 * it is done. Nothing here is DreamUI-specific; the substance is in the .test.js files beside it.
 */
import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60000 });
    const here = __dirname;
    for (const file of await glob('**/*.test.js', { cwd: here })) {
        mocha.addFile(path.resolve(here, file));
    }
    await new Promise<void>((resolve, reject) => {
        mocha.run((failures) => {
            if (failures > 0) {
                reject(new Error(`${failures} shell test(s) failed`));
            } else {
                resolve();
            }
        });
    });
}
