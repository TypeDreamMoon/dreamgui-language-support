/**
 * The .dui formatter: text in, text out, no editor anywhere near it.
 *
 * It re-emits the token stream rather than editing the characters in place, which is the only way
 * to be sure a string literal is never touched -- every piece it writes is a verbatim slice of the
 * source between a token's own offsets, so what is inside a quote, a path or a comment leaves this
 * file exactly as it arrived. What the formatter decides is the WHITESPACE BETWEEN pieces, and
 * nothing else.
 *
 * Its conventions are the ones the designer's write-back already prints
 * (DreamGUIEditor/Private/Text/DreamUITextPatcher.cpp): `Name = Value` with single spaces, ` {`
 * opening a block, `}` alone on a line at the owner's indent, and the file's own line ending. Two
 * tools writing the same file must agree about layout or every designer edit shows up as a
 * whole-file diff in the next review.
 *
 * The guard rail is the point of the whole design: formatting is refused rather than risked. After
 * laying the file out, both texts are scanned again and their token sequences compared; if they
 * differ by so much as one token, the ORIGINAL is returned and the editor is told there is nothing
 * to change. `X = 1 . 5` is the shape that reaches it -- three tokens the layout rules would print
 * as `1.5`, which is one -- and there is no version of "reformat" worth silently rewriting a value
 * for.
 *
 * No vscode import here, ever: src/core/ is the seam a future LSP server or another IDE reuses.
 */

import { CommentSpan, Token, scan } from './scanner';
import { buildStructure, PropertyStmt, StructNode } from './structure';

export interface FormatOptions {
    /** One level of indentation: the editor's tab, spelled out. */
    indent: string;
    eol: '\n' | '\r\n';
}

/**
 * The formatted text, or the original when laying it out would have changed what the file says.
 * Callers compare the result with their input: equal means "no edit", never "failed".
 */
export function formatDui(text: string, options: FormatOptions): string {
    const laid = layout(text, options);
    if (laid === text) {
        return text;
    }
    const before = tokenSignature(text);
    const after = tokenSignature(laid);
    if (before.length !== after.length || before.some((piece, index) => piece !== after[index])) {
        return text;
    }
    return laid;
}

/**
 * What must survive formatting, as comparable strings: every token that is not whitespace, by kind
 * and by both spellings (the scanner's resolved text and the raw source), then every comment with
 * its line endings normalised so a CRLF-to-LF pass is not mistaken for an edit.
 *
 * Separators are left out deliberately: a `;` and a newline are one token to this grammar, and the
 * formatter is allowed to keep a statement where the author put it without that reading as change.
 */
export function tokenSignature(text: string): string[] {
    const scanned = scan(text);
    const out: string[] = [];
    for (const token of scanned.tokens) {
        if (token.kind === 'separator' || token.kind === 'end') {
            continue;
        }
        out.push(`${token.kind}\u0000${token.text}\u0000${text.slice(token.start, token.end)}`);
    }
    for (const comment of scanned.comments) {
        out.push(`comment\u0000${normalizeBreaks(text.slice(comment.start, comment.end))}`);
    }
    return out;
}

function normalizeBreaks(text: string): string {
    return text.replace(/\r\n|\r/g, '\n');
}

/** Kinds that end an operand, which is what decides whether a '(' is a call or a clause. */
const OPERAND_KINDS: ReadonlySet<string> = new Set<string>([
    'identifier', 'number', 'string', 'hexColor', 'assetPath', 'closeParen',
]);

/** A break the layout owes: see `pendingBreak`. */
type PendingBreak = 'none' | 'soft' | 'hard';

/** A token, or a comment, in source order -- the two streams the scanner keeps apart. */
type Piece =
    | { comment: undefined; token: Token; index: number }
    | { comment: CommentSpan; token: undefined; index: -1 };

