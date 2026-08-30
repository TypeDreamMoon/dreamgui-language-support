/**
 * The .dui lexer, ported from the compiler's own
 * (`Plugins/DreamGUI/Source/DreamGUI/Private/Text/DreamUISourceFile.cpp`, class FLexer).
 *
 * Ported rather than invented, and deliberately narrow: everything here is a LEXICAL fact about the
 * text, the one layer where a second implementation cannot drift into disagreeing with the
 * compiler. Semantics -- does this property exist, does this value fit -- live in the C++ and reach
 * the editor through the compiler's own diagnostics. If the C++ lexer changes, this file changes in
 * the same commit; the port is line-for-line on purpose, down to the diagnostic wording.
 *
 * No vscode import here, ever: src/core/ is the seam a future LSP server or another IDE reuses.
 */

export type TokenKind =
    | 'end'
    /** A newline or a `;` -- the two are one token, exactly as in the compiler. */
    | 'separator'
    | 'identifier'
    | 'number'
    /** Quotes stripped, escapes resolved. */
    | 'string'
    /** The digits only -- the '#' is delimiter, like a quote. */
    | 'hexColor'
    | 'assetPath'
    | 'openBrace'
    | 'closeBrace'
    | 'openParen'
    | 'closeParen'
    | 'comma'
    | 'dot'
    | 'colon'
    | 'equals'
    /** `->` -- routes an event to a handler. */
    | 'eventArrow'
    /** `<-`, the binding arrow. */
    | 'arrow'
    | 'plus'
    | 'at';

export interface Token {
    kind: TokenKind;
    /** Identifier / number / assetPath: as written. String: unescaped. HexColor: digits, no '#'. */
    text: string;
    /** 1-based, matching every DUInnnn message. */
    line: number;
    /** 1-based. */
    column: number;
    /** Offsets into the source: first character, and one past the last. */
    start: number;
    end: number;
    /**
     * Number only: digits glued straight onto letters -- 24px, 2ndPanel. The one shape the lexer
     * cannot judge on its own: in a value it is a malformed number, in a node header a name that
     * begins with a digit, and the two want different codes. Carried out unreported and diagnosed
     * by whichever parser position it lands in.
     */
    digitLeadingWord?: boolean;
}

export interface LexicalDiagnostic {
    /** The numeric half of the DUInnnn code, e.g. 1004. */
    code: number;
    severity: 'error' | 'warning';
    /** Wording matches the compiler's, verbatim. */
    message: string;
    line: number;
    column: number;
    start: number;
    end: number;
}

export interface ScanResult {
    tokens: Token[];
    diagnostics: LexicalDiagnostic[];
}

/** "DUI1004". */
export function formatCode(code: number): string {
    return `DUI${code}`;
}

// ---- character classes, spelled out exactly as the compiler spells them ------------------------

function isDigit(code: number): boolean {
    return code >= 0x30 && code <= 0x39;
}

function isHexDigit(code: number): boolean {
    return isDigit(code) || (code >= 0x61 && code <= 0x66) || (code >= 0x41 && code <= 0x46);
}

/**
 * The identifier rule, copied from UDreamWidgetTree::SanitizeIdentifier via the compiler's lexer.
 * `> 0x7F` verbatim: CJK ids are ordinary in this language, and both sides judge per UTF-16 unit,
 * so the two implementations agree even about surrogate halves.
 */
function isIdentifierChar(code: number): boolean {
    return isDigit(code)
        || code === 0x5f /* _ */
        || (code >= 0x61 && code <= 0x7a)
        || (code >= 0x41 && code <= 0x5a)
        || code > 0x7f;
}

function isIdentifierStart(code: number): boolean {
    return isIdentifierChar(code) && !isDigit(code);
}

/** `/Game/UI/WBP_SlotCard.WBP_SlotCard_C` -- an object path as the engine spells one. */
function isPathChar(code: number): boolean {
    return isIdentifierChar(code) || code === 0x2f /* / */ || code === 0x2e /* . */;
}

function isInlineWhitespace(code: number): boolean {
    return code === 0x20 || code === 0x09 || code === 0x0b || code === 0x0c;
}

/** Keywords, and therefore the words a node id may not be. Case sensitive, as the compiler is. */
export const RESERVED_WORDS: ReadonlySet<string> =
    new Set(['class', 'style', 'resources', 'slot', 'for', 'each', 'in', 'was']);

/** Clamped so a .dui path accidentally aimed at a .png reports a readable snippet, not the file. */
function ellipsize(text: string, maxLength = 16): string {
    return text.length <= maxLength ? text : text.slice(0, maxLength) + '...';
}

// ---- the lexer ---------------------------------------------------------------------------------

const LF = 0x0a;
const CR = 0x0d;

class Lexer {
    private offset = 0;
    private line = 1;
    /** Offset of the first character of the current line, so a column is one subtraction. */
    private lineStart = 0;

