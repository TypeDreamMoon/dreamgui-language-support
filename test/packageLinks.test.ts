/**
 * Where a .dui names a package, and — just as load-bearing — where it only looks like it does.
 * Every span is checked by slicing the SOURCE with it: an underline that is one character off is
 * the visible defect this layer exists to avoid.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildStructure } from '../src/core/structure';
import { packageLinkSpans, linksToOffer } from '../src/core/packageLinks';

function linksIn(source: string): { text: string; path: string }[] {
    return packageLinkSpans(buildStructure(source).tokens, source).map((span) => ({
        text: source.slice(span.start, span.end),
        path: span.path,
    }));
}

test('a class line and a nested tag are both package paths', () => {
    const source = 'class /Game/UI/WBP_Panel\n\nWidget Root {\n    /Game/UI/WBP_Row Row {\n    }\n}\n';
    assert.deepEqual(linksIn(source), [
        { text: '/Game/UI/WBP_Panel', path: '/Game/UI/WBP_Panel' },
        { text: '/Game/UI/WBP_Row', path: '/Game/UI/WBP_Row' },
    ]);
});

test('a path inside a quoted value is found, with the quotes left out of the span', () => {
    const source = 'Widget Root {\n    Note = "see /Game/UI/Tex for the source"\n}\n';
    assert.deepEqual(linksIn(source), [{ text: '/Game/UI/Tex', path: '/Game/UI/Tex' }]);
});

test('an escape ahead of the path does not shift the span', () => {
    const source = 'Widget Root {\n    Note = "a \\" then /Game/UI/Tex"\n}\n';
    const links = packageLinkSpans(buildStructure(source).tokens, source);
    assert.equal(links.length, 1);
    assert.equal(source.slice(links[0].start, links[0].end), '/Game/UI/Tex');
});

test('the run ends on a character that can end an asset name', () => {
    const source = 'Widget Root {\n    Note = "at /Game/UI/Tex, then /Engine/Fonts/Roboto."\n}\n';
    assert.deepEqual(linksIn(source).map((link) => link.path),
        ['/Game/UI/Tex', '/Engine/Fonts/Roboto']);
});

test('an object path keeps its class suffix -- that is how a nested tag spells itself', () => {
    const source = 'Widget Root {\n    /Game/UI/WBP_Row.WBP_Row_C Row {\n    }\n}\n';
    assert.deepEqual(linksIn(source).map((link) => link.path), ['/Game/UI/WBP_Row.WBP_Row_C']);
});

test('a path in a comment is prose, and a plugin mount point is left alone', () => {
    const source = [
        '// See /Game/UI/Tex for the source.',
        'Widget Root {',
        '    Font = /DreamGUI/DefaultFont_DistanceField',
        '    /* also /Game/UI/Other */',
        '}',
        '',
    ].join('\n');
    assert.deepEqual(linksIn(source), []);
});

test('a tag the workspace can trace to its declaring .dui yields no link', () => {
    const source = [
        'class /Game/UI/WBP_Panel',
        '',
        'Widget Root {',
        '    /Game/UI/WBP_Row Row {',
        '    }',
        '    /Game/UI/WBP_Orphan Loose {',
        '    }',
        '    Note = "and /Game/UI/WBP_Row again, in prose"',
        '}',
        '',
    ].join('\n');
    const spans = packageLinkSpans(buildStructure(source).tokens, source);
    assert.deepEqual(spans.map((span) => [span.path, span.kind]), [
        ['/Game/UI/WBP_Panel', 'tag'],
        ['/Game/UI/WBP_Row', 'tag'],
        ['/Game/UI/WBP_Orphan', 'tag'],
        ['/Game/UI/WBP_Row', 'string'],
    ]);

    // WBP_Row is declared by another .dui, so navigation.ts owns that click. The class line's
    // own path and the orphan tag have no definition to shadow, and the prose copy never did.
    const declared = new Set(['/Game/UI/WBP_Row']);
    assert.deepEqual(
        linksToOffer(spans, (path) => declared.has(path)).map((span) => [span.path, span.kind]),
        [['/Game/UI/WBP_Panel', 'tag'], ['/Game/UI/WBP_Orphan', 'tag'], ['/Game/UI/WBP_Row', 'string']]);

    // With no index host at hand nothing is claimed, so every span stays a link.
    assert.equal(linksToOffer(spans, () => false).length, 4);
});