function layout(text: string, options: FormatOptions): string {
    const scanned = scan(text);
    const pieces = merge(scanned.tokens, scanned.comments);
    const shape = statementShape(text);
    /** The last token put on the line is a '-' that negates what follows (`<- -Count()`), not one that subtracts. */
    let unaryMinus = false;
    /** Inside a block kept on its one line (see staysOnOneLine): no break after its '{', none before its '}'. */
    let inlineBlock = false;

    const lines: string[] = [];
    /** The line being built, without its indent. */
    let line = '';
    let lineIndent = 0;
    /**
     * True while the current line came out of the inside of a block comment, where the leading
     * whitespace is part of what the author wrote and re-indenting it would edit the comment.
     */
    let lineVerbatim = false;
    let depth = 0;
    let parenDepth = 0;
    /** The last token put on the current line -- what the spacing rules look back at. */
    let previous: Token | undefined;
    /**
     * A break the layout owes before the next piece. 'soft' lets a comment that was written on
     * this same source line stay on it (`Widget Root { // trailing`); 'hard' lets nothing past.
     */
    let pendingBreak: PendingBreak = 'none';
    /** Blank lines seen while nothing was on the line. Any number of them come back as one. */
    let blankBudget = 0;

    const flush = (): void => {
        if (line.length === 0) {
            return;
        }
        if (blankBudget > 0 && lines.length > 0) {
            lines.push('');
        }
        blankBudget = 0;
        lines.push(lineVerbatim ? line : options.indent.repeat(lineIndent) + line);
        line = '';
        lineVerbatim = false;
        previous = undefined;
    };

    const append = (piece: string, gap: string): void => {
        if (line.length === 0) {
            if (!lineVerbatim) {
                lineIndent = depth;
            }
            line = piece;
            return;
        }
        line += gap + piece;
    };

    /** The whitespace between what is already on the line and `kind`. See the file header. */
    const gapBefore = (kind: string, opensWasClause: boolean, token?: Token): string => {
        if (line.length === 0) {
            return '';
        }
        if (previous === undefined) {
            // Only a comment on the line so far, and nothing may be glued to a comment.
            return ' ';
        }
        const before = previous.kind === 'separator' ? 'semicolon' : (previous.kind as string);
        if (token && shape.statementStarts.has(token.start) && before !== 'semicolon' && before !== 'openBrace'
            && !(previous.kind === 'identifier' && previous.text === 'slot')) {
            // A second statement on the line with no ';' between: `Label <- Item.Label  Count <- Item.Count`,
            // `@slot { SizeRule = Fill  Padding = (0, 8, 0, 0) }`. Two spaces, the language reference's own spelling --
            // one would read as a single statement with a stray word in it. (A one-line `@slot Padding = …` is a
            // statement whose span starts at its path, right after the `slot` it belongs to: one space there.)
            return '  ';
        }
        if (kind === 'comma' || kind === 'closeParen' || kind === 'dot' || kind === 'semicolon') {
            return '';
        }
        if (token && (shape.alignedStarts.has(token.start) || (kind === 'openBrace' && shape.rowEnds.has(previous.end)))) {
            // A `rows` table's values after the first, and the block a row ends in: the author's spacing is kept, as
            // long as it is spaces on the line. A table aligned into columns is the point of writing one.
            const written = text.slice(previous.end, token.start);
            return /^[ 	]+$/.test(written) ? written : ' ';
        }
        if (kind === 'openParen' && shape.rowsParenAfter.has(previous.end)) {
            return ' '; // `rows Row : ListRow (Label, Description)` -- a column list, not a call to ListRow
        }
        if (unaryMinus && (kind === 'identifier' || kind === 'openParen')) {
            // `-Count()`, `-(A + B)`: the scanner only reads a '-' with a word or a '(' straight after it as a
            // negation, and `- Count()` read back is a malformed number -- which the guard rail would catch, by
            // refusing to format the file at all.
            return '';
        }
        if (kind === 'openParen' && token && shape.conditionStarts.has(token.start)) {
            return ' '; // `if (A || B) {` -- a condition, not a call to something named `if`
        }
        if (before === 'dot' || before === 'openParen') {
            return '';
        }
        if ((before === 'at' || before === 'bang')
            && (OPERAND_KINDS.has(kind) || kind === 'openParen' || kind === 'bang' || kind === 'at')) {
            // '@Accent', '!IsMuted()'. Anything else after them is not what they prefix, and
            // gluing it on would invent a token: `! =` is not `!=`.
            return '';
        }
        if (kind === 'openParen' && !opensWasClause && OPERAND_KINDS.has(before)) {
            return ''; // a call, not a clause: GetHistory()
        }
        if (kind === 'colon' && parenDepth > 0) {
            return ''; // '(was: OldId)' -- the compiler's own spelling
        }
        return ' ';
    };

    const onLineBreak = (): void => {
        if (line.length > 0) {
            flush();
            pendingBreak = 'none';
            return;
        }
        if (pendingBreak !== 'none') {
            // The author's own break is the break the layout was about to force.
            pendingBreak = 'none';
            return;
        }
        if (lines.length > 0) {
            blankBudget++;
        }
    };

    for (let index = 0; index < pieces.length; index++) {
        const piece = pieces[index];

        if (piece.comment) {
            const raw = text.slice(piece.comment.start, piece.comment.end);
            const owed: PendingBreak = pendingBreak;
            let broke = false;
            if (owed === 'hard' || (owed === 'soft' && startsItsLine(text, piece.comment.start))) {
                flush();
                broke = true;
            }
            const segments = normalizeBreaks(raw).split('\n');
            append(segments[0], line.length > 0 ? ' ' : '');
            for (let segment = 1; segment < segments.length; segment++) {
                flush();
                if (segment < segments.length - 1) {
                    // An interior line of a block comment: whatever the author aligned in there is
                    // the comment's content, not this formatter's business.
                    lines.push(segments[segment]);
                } else {
                    lineVerbatim = true;
                    line = segments[segment];
                }
            }
            // Nothing may follow a line comment on its line, ever: the next thing would be inside
            // it. A block comment that merely rode along on a line the layout still owes a break
            // after leaves that debt exactly where it found it.
            pendingBreak = piece.comment.kind === 'line' ? 'hard'
                : (broke || segments.length > 1 ? 'none' : owed);
            continue;
        }

        const token = piece.token;
        if (token.kind === 'separator' && token.text !== ';') {
            // A zero-width separator is the one the scanner invents after a block comment that
            // crossed a line, so that the statement the comment interrupted still ends. It sits on
            // top of the real line break that follows it, and counting both is one blank line the
            // author never typed.
            if (token.start !== token.end) {
                onLineBreak();
            }
            continue;
        }

        if (pendingBreak !== 'none') {
            flush();
            pendingBreak = 'none';
        }

        if (token.kind === 'openBrace') {
            const next = pieces[index + 1];
            if (next && !next.comment && next.token.kind === 'closeBrace') {
                // An empty block stays on its line: `+ Overlay {}` is how this language writes
                // "this component has no properties", and splitting it says nothing extra.
                append('{', gapBefore('openBrace', false, token));
                append('}', '');
                previous = next.token;
                index++;
                unaryMinus = false;
                // A block, even an empty one, is the end of the statement that opened it -- except inside a block
                // kept on one line, whose own '}' is what ends the line.
                if (!inlineBlock) {
                    pendingBreak = 'soft';
                }
                continue;
            }
            append('{', gapBefore('openBrace', false, token));
            previous = token;
            unaryMinus = false;
            if (!inlineBlock && staysOnOneLine(pieces, index)) {
                // `Tab Tab_0 : NavTab { Label = "MAP"; Icon = @IconMap }`, `@slot { SizeRule = Fill  Padding = … }`,
                // `events { Picked(Number Index); Closed }`: written on one line, and holding nothing that is a block
                // of its own, so kept there. The language reference writes these one-liners on purpose, and a
                // component-heavy screen is mostly made of them; spread over three lines each they would be a file
                // three times as long saying nothing more.
                inlineBlock = true;
                continue;
            }
            depth++;
            pendingBreak = 'soft';
            continue;
        }

        if (token.kind === 'closeBrace' && inlineBlock) {
            inlineBlock = false;
            append('}', ' ');
            previous = token;
            continue;
        }

        if (token.kind === 'closeBrace') {
            depth = Math.max(0, depth - 1);
            flush(); // a '}' owns its line, and its indent is the one its owner opened at
            append('}', '');
            previous = token;
            continue;
        }

        const kind = token.kind === 'separator' ? 'semicolon' : (token.kind as string);
        append(text.slice(token.start, token.end), gapBefore(kind, opensWasClause(scanned.tokens, piece.index), token));
        // Asked before `previous` moves on: a '-' after an operand subtracts, anywhere else it negates.
        unaryMinus = token.kind === 'minus'
            && !(previous !== undefined && OPERAND_KINDS.has(previous.kind) && previous.text !== 'if');
        previous = token;
        if (token.kind === 'openParen') {
            parenDepth++;
        } else if (token.kind === 'closeParen') {
            parenDepth = Math.max(0, parenDepth - 1);
        }
    }

    flush();
    return lines.length === 0 ? '' : lines.join(options.eol) + options.eol;
}

