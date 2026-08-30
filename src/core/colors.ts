/**
 * Hex colour literals, as the compiler reads them and the value formatter prints them: '#' plus
 * 3 (RGB), 4 (RGBA), 6 (RRGGBB) or 8 (RRGGBBAA) hex digits, uppercase on the way out. Pure token
 * work -- which literal is a colour is a lexical fact, so the picker can never disagree with the
 * compiler about what parses.
 *
 * References (`@Accent`) deliberately get no colour here: a presentation REPLACES its range, and
 * replacing a reference with a literal is an edit nobody asked the picker to make.
 */

import { Token } from './scanner';

export interface ColorSpan {
    start: number;
    end: number;
    /** 0..1, straight from the hex bytes. */
    red: number;
    green: number;
    blue: number;
    alpha: number;
    /** How many digits the author wrote: 3, 4, 6 or 8. Presentation keeps their style. */
    digits: number;
}

function isHex(code: number): boolean {
    return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66) || (code >= 0x41 && code <= 0x46);
}

/** Every valid colour literal in the token stream. Invalid ones already carry DUI1005. */
export function collectColors(tokens: Token[]): ColorSpan[] {
    const out: ColorSpan[] = [];
    for (const token of tokens) {
        if (token.kind !== 'hexColor') {
            continue;
        }
        const digits = token.text;
        if (digits.length !== 3 && digits.length !== 4 && digits.length !== 6 && digits.length !== 8) {
            continue;
        }
        let allHex = true;
        for (let index = 0; index < digits.length; index++) {
            if (!isHex(digits.charCodeAt(index))) {
                allHex = false;
                break;
            }
        }
        if (!allHex) {
            continue;
        }

        const short = digits.length <= 4;
        const channel = (position: number): number => {
            if (short) {
                const nibble = parseInt(digits[position], 16);
                return (nibble * 17) / 255; // 'F' -> 0xFF, exactly how short hex expands
            }
            return parseInt(digits.slice(position * 2, position * 2 + 2), 16) / 255;
        };
        const hasAlpha = digits.length === 4 || digits.length === 8;
        out.push({
            start: token.start, end: token.end,
            red: channel(0), green: channel(1), blue: channel(2),
            alpha: hasAlpha ? channel(3) : 1,
            digits: digits.length,
        });
    }
    return out;
}

/**
 * Spells a picked colour back as '#....', keeping the author's digit style where the colour still
 * fits it: a 3/4-digit literal stays short when every channel survives the trip, alpha forces the
 * variant that can carry it. Uppercase, as the engine's own ToHex spells them.
 */
export function formatHex(red: number, green: number, blue: number, alpha: number, previousDigits: number): string {
    const toByte = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);
    const bytes = [toByte(red), toByte(green), toByte(blue)];
    const alphaByte = toByte(alpha);
    const opaque = alphaByte === 255;

    const shortable = bytes.every((byte) => (byte >> 4) === (byte & 0xf)) && ((alphaByte >> 4) === (alphaByte & 0xf));
    const preferShort = (previousDigits === 3 || previousDigits === 4) && shortable;
    const wantAlpha = !opaque || previousDigits === 4 || previousDigits === 8;

    const hexByte = (byte: number): string => byte.toString(16).padStart(2, '0').toUpperCase();
    const hexNibble = (byte: number): string => (byte & 0xf).toString(16).toUpperCase();

    if (preferShort) {
        const rgb = bytes.map(hexNibble).join('');
        return '#' + (wantAlpha ? rgb + hexNibble(alphaByte) : rgb);
    }
    const rgb = bytes.map(hexByte).join('');
    return '#' + (wantAlpha ? rgb + hexByte(alphaByte) : rgb);
}
