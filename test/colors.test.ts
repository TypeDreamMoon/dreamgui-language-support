/**
 * Colour spans and their round trip: what gets a chip, what the picker writes back, and the one
 * thing that must never happen -- a reference (`@Accent`) growing a presentation.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { scan } from '../src/core/scanner';
import { collectColors, formatHex } from '../src/core/colors';

function colorsIn(source: string) {
    return collectColors(scan(source).tokens);
}

test('every valid digit count gets a span with the right channels', () => {
    const spans = colorsIn('A = #FFF\nB = #F00A\nC = #1B1D23\nD = #0077FF80\n');
    assert.equal(spans.length, 4);
    assert.deepEqual(spans.map((span) => span.digits), [3, 4, 6, 8]);
    assert.equal(spans[0].red, 1);
    assert.equal(spans[1].alpha, 10 * 17 / 255);
    assert.equal(spans[2].red, 0x1b / 255);
    assert.ok(Math.abs(spans[3].alpha - 0x80 / 255) < 1e-9);
});

test('an invalid literal gets no span -- DUI1005 already owns it', () => {
    assert.equal(colorsIn('A = #GGG\nB = #12345\n').length, 0);
});

test('spans slice the source back out with their # included', () => {
    const source = 'Brush.TintColor = #0077ff';
    const [span] = colorsIn(source);
    assert.equal(source.slice(span.start, span.end), '#0077ff');
});

test('formatHex keeps the author digit style when the colour still fits it', () => {
    assert.equal(formatHex(1, 0, 0, 1, 3), '#F00');
    assert.equal(formatHex(1, 0, 0, 1, 6), '#FF0000');
    // A colour that no longer fits three digits widens.
    assert.equal(formatHex(0x1b / 255, 0x1d / 255, 0x23 / 255, 1, 3), '#1B1D23');
});

test('alpha forces a variant that can carry it, and stays when the author wrote one', () => {
    assert.equal(formatHex(1, 0, 0, 0.5, 6), '#FF000080');
    assert.equal(formatHex(1, 0, 0, 1, 8), '#FF0000FF');
    assert.equal(formatHex(1, 0, 0, 1, 4), '#F00F');
});

test('the round trip is exact: parse(format(parse(x))) == parse(x)', () => {
    for (const literal of ['#FFF', '#F00A', '#1B1D23', '#0077FF80', '#343946']) {
        const [first] = colorsIn(`A = ${literal}`);
        const spelled = formatHex(first.red, first.green, first.blue, first.alpha, first.digits);
        const [second] = colorsIn(`A = ${spelled}`);
        assert.deepEqual(
            [second.red, second.green, second.blue, second.alpha],
            [first.red, first.green, first.blue, first.alpha],
            `${literal} -> ${spelled} drifted`);
    }
});

test('references never produce a span', () => {
    assert.equal(colorsIn('A = @Accent\n').length, 0);
});

test('a props default gets its chip; a namespaced reference grows none', () => {
    const source = 'props {\n    Color Tint = #FF0000\n}\nWidget Root {\n    Color = @ui.Ink\n    Shown <- Count() > 0\n}\n';
    const spans = colorsIn(source);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].red, 1);
});
