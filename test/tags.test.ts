/**
 * `@tag Trim, Glow` lines: read as tags of the widget that holds them, told apart from the old `@tag X { }` (a node whose
 * type an Asset resource called `tag` names), and DUI2024 for a line that is neither.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure, StructNode } from '../src/core/structure';
import { analyzeLine } from '../src/core/completionContext';
import { collectSemanticSpans } from '../src/core/semantics';
import { formatDui } from '../src/core/format';
import { ANNOTATIONS } from '../src/core/vocabulary';

const SPACES = { indent: '    ', eol: '\n' } as const;

const wrap = (...body: string[]): string => ['Widget Root {', ...body.map((line) => `    ${line}`), '}', ''].join('\n');
const tagsOf = (node: StructNode): string[] | undefined => node.tags?.map((tag) => tag.name);
const codes = (source: string): number[] => buildStructure(source).diagnostics.map((diagnostic) => diagnostic.code);

test('a tag line is not a child node: one name, several, dotted, and CJK', () => {
    const source = wrap('Image TrimLeft {', '    @tag Trim', '    @tag Glow, UI.Accent', '    @tag 描边, 高亮', '}');
    const built = buildStructure(source);
    assert.deepEqual(built.diagnostics, []);
    const image = built.roots[0].children[0];
    assert.equal(image.children.length, 0, 'nothing is read as a node of type @tag');
    assert.deepEqual(tagsOf(image), ['Trim', 'Glow', 'UI.Accent', '描边', '高亮']);
    for (const tag of image.tags!) {
        assert.equal(source.slice(tag.start, tag.end), tag.name);
    }
});

test('a tag line sits beside properties and children, and ends at a ; or a }', () => {
    const built = buildStructure(wrap('Image A { @tag One; @tag Two, Three }', 'Image B {', '    @tag X', '    Color = #FFF', '    Text C { @tag Y }', '}'));
    assert.deepEqual(built.diagnostics, []);
    const [a, b] = built.roots[0].children;
    assert.deepEqual(tagsOf(a), ['One', 'Two', 'Three']);
    assert.deepEqual(tagsOf(b), ['X']);
    assert.equal(b.properties.length, 1);
    assert.deepEqual(tagsOf(b.children[0]), ['Y']);
});

test('a tag line is allowed in a slot fill, a loop body\'s widget and a rows line\'s block', () => {
    const source = [
        'class /Game/UI/WBP_T',
        'props {', '    Number Count', '}',
        'Widget Root {',
        '    each Item in Items {',
        '        Text Entry { @tag Row }',
        '    }',
        '    rows Text (Text) {',
        '        "One" { @tag First }',
        '    }',
        '}',
        '',
    ].join('\n');
    const built = buildStructure(source);
    assert.deepEqual(built.diagnostics.map((diagnostic) => diagnostic.code), []);
    const loop = built.roots[0].children[0];
    assert.deepEqual(tagsOf(loop.children[0]), ['Row']);
    const row = built.roots[0].children.find((child) => child.rowKey === 'One')!;
    assert.deepEqual(tagsOf(row), ['First']);
});

test('the old resource-typed node still reads as one: a dot, a brace or a colon after @tag, or a name that one follows', () => {
    const source = [
        'resources {', '    Asset tag = /Game/UI/WBP_Tag', '}',
        'style S {}',
        'Widget Root {',
        '    @tag Trim { }',
        '    @tag Other : S { }',
        '    @tag { }',
        '    @tag Third (was: Old) { }',
        '    @tag.Ink Fourth { }',
        '}',
        '',
    ].join('\n');
    const built = buildStructure(source);
    const children = built.roots[0].children;
    assert.deepEqual(children.map((child) => child.tag), ['@tag', '@tag', '@tag', '@tag', '@tag.Ink']);
    assert.deepEqual(children.map((child) => child.id).slice(0, 2), ['Trim', 'Other']);
    assert.ok(children.every((child) => child.tags === undefined));
    assert.ok(!built.diagnostics.some((diagnostic) => diagnostic.code === 2024));
});

test('`tag` is a keyword only right after the @, and only in lower case', () => {
    const built = buildStructure(wrap('@Tag Trim { }', '@TAG Trim'));
    assert.ok(!built.diagnostics.some((diagnostic) => diagnostic.code === 2024));
    assert.deepEqual(built.roots[0].children.map((child) => child.tag), ['@Tag', '@TAG']);
    // As a name it is nothing special: a node called tag, a property called Tag, a widget type.
    assert.deepEqual(codes(wrap('Text tag { Tag = 1 }')), []);
});

test('DUI2024 at the @, for every shape that is neither a tag line nor a node', () => {
    const shapes: string[] = ['@tag', '@tag 5', '@tag "Trim"', '@tag Trim Glow', '@tag Trim,', '@tag Trim, , Glow', '@tag , Trim',
        '@tag UI.', '@tag Trim = 3', '@tag (Trim)'];
    for (const shape of shapes) {
        // The line ends the statement where it ends: a tag line holds nothing else, so what follows is read afresh.
        const source = wrap('Image T {', `    ${shape}`, '}');
        const built = buildStructure(source);
        const found = built.diagnostics.filter((diagnostic) => diagnostic.code === 2024);
        assert.equal(found.length, 1, `${shape}: ${JSON.stringify(built.diagnostics)}`);
        assert.equal(found[0].severity, 'error', shape);
        assert.equal(source.slice(found[0].start, found[0].start + 1), '@', shape);
        assert.equal(found[0].message, "'@tag' takes one or more names separated by commas, as in '@tag Trim, Glow'", shape);
        assert.equal(built.roots[0].children[0].tags, undefined, `${shape}: a refused line tags nothing`);
        assert.deepEqual(built.diagnostics.filter((diagnostic) => diagnostic.code !== 2024), [], shape);
    }
});

test('a refused tag line does not swallow the statements after it', () => {
    const built = buildStructure(wrap('Image T {', '    @tag 5', '    @tag Ok', '    Color = #FFF', '}'));
    assert.deepEqual(built.diagnostics.map((diagnostic) => diagnostic.code), [2024]);
    const image = built.roots[0].children[0];
    assert.deepEqual(tagsOf(image), ['Ok']);
    assert.equal(image.properties.length, 1);
});

test('what the mirror cannot say stays the compiler\'s: a tag line in a style block, an if arm or a loop', () => {
    const inStyle = 'style S {\n    @tag Trim\n    FontSize = 12\n}\nWidget Root {\n    Text T : S {}\n}\n';
    const style = buildStructure(inStyle);
    assert.deepEqual(style.diagnostics, [], 'nothing is made up for a style block');
    assert.equal(style.styles[0].properties.length, 1, 'the statement after it is still read');

    const inBranch = buildStructure(wrap('if Ready() {', '    @tag Trim', '    Text A {}', '}'));
    assert.deepEqual(inBranch.diagnostics.map((diagnostic) => diagnostic.code), []);
    assert.equal(inBranch.roots[0].children[0].children.length, 1, 'no node of type @tag in the arm');

    const inLoop = buildStructure(wrap('each Item in Items() {', '    @tag Trim', '    Text A {}', '}'));
    assert.deepEqual(inLoop.diagnostics.map((diagnostic) => diagnostic.code), []);
    assert.equal(inLoop.roots[0].children[0].children.length, 1);
});

test('the formatter leaves a tag line alone and keeps the comma and its dots', () => {
    const source = wrap('Image T {', '@tag   Glow ,UI.Accent', '    @tag Trim', '}');
    const formatted = formatDui(source, SPACES);
    assert.ok(formatted.includes('        @tag Glow, UI.Accent\n'), formatted);
    assert.ok(formatted.includes('        @tag Trim\n'), formatted);
    assert.equal(formatDui(formatted, SPACES), formatted);
});

test('a tag line is not an annotation of a value, and takes no colour of a style or a resource', () => {
    const source = wrap('Image T {', '    @tag Trim, Glow', '}');
    const built = buildStructure(source);
    assert.deepEqual(built.resourceRefs, []);
    assert.deepEqual(built.namespaceRefs, []);
    const spans = collectSemanticSpans(built, {}).map((span) => source.slice(span.start, span.start + span.length));
    assert.ok(!spans.includes('Trim') && !spans.includes('Glow'));
});

test('`tag` completes after an @ and a line of tag names is a name being typed', () => {
    assert.deepEqual(analyzeLine('    @ta'), { kind: 'annotation' });
    assert.deepEqual(analyzeLine('    @tag Tr'), { kind: 'nodeId' });
    assert.ok(ANNOTATIONS.includes('tag'));
});
