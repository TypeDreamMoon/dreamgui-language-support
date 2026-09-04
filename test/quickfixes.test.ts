/**
 * Quickfix plans, verified the only way that matters: apply, re-parse, the target exists, nothing
 * else complained. All plans are pure insertions, so "nothing else changed" is by construction.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import { planDeclareResource, planCreateStyle, applyPlan } from '../src/core/quickfixes';
import { WorkspaceIndex } from '../src/core/workspaceIndex';
import { filesDeclaring, planUseSpelling, planUseInsertion, useStyleOf } from '../src/core/useFix';

test('declaring a resource into an existing block', () => {
    const source = 'class /Game/UI/WBP_X\n\nresources {\n    Number Gap = 8\n}\n\nWidget Root {\n    A = @Accent\n}\n';
    const fixed = applyPlan(source, planDeclareResource(buildStructure(source), 'Accent', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.resources.map((r) => r.name), ['Gap', 'Accent']);
    assert.ok(built.resourceRefs.every((ref) =>
        built.resources.some((r) => r.name.toLowerCase() === ref.name.toLowerCase())));
});

test('declaring a resource creates the block after the class line when none exists', () => {
    const source = 'class /Game/UI/WBP_X\n\nWidget Root {\n    A = @Accent\n}\n';
    const fixed = applyPlan(source, planDeclareResource(buildStructure(source), 'Accent', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.resources.map((r) => `${r.type} ${r.name}`), ['Color Accent']);
    assert.ok(fixed.indexOf('resources {') > fixed.indexOf('class '));
    assert.ok(fixed.indexOf('resources {') < fixed.indexOf('Widget Root'));
});

test('declaring a resource with neither block nor class line lands at the top', () => {
    const source = 'Widget Root {\n    A = @Accent\n}\n';
    const fixed = applyPlan(source, planDeclareResource(buildStructure(source), 'Accent', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.equal(built.resources.length, 1);
    assert.equal(built.roots.length, 1);
});

test('creating a style lands after the last style', () => {
    const source = 'style Label {\n    FontSize = 18\n}\n\nWidget Root {\n    Text A : Danger {}\n}\n';
    const fixed = applyPlan(source, planCreateStyle(buildStructure(source), 'Danger', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.styles.map((s) => s.name), ['Label', 'Danger']);
});

test('creating a style with no styles yet lands after the class line', () => {
    const source = 'class /Game/UI/WBP_X\n\nWidget Root {\n    Text A : Danger {}\n}\n';
    const fixed = applyPlan(source, planCreateStyle(buildStructure(source), 'Danger', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.styles.map((s) => s.name), ['Danger']);
    assert.ok(fixed.indexOf('style Danger') < fixed.indexOf('Widget Root'));
});

test('creating a style fixes a broken base clause too', () => {
    const source = 'style A : Missing {\n}\n\nWidget Root {\n    Text T : A {}\n}\n';
    const fixed = applyPlan(source, planCreateStyle(buildStructure(source), 'Missing', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.styles.map((s) => s.name), ['A', 'Missing']);
});

// ---- the `use` fix: import what already exists instead of declaring a second one ---------------

const LIBRARY = 'style Heading {\n    FontSize = 34\n}\n\nresources {\n    Color Accent = #FF6600\n}\n';

function indexWith(files: Record<string, string>): WorkspaceIndex {
    const index = new WorkspaceIndex();
    for (const [file, text] of Object.entries(files)) {
        index.update(file, text);
    }
    return index;
}

test('the declaring file is found by name, case insensitively, for both kinds', () => {
    const index = indexWith({
        'I:/Proj/DUI/Styles/Common.dui': LIBRARY,
        'I:/Proj/DUI/Main.dui': 'class /Game/UI/WBP_X\n\nWidget Root {}\n',
    });
    assert.deepEqual(filesDeclaring(index, 'style', 'heading'), ['I:/Proj/DUI/Styles/Common.dui']);
    assert.deepEqual(filesDeclaring(index, 'resource', 'ACCENT'), ['I:/Proj/DUI/Styles/Common.dui']);
    assert.deepEqual(filesDeclaring(index, 'style', 'Nowhere'), []);
});

test('a library below the file is spelled the way the corpus writes it', () => {
    const index = indexWith({ 'I:/Proj/DUI/Styles/Common.dui': LIBRARY });
    assert.equal(planUseSpelling({
        documentFile: 'I:/Proj/DUI/Main.dui',
        targetFile: 'I:/Proj/DUI/Styles/Common.dui',
        existing: [],
        resolve: (candidate) => index.resolveImportSpelling(candidate),
    }), 'Styles/Common.dui');
});

test('a spelling is only offered when it resolves back to the file it meant', () => {
    // Two Common.dui: the bare name is ambiguous, so the fix reaches for a longer suffix.
    const index = indexWith({
        'I:/Proj/DUI/Styles/Common.dui': LIBRARY,
        'I:/Proj/DUI/Other/Common.dui': 'style Elsewhere {\n}\n',
    });
    const resolve = (candidate: string): string[] => index.resolveImportSpelling(candidate);
    assert.equal(planUseSpelling({
        documentFile: 'I:/Proj/DUI/Sub/Deep/Main.dui',
        targetFile: 'I:/Proj/DUI/Styles/Common.dui',
        existing: [],
        resolve,
    }), 'Styles/Common.dui');

    // Nothing indexed under that name at all: the mirror cannot promise the compiler would agree.
    assert.equal(planUseSpelling({
        documentFile: 'I:/Proj/DUI/Main.dui',
        targetFile: 'I:/Elsewhere/Common.dui',
        existing: [],
        resolve,
    }), undefined);
});

test('a file that already imports the library gets no fix -- that is a timing artefact', () => {
    const index = indexWith({ 'I:/Proj/DUI/Styles/Common.dui': LIBRARY });
    assert.equal(planUseSpelling({
        documentFile: 'I:/Proj/DUI/Main.dui',
        targetFile: 'I:/Proj/DUI/Styles/Common.dui',
        existing: ['Styles/Common.dui'],
        resolve: (candidate) => index.resolveImportSpelling(candidate),
    }), undefined);
});

test('the file writes the new import the way it writes its existing ones', () => {
    const index = indexWith({
        'I:/Proj/DUI/Styles/Common.dui': LIBRARY,
        'I:/Proj/DUI/Styles/Other.dui': 'style Elsewhere {\n}\n',
    });
    const resolve = (candidate: string): string[] => index.resolveImportSpelling(candidate);
    assert.equal(planUseSpelling({
        documentFile: 'I:/Proj/DUI/Main.dui',
        targetFile: 'I:/Proj/DUI/Styles/Common.dui',
        existing: ['./Styles/Other.dui'],
        resolve,
    }), './Styles/Common.dui');
    assert.equal(planUseSpelling({
        documentFile: 'I:/Proj/DUI/Main.dui',
        targetFile: 'I:/Proj/DUI/Styles/Common.dui',
        existing: ['Styles\\Other.dui'],
        resolve,
    }), 'Styles\\Common.dui');

    // Mixed spellings are no house style; the corpus default wins.
    assert.deepEqual(useStyleOf(['./a.dui', 'b.dui']), { leadingDot: false, separator: '/' });
    assert.deepEqual(useStyleOf([]), { leadingDot: false, separator: '/' });
});

test('the import lands after the last use, and the file still parses', () => {
    const source = 'class /Game/UI/WBP_X\n\nuse "Styles/A.dui"\nuse "Styles/B.dui"\n\nWidget Root {\n}\n';
    const fixed = applyPlan(source,
        planUseInsertion(buildStructure(source), 'Styles/Common.dui', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.imports.map((entry) => entry.path),
        ['Styles/A.dui', 'Styles/B.dui', 'Styles/Common.dui']);
});

test('with no use yet the import lands after the class line', () => {
    const source = 'class /Game/UI/WBP_X\n\nWidget Root {\n}\n';
    const fixed = applyPlan(source,
        planUseInsertion(buildStructure(source), 'Styles/Common.dui', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics, []);
    assert.deepEqual(built.imports.map((entry) => entry.path), ['Styles/Common.dui']);
    assert.ok(fixed.indexOf('use "') > fixed.indexOf('class '));
    assert.ok(fixed.indexOf('use "') < fixed.indexOf('Widget Root'));
});

test('with neither, the import lands under the header comment and above the first statement', () => {
    // A style library: rootless on purpose, which is what a file reached through `use` looks
    // like -- so the yardstick is that the fix ADDS no complaint, not that there are none.
    const source = '// What this file is.\n// Second line.\n\nstyle Local {\n}\n';
    const before = buildStructure(source).diagnostics.map((entry) => entry.code);
    const fixed = applyPlan(source,
        planUseInsertion(buildStructure(source), 'Styles/Common.dui', source.length));
    const built = buildStructure(fixed);
    assert.deepEqual(built.diagnostics.map((entry) => entry.code), before);
    assert.deepEqual(built.imports.map((entry) => entry.path), ['Styles/Common.dui']);
    assert.ok(fixed.startsWith('// What this file is.\n// Second line.\n\nuse "'));
    assert.ok(fixed.indexOf('use "') < fixed.indexOf('style Local'));
});