    readonly tokens: Token[] = [];
    readonly diagnostics: LexicalDiagnostic[] = [];

    constructor(private readonly text: string) {}

    run(): void {
        const { text } = this;
        while (this.offset < text.length) {
            const code = text.charCodeAt(this.offset);

            if (isInlineWhitespace(code)) {
                this.offset++;
                continue;
            }
            if (code === LF || code === CR) {
                this.lexLineBreak();
                continue;
            }
            if (code === 0x2f /* / */) {
                // Order matters and only here: `//` and `/*` both start with the character that
                // also starts every asset path. Comments first -- a path can never contain them,
                // but a comment can perfectly well contain a path.
                const next = this.peekCode(1);
                if (next === 0x2f) {
                    this.skipLineComment();
                    continue;
                }
                if (next === 0x2a /* * */) {
                    this.skipBlockComment();
                    continue;
                }
                this.lexAssetPath();
                continue;
            }
            if (isIdentifierStart(code)) {
                this.lexIdentifier();
                continue;
            }
            if (code === 0x2d /* - */ && this.peekCode(1) === 0x3e /* > */) {
                // Before the number branch on purpose: '-' otherwise always starts a number, and
                // `->` would lex as a malformed negative.
                this.emitPunctuation('eventArrow', 2);
                continue;
            }
            if (isDigit(code) || code === 0x2d) {
                this.lexNumber();
                continue;
            }
            if (code === 0x22 /* " */) {
                this.lexString();
                continue;
            }
            if (code === 0x23 /* # */) {
                this.lexHexColor();
                continue;
            }
            if (code === 0x3c /* < */ && this.peekCode(1) === 0x2d) {
                this.emitPunctuation('arrow', 2);
                continue;
            }
            if (code === 0x3b /* ; */) {
                this.emitPunctuation('separator', 1);
                continue;
            }

            const single = SINGLE_CHAR_KINDS.get(code);
            if (single !== undefined) {
                this.emitPunctuation(single, 1);
                continue;
            }

            this.lexUnexpectedRun();
        }

        this.tokens.push({
            kind: 'end', text: '',
            line: this.line, column: this.offset - this.lineStart + 1,
            start: text.length, end: text.length,
        });
    }

    // ---- plumbing ------------------------------------------------------------------------------

    private peekCode(ahead: number): number {
        const at = this.offset + ahead;
        return at < this.text.length ? this.text.charCodeAt(at) : 0;
    }

    private columnAt(offset: number): number {
        return offset - this.lineStart + 1;
    }

    private emit(kind: TokenKind, start: number, text: string, startLine: number, startColumn: number): void {
        this.tokens.push({ kind, text, line: startLine, column: startColumn, start, end: this.offset });
    }

    private emitPunctuation(kind: TokenKind, length: number): void {
        const start = this.offset;
        const line = this.line;
        const column = this.columnAt(start);
        this.offset += length;
        this.emit(kind, start, this.text.slice(start, this.offset), line, column);
    }

    private addError(code: number, message: string, start: number, end: number, line: number, column: number): void {
        this.diagnostics.push({ code, severity: 'error', message, line, column, start, end });
    }

    /**
     * Steps over one line ending of any flavour and moves the line counter with it. Shared by the
     * top level scan and the block comment scan on purpose -- a second copy of "is this \r\n or a
     * lone \r" is how every line number after the first block comment ends up one too small.
     */
    private consumeLineBreak(): boolean {
        if (this.offset >= this.text.length) {
            return false;
        }
        const code = this.text.charCodeAt(this.offset);
        if (code !== LF && code !== CR) {
            return false;
        }
        this.offset++;
        if (code === CR && this.offset < this.text.length && this.text.charCodeAt(this.offset) === LF) {
            this.offset++;
        }
        this.line++;
        this.lineStart = this.offset;
        return true;
    }

    private lexLineBreak(): void {
        const start = this.offset;
        const line = this.line;
        const column = this.columnAt(start);
        this.consumeLineBreak();
        this.tokens.push({ kind: 'separator', text: '', line, column, start, end: this.offset });
    }

    private skipLineComment(): void {
        while (this.offset < this.text.length) {
            const code = this.text.charCodeAt(this.offset);
            if (code === LF || code === CR) {
                break;
            }
            this.offset++;
        }
        // The line break itself is left for the main loop, which turns it into the separator that
        // ends the statement the comment was trailing.
    }