/**
 * True when this '(' opens a rename clause rather than an argument list. `was` is a reserved word,
 * so no function can be called one and the two shapes never collide.
 */
function opensWasClause(tokens: Token[], index: number): boolean {
    if (index < 0 || tokens[index]?.kind !== 'openParen') {
        return false;
    }
    return tokens[index + 1]?.kind === 'identifier' && tokens[index + 1].text === 'was'
        && tokens[index + 2]?.kind === 'colon';
}

/** True when nothing but whitespace precedes `offset` on its line. */
function startsItsLine(text: string, offset: number): boolean {
    for (let at = offset - 1; at >= 0; at--) {
        const code = text.charCodeAt(at);
        if (code === 0x0a || code === 0x0d) {
            return true;
        }
        if (code !== 0x20 && code !== 0x09 && code !== 0x0b && code !== 0x0c) {
            return false;
        }
    }
    return true;
}

function merge(tokens: Token[], comments: CommentSpan[]): Piece[] {
    const out: Piece[] = [];
    let comment = 0;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === 'end') {
            continue;
        }
        // Comments first on a tie: a comment starts where no token can, and the synthetic separator
        // the scanner emits after a multi-line block comment sits exactly on its end offset.
        while (comment < comments.length && comments[comment].start <= token.start) {
            out.push({ comment: comments[comment], token: undefined, index: -1 });
            comment++;
        }
        out.push({ comment: undefined, token, index });
    }
    while (comment < comments.length) {
        out.push({ comment: comments[comment], token: undefined, index: -1 });
        comment++;
    }
    return out;
}