    private skipBlockComment(): void {
        const start = this.offset;
        const line = this.line;
        const column = this.columnAt(start);
        this.offset += 2;

        let closed = false;
        let crossedLine = false;
        while (this.offset < this.text.length) {
            if (this.text.charCodeAt(this.offset) === 0x2a && this.peekCode(1) === 0x2f) {
                this.offset += 2;
                closed = true;
                break;
            }
            if (this.consumeLineBreak()) {
                crossedLine = true;
                continue;
            }
            this.offset++;
        }

        if (!closed) {
            this.addError(1003, "this '/*' never reaches a '*/'", start, this.offset, line, column);
        }

        // A comment that crossed a line still ends the statement it started on. Deleting the line
        // break with the comment would silently join two statements.
        if (crossedLine) {
            this.tokens.push({
                kind: 'separator', text: '',
                line: this.line, column: this.columnAt(this.offset),
                start: this.offset, end: this.offset,
            });
        }
    }

    private lexIdentifier(): void {
        const start = this.offset;
        const line = this.line;
        const column = this.columnAt(start);
        while (this.offset < this.text.length && isIdentifierChar(this.text.charCodeAt(this.offset))) {
            this.offset++;
        }
        this.emit('identifier', start, this.text.slice(start, this.offset), line, column);
    }

    private lexNumber(): void {
        const start = this.offset;
        const line = this.line;
        const column = this.columnAt(start);

        const signed = this.text.charCodeAt(this.offset) === 0x2d;
        if (signed) {
            this.offset++;
        }

        let integerDigits = 0;
        while (this.offset < this.text.length && isDigit(this.text.charCodeAt(this.offset))) {
            this.offset++;
            integerDigits++;
        }

        // A '.' only belongs to the number when a digit follows it.
        if (this.offset < this.text.length && this.text.charCodeAt(this.offset) === 0x2e && isDigit(this.peekCode(1))) {
            this.offset++;
            while (this.offset < this.text.length && isDigit(this.text.charCodeAt(this.offset))) {
                this.offset++;
            }
        }

        // The exponent, and it is not a nicety: the designer's write-back prints `1e+20` and
        // `1e-45` into .dui files. A lexer that stopped at the 'e' would break the round trip in
        // the one direction nobody checks by hand.
        let brokenExponent = false;
        if (integerDigits > 0 && this.offset < this.text.length) {
            const e = this.text.charCodeAt(this.offset);
            if (e === 0x65 /* e */ || e === 0x45 /* E */) {
                let cursor = this.offset + 1;
                if (cursor < this.text.length) {
                    const sign = this.text.charCodeAt(cursor);
                    if (sign === 0x2b || sign === 0x2d) {
                        cursor++;
                    }
                }
                if (cursor < this.text.length && isDigit(this.text.charCodeAt(cursor))) {
                    this.offset = cursor;
                    while (this.offset < this.text.length && isDigit(this.text.charCodeAt(this.offset))) {
                        this.offset++;
                    }
                } else {
                    // `1e`, `400e`, `1e+`. The 'e' is consumed anyway so the complaint names the
                    // whole word rather than leaving a stray `e` to fail again two tokens later.
                    this.offset = cursor;
                    brokenExponent = true;
                }
            }
        }

        // Everything that reads like part of the number but cannot be: a second decimal point, a
        // trailing one, a unit glued on the end (24px). Swallowed into this token rather than left
        // behind as a bare identifier that buries the real mistake under an invented one.
        let trailingDot = false;
        let trailingWord = false;
        while (this.offset < this.text.length) {
            const code = this.text.charCodeAt(this.offset);
            if (code === 0x2e) {
                trailingDot = true;
            } else if (isIdentifierChar(code)) {
                trailingWord = true;
            } else {
                break;
            }
            this.offset++;
        }

        // Plain digits followed by plain letters is the ambiguous shape; only the position the
        // token lands in can settle it. A sign, a stray dot or a half-written exponent removes the
        // ambiguity: nobody writes a name as -3px, 1.2.3 or 400e.
        const digitLeadingWord = !signed && !brokenExponent && integerDigits > 0 && trailingWord && !trailingDot;

        const raw = this.text.slice(start, this.offset);
        if (!digitLeadingWord && (integerDigits === 0 || trailingDot || trailingWord || brokenExponent)) {
            this.addError(1004,
                `'${ellipsize(raw)}' is not a number: write it as -12, 0.95 or 1e-45`,
                start, this.offset, line, column);
        }

        // Emitted even when malformed: the statement around it is probably fine, and the parser
        // finding a value where a value belongs is what lets it go on to the rest of the file.
        this.emit('number', start, raw, line, column);
        if (digitLeadingWord) {
            this.tokens[this.tokens.length - 1].digitLeadingWord = true;
        }
    }