/**
 * What the layout needs from the grammar and cannot see in the tokens: where a statement begins that shares its line
 * with the one before it, and which '(' opens an `if`'s condition rather than a call. Read off the structural parse,
 * which mirrors the compiler's statement boundaries -- `Label <- Item.Label  Kind <- Item.Kind` is two statements
 * there, and a token-level guess would be fooled by `Number Gap = 4`, a props line whose second word is followed by
 * an '=' too.
 */
function statementShape(text: string): {
    statementStarts: Set<number>; conditionStarts: Set<number>;
    alignedStarts: Set<number>; rowEnds: Set<number>; rowsParenAfter: Set<number>;
} {
    const structure = buildStructure(text);
    const statementStarts = new Set<number>();
    const conditionStarts = new Set<number>();
    /** A `rows` line's values after its first: their spacing is the author's (see gapBefore). */
    const alignedStarts = new Set<number>();
    /** Where a `rows` line's last value ends, so the block it may end in keeps its spacing too. */
    const rowEnds = new Set<number>();
    /** Where the token before a `rows` header's column list ends: that '(' is no call. */
    const rowsParenAfter = new Set<number>();
    const addAll = (statements: readonly PropertyStmt[] | undefined): void => {
        const cells = (statements ?? []).filter((statement) => statement.isRowCell);
        cells.forEach((cell, at) => {
            if (at > 0) {
                alignedStarts.add(cell.start);
            }
            if (at === cells.length - 1) {
                rowEnds.add(cell.end);
            }
        });
        for (const statement of statements ?? []) {
            // A row's values are one statement's parts, not statements sharing a line.
            if (!statement.isRowCell) {
                statementStarts.add(statement.start);
            }
        }
    };
    for (const table of structure.rowsTables ?? []) {
        rowsParenAfter.add(table.styleName && table.styleNameStart !== undefined
            ? table.styleNameStart + table.styleName.length : table.tagEnd);
    }
    const visit = (node: StructNode): void => {
        addAll(node.properties);
        for (const component of node.components) {
            addAll(component.properties);
        }
        if (node.kind === 'branch' && node.conditionStart !== undefined) {
            conditionStarts.add(node.conditionStart);
        }
        node.children.forEach(visit);
    };
    structure.roots.forEach(visit);
    for (const style of structure.styles) {
        addAll(style.properties);
        for (const component of style.components) {
            addAll(component.properties);
        }
    }
    return { statementStarts, conditionStarts, alignedStarts, rowEnds, rowsParenAfter };
}

/**
 * True when the block opened by the '{' at `pieces[open]` was written on one line and holds no block of its own but
 * empty ones (`RectBlock Key0 : KeyCap { Text KeyText0 : KeyCapText {} }`). Such a block keeps its line. A comment
 * inside, a line break, or a nested block with something in it, and the block is laid out as every other block is.
 */
function staysOnOneLine(pieces: Piece[], open: number): boolean {
    for (let at = open + 1; at < pieces.length; at++) {
        const piece = pieces[at];
        if (piece.comment) {
            return false;
        }
        const kind = piece.token.kind;
        if (kind === 'separator' && piece.token.text !== ';') {
            return false; // a line break, or the one a line-crossing block comment leaves behind
        }
        if (kind === 'openBrace') {
            const next = pieces[at + 1];
            if (!next || next.comment || next.token.kind !== 'closeBrace') {
                return false;
            }
            at++; // an empty block, `{}`: part of the line
            continue;
        }
        if (kind === 'closeBrace') {
            return true;
        }
    }
    return false; // never closed: the guard rail's business, laid out the ordinary way
}