    private lexString(): void {
        const start = this.offset;
        const line = this.line;
        const column = this.columnAt(start);
        this.offset++;

        let value = '';
        let closed = false;
        while (this.offset < this.text.length) {
            const code = this.text.charCodeAt(this.offset);

            // Strings do not span lines: a missing closing quote would otherwise swallow the rest
            // of the file into one literal and report the failure hundreds of lines from the typo.
            if (code === LF || code === CR) {
                break;
            }
            if (code === 0x22 /* " */) {
                this.offset++;
                closed = true;
                break;
            }
            if (code === 0x5c /* \ */) {
                const escaped = this.peekCode(1);
                if (this.offset + 1 >= this.text.length || escaped === LF || escaped === CR) {
                    this.offset++;
                    break;
                }
                this.offset += 2;
                switch (escaped) {
                    case 0x22: value += '"'; break;
                    case 0x5c: value += '\\'; break;
                    case 0x6e: value += '\n'; break;
                    case 0x74: value += '\t'; break;
                    case 0x72: value += '\r'; break;
                    default:
                        // An escape nobody defined keeps both characters instead of eating the
                        // backslash: what the patcher cannot see it cannot preserve.
                        value += '\\' + String.fromCharCode(escaped);
                        break;
                }
                continue;
            }

            value += String.fromCharCode(code);
            this.offset++;
        }

        if (!closed) {
            this.addError(1002, 'this string has no closing quote before the end of the line',
                start, this.offset, line, column);
        }

        this.emit('string', start, value, line, column);
    }

    private lexHexColor(): void {
        const start = this.offset;
        const line = this.line;
        const column = this.columnAt(start);
        this.offset++;

        // The whole word is taken, not just the hex-looking prefix, so #GGGGGG reports once rather
        // than leaving GGGGGG behind as a bare identifier that fails again somewhere else.
        const digitsStart = this.offset;
        while (this.offset < this.text.length && isIdentifierChar(this.text.charCodeAt(this.offset))) {
            this.offset++;
        }
        const digits = this.text.slice(digitsStart, this.offset);

        let valid = digits.length === 3 || digits.length === 4 || digits.length === 6 || digits.length === 8;
        if (valid) {
            for (let index = 0; index < digits.length; index++) {
                if (!isHexDigit(digits.charCodeAt(index))) {
                    valid = false;
                    break;
                }
            }
        }

        if (!valid) {
            this.addError(1005,
                `'#${ellipsize(digits)}' is not a colour: a '#' takes 3, 4, 6 or 8 hex digits`,
                start, this.offset, line, column);
        }

        this.emit('hexColor', start, digits, line, column);
    }

    private lexAssetPath(): void {
        const start = this.offset;
        const line = this.line;
        const column = this.columnAt(start);
        while (this.offset < this.text.length && isPathChar(this.text.charCodeAt(this.offset))) {
            this.offset++;
        }
        this.emit('assetPath', start, this.text.slice(start, this.offset), line, column);
    }

    /** True when the character cannot begin any token, so a run of them is one mistake, not many. */
    private isUnexpectedAt(offset: number): boolean {
        const code = this.text.charCodeAt(offset);
        if (code === 0x3c /* < */) {
            // Only unexpected when it is not the arrow, so a run never swallows a `<-`.
            return !(offset + 1 < this.text.length && this.text.charCodeAt(offset + 1) === 0x2d);
        }
        if (isInlineWhitespace(code) || code === LF || code === CR) {
            return false;
        }
        if (isIdentifierStart(code) || isDigit(code)) {
            return false;
        }
        switch (code) {
            case 0x2d: case 0x22: case 0x23: case 0x2f: case 0x3b:
            case 0x7b: case 0x7d: case 0x28: case 0x29: case 0x2c:
            case 0x2e: case 0x3a: case 0x3d: case 0x2b: case 0x40:
                return false;
            default:
                return true;
        }
    }

    private lexUnexpectedRun(): void {
        const start = this.offset;
        const line = this.line;
        const column = this.columnAt(start);
        while (this.offset < this.text.length && this.isUnexpectedAt(this.offset)) {
            this.offset++;
        }

        // Reported as a run rather than per character: the case that gets here in practice is a
        // source file aimed at something that is not a .dui at all. Letters never reach here,
        // non-ASCII ones included -- see isIdentifierChar.
        const run = this.text.slice(start, this.offset);
        this.addError(1001, `'${ellipsize(run)}' cannot begin anything this grammar recognises`,
            start, this.offset, line, column);
    }
}

const SINGLE_CHAR_KINDS = new Map<number, TokenKind>([
    [0x7b, 'openBrace'], [0x7d, 'closeBrace'],
    [0x28, 'openParen'], [0x29, 'closeParen'],
    [0x2c, 'comma'], [0x2e, 'dot'], [0x3a, 'colon'], [0x3d, 'equals'],
    [0x2b, 'plus'], [0x40, 'at'],
]);

/** Lexes the whole file. Never throws: mistakes become diagnostics and tokens of the right shape. */
export function scan(text: string): ScanResult {
    const lexer = new Lexer(text);
    lexer.run();
    return { tokens: lexer.tokens, diagnostics: lexer.diagnostics };
}
