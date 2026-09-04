/**
 * The structural layer: a token stream in, one file's skeleton out -- the node tree, styles,
 * resources, `@` references, plus every diagnostic that can be settled from structure alone.
 *
 * A forgiving mirror of the compiler's parser (FParser in DreamUISourceFile.cpp), not a port of
 * it. The difference is deliberate: the parser's job is to refuse, this layer's job is to answer
 * "what is where" on every keystroke and to raise only the codes whose verdict one file's
 * characters fully determine. Anything it does not recognise it steps over silently -- the
 * compiler will word the refusal (DUI2001 and friends) better than a mirror could, and a mirror
 * that refuses MORE than the compiler is the failure mode this extension is not allowed to have.
 *
 * Where this file does diagnose, the wording is the compiler's, verbatim, and the same rules
 * apply: names compare case insensitively (they all become FNames downstream), keywords compare
 * case sensitively. Three codes (DUI3010/3011/3012) are reported here as warnings and never as
 * errors: the compiler raises them as errors and its message is the fuller one, so these are the
 * live hint that arrives before a compile does -- see MAILBOX_SUPPRESSED in core/mailbox.ts, which
 * deliberately no longer filters them.
 *
 * No vscode import here: src/core/ is the seam a future LSP server or another IDE reuses.
 */

import { Token, TokenKind, LexicalDiagnostic, CommentSpan, scan, RESERVED_WORDS } from './scanner';

export type DuiDiagnostic = LexicalDiagnostic;

export interface StructNode {
    kind: 'node' | 'namedSlot' | 'loop';
    /** Node: the type as written (identifier or /asset path). NamedSlot: 'slot'. Loop: 'for' | 'each'. */
    tag: string;
    /** Node id / slot name / loop variable. Empty when the header is missing one. */
    id: string;
    /** Position of the id token itself, when there is one -- rename and references anchor here. */
    idLine?: number;
    idColumn?: number;
    idStart?: number;
    /** Position of the header (the tag token). */
    line: number;
    column: number;
    start: number;
    wasId?: string;
    /** The whole '(was: X)' clause, opening paren to closing paren inclusive. */
    wasStart?: number;
    wasEnd?: number;
    styleName?: string;
    styleNameStart?: number;
    styleNameLine?: number;
    styleNameColumn?: number;
    components: StructComponent[];
    children: StructNode[];
    /** The node's own property statements, '@slot' ones included and flagged. */
    properties: PropertyStmt[];
    /** Offsets of the body: first token after '{', and the '}' itself. Absent when there is no block. */
    bodyStart?: number;
    bodyEnd?: number;
}

export interface StructComponent {
    /** As written: 'Overlay' or '/Script/Module.Class'. */
    name: string;
    line: number;
    column: number;
    start: number;
    bodyStart?: number;
    bodyEnd?: number;
}

export interface StyleDecl {
    name: string;
    base?: string;
    line: number;
    column: number;
    nameStart: number;
    baseStart?: number;
    baseLine?: number;
    baseColumn?: number;
    bodyStart?: number;
    bodyEnd?: number;
    properties: PropertyStmt[];
}

export interface ResourceDecl {
    /** The type keyword as written (Color, Number, ...). Not validated here. */
    type: string;
    name: string;
    valueText: string;
    line: number;
    column: number;
    nameStart: number;
    valueStart: number;
    valueEnd: number;
}

/** One `@Name` use in value position. */
export interface ResourceRef {
    name: string;
    line: number;
    column: number;
    /** Offset of the '@'. */
    start: number;
}

/** One property statement, as spans into the source. */
export interface PropertyStmt {
    /** The dotted path as written. */
    path: string;
    pathStart: number;
    /** Whole statement: first path token to the end of the value. */
    start: number;
    end: number;
    op: 'equals' | 'arrow' | 'eventArrow' | 'twoWayArrow';
    /** True when the statement was led by '@slot'. */
    isSlot: boolean;
    /** Value span (op 'equals' only). */
    valueStart?: number;
    valueEnd?: number;
}

/**
 * One name the right side of an arrow refers to. `Event -> Handler` contributes the handler;
 * `Prop <- Expr` contributes every call and every variable the expression mentions (there can be
 * several now that `<-` takes expressions); `Prop <-> Var` contributes the mirrored variable.
 */
export interface BindingRef {
    /** True for `->`: the left side is an event, the right side a handler someone else calls. */
    isEvent: boolean;
    /** The left-hand path, as offsets. */
    pathStart: number;
    pathEnd: number;
    /** The function / handler / variable name on the right. Dotted for `Item.Member` in a loop. */
    name: string;
    nameStart: number;
    /**
     * True when the name refers to a VARIABLE on the class rather than a function: a `<->` right
     * side, or a bare identifier in a binding expression (parens are what make a call).
     */
    isVariable?: boolean;
}

/** One `use "path"` directive. The path is as written; resolution belongs to the compiler. */
export interface UseDirective {
    path: string;
    line: number;
    column: number;
    /** Offset of the 'use' keyword. */
    start: number;
    /** The quoted string, quotes included -- what a document link underlines. */
    pathStart: number;
    pathEnd: number;
}

/** A block something can stand inside, for answering "what scope is this offset in". */
export interface Scope {
    kind: 'node' | 'namedSlot' | 'component' | 'style' | 'resources' | 'loop';
    /** Node type / component name / style name / loop keyword. */
    name: string;
    /** Node id, when the scope is a node. */
    id?: string;
    bodyStart: number;
    bodyEnd: number;
}

export interface StructureResult {
    classPath?: { path: string; line: number; column: number; start: number; end: number };
    /** Top-level nodes. A well-formed file has exactly one. */
    roots: StructNode[];
    styles: StyleDecl[];
    resources: ResourceDecl[];
    resourceRefs: ResourceRef[];
    bindings: BindingRef[];
    imports: UseDirective[];
    scopes: Scope[];
    diagnostics: DuiDiagnostic[];
}

const foldName = (name: string): string => name.toLowerCase();

/**
 * `DreamUIAst::MaxNestingDepth`, mirrored. Deep enough that no hand-written or generated .dui
 * reaches it, so meeting it means a file that is malformed or hostile rather than merely deep.
 *
 * The reason this layer counts at all is the same reason the compiler does: both parsers are
 * recursive descent, and a file nesting a thousand deep is answered by exhausting the stack. In
 * the compiler that takes the editor with it; here it takes the extension host, and a dead host
 * is every language feature in every open file, from one pasted file.
 */
export const MAX_NESTING_DEPTH = 256;

class Parser {
    private index = 0;
    private readonly loopVariables: string[] = [];
    /** How many nested block bodies the cursor is inside. One counter: the stack is one stack. */
    private nestingDepth = 0;
    /** DUI2013 is said once per file: a file that reaches the limit reaches it at every level. */
    private reportedNestingLimit = false;

    readonly result: StructureResult = {
        roots: [], styles: [], resources: [], resourceRefs: [], bindings: [], imports: [], scopes: [], diagnostics: [],
    };

    constructor(private readonly tokens: Token[]) {}

    // ---- token plumbing ------------------------------------------------------------------------

    private peek(ahead = 0): Token {
        return this.tokens[Math.min(this.index + ahead, this.tokens.length - 1)];
    }

    private current(): Token {
        return this.peek(0);
    }

    private atEnd(): boolean {
        return this.current().kind === 'end';
    }

    private check(kind: TokenKind): boolean {
        return this.current().kind === kind;
    }

    /** Keywords are grammar, not names: case sensitive, and never a back-door for a quoted id. */
    private checkKeyword(word: string): boolean {
        const token = this.current();
        return token.kind === 'identifier' && token.text === word;
    }

    private advance(): void {
        if (!this.atEnd()) {
            this.index++;
        }
    }

    private skipSeparators(): void {
        while (this.check('separator')) {
            this.advance();
        }
    }

    private skipToStatementBoundary(): void {
        while (!this.atEnd() && !this.check('separator') && !this.check('closeBrace')) {
            if (this.check('openParen')) {
                this.skipTuple();
                continue;
            }
            this.advance();
        }
    }

    private error(code: number, message: string, at: Token | { line: number; column: number; start: number; end: number }): void {
        this.result.diagnostics.push({
            code, severity: 'error', message,
            line: at.line, column: at.column, start: at.start, end: at.end,
        });
    }

    private warning(code: number, message: string, at: Token | { line: number; column: number; start: number; end: number }): void {
        this.result.diagnostics.push({
            code, severity: 'warning', message,
            line: at.line, column: at.column, start: at.start, end: at.end,
        });
    }

    // ---- the file ------------------------------------------------------------------------------

    parseFile(): void {
        let sawAnything = false;
        for (;;) {
            this.skipSeparators();
            if (this.atEnd()) {
                break;
            }
            sawAnything = true;

            const before = this.index;
            if (this.checkKeyword('class')) {
                this.parseClassDeclaration();
            } else if (this.checkKeyword('use')) {
                this.parseUseDirective();
            } else if (this.checkKeyword('style') && this.peek(1).kind === 'identifier') {
                this.parseStyleDeclaration();
            } else if (this.checkKeyword('resources')) {
                this.parseResourcesBlock();
            } else if (this.looksLikeProperty()) {
                // A property at the top level is the compiler's refusal to word; stepping over it
                // beats mistaking `A = 1` for a node header with no id.
                this.skipToStatementBoundary();
            } else if (this.check('identifier') || this.check('assetPath')) {
                const node = this.parseNode();
                if (node) {
                    if (this.result.roots.length === 0) {
                        this.result.roots.push(node);
                    } else {
                        // The first one wins and the rest are reported where they stand.
                        this.error(2006,
                            `a .dui holds exactly one root node, and '${node.id}' is a second one`,
                            this.idAnchor(node));
                        this.result.roots.push(node); // kept for the outline; the diagnostic is the verdict
                    }
                }
            } else {
                // Something the grammar does not start a statement with. The compiler words this
                // refusal (DUI2001); this layer steps over it.
                this.skipToStatementBoundary();
            }

            // Forward progress, unconditionally -- a recovery path that consumes nothing would
            // turn a malformed file into a hang.
            if (this.index === before) {
                this.advance();
            }
        }

        // The compiler reports an empty file as having no root; here a file with no substance at
        // all stays quiet -- a freshly created file should not open red. Reporting less than the
        // compiler is allowed; reporting differently is not, so the wording matches.
        if (this.result.roots.length === 0 && sawAnything) {
            const last = this.tokens[this.tokens.length - 1];
            this.error(2006, 'this file declares no root node', last);
        }

        this.checkNamesAcrossTheTree();
    }

    private parseClassDeclaration(): void {
        this.advance(); // 'class'
        if (!this.check('assetPath')) {
            this.skipToStatementBoundary();
            return;
        }
        const token = this.current();
        if (token.text.length > 1 && !this.result.classPath) {
            this.result.classPath = {
                path: token.text, line: token.line, column: token.column, start: token.start, end: token.end,
            };
        }
        this.advance();
    }

    /**
     * `use "Styles/Common.dui"` -- recorded for navigation, never judged: whether the path
     * resolves, whether the file parses, whether the chain cycles all need OTHER files, and the
     * verdicts (DUI2012) are the compiler's to word. A malformed one (no quoted path) is likewise
     * the compiler's refusal; this layer steps over it.
     */
    private parseUseDirective(): void {
        const keyword = this.current();
        this.advance(); // 'use'
        if (!this.check('string')) {
            this.skipToStatementBoundary();
            return;
        }
        const pathToken = this.current();
        this.result.imports.push({
            path: pathToken.text,
            line: keyword.line, column: keyword.column, start: keyword.start,
            pathStart: pathToken.start, pathEnd: pathToken.end,
        });
        this.advance();
    }

    // ---- styles and resources ------------------------------------------------------------------

    private parseStyleDeclaration(): void {
        const keyword = this.current();
        this.advance(); // 'style'

        const nameToken = this.current();
        const style: StyleDecl = {
            name: nameToken.text,
            line: keyword.line, column: keyword.column, nameStart: nameToken.start,
            properties: [],
        };
        this.advance();

        if (this.check('colon') && this.peek(1).kind === 'identifier') {
            this.advance();
            const baseToken = this.current();
            style.base = baseToken.text;
            style.baseStart = baseToken.start;
            style.baseLine = baseToken.line;
            style.baseColumn = baseToken.column;
            this.advance();
        }

        if (this.check('openBrace')) {
            const open = this.current();
            this.advance();
            style.bodyStart = this.current().start;
            this.parsePropertyOnlyBlock(open, style.properties);
            style.bodyEnd = this.tokens[Math.max(0, this.index - 1)].start;
            this.result.scopes.push({ kind: 'style', name: style.name, bodyStart: style.bodyStart, bodyEnd: style.bodyEnd });
        }

        const duplicate = this.result.styles.find((existing) => foldName(existing.name) === foldName(style.name));
        if (duplicate) {
            this.error(3005, `style '${style.name}' is declared twice`,
                { line: style.line, column: style.column, start: style.nameStart, end: style.nameStart + style.name.length });
            return; // dropped, so the first one keeps naming the style for everybody downstream
        }
        this.result.styles.push(style);
    }

    private parseResourcesBlock(): void {
        this.advance(); // 'resources'
        this.skipSeparators();
        if (!this.check('openBrace')) {
            return;
        }
        const open = this.current();
        this.advance();
        const bodyStart = this.current().start;

        for (;;) {
            this.skipSeparators();
            if (this.check('closeBrace')) {
                break;
            }
            if (this.atEnd()) {
                this.error(2002, "this '{' never reaches its '}'", open);
                break;
            }
            const before = this.index;

            if (this.check('identifier') && this.peek(1).kind === 'identifier') {
                const typeToken = this.current();
                this.advance();
                const nameToken = this.current();
                this.advance();
                if (this.check('equals')) {
                    this.advance();
                    const valueStart = this.current().start;
                    this.parseValueUntilBoundary();
                    const valueEnd = this.tokens[Math.max(0, this.index - 1)].end;
                    const entry: ResourceDecl = {
                        type: typeToken.text, name: nameToken.text,
                        valueText: '', // filled by the caller, which owns the source text
                        line: nameToken.line, column: nameToken.column, nameStart: nameToken.start,
                        valueStart, valueEnd,
                    };
                    const duplicate = this.result.resources.find(
                        (existing) => foldName(existing.name) === foldName(entry.name));
                    if (duplicate) {
                        this.error(3014, `resource '${entry.name}' is declared twice`, nameToken);
                    } else {
                        this.result.resources.push(entry);
                    }
                } else {
                    this.skipToStatementBoundary();
                }
            } else {
                this.skipToStatementBoundary();
            }

            if (this.index === before) {
                this.advance();
            }
        }

        const bodyEnd = this.current().start;
        if (this.check('closeBrace')) {
            this.advance();
        }
        this.result.scopes.push({ kind: 'resources', name: 'resources', bodyStart, bodyEnd });
    }

    // ---- nodes ---------------------------------------------------------------------------------

    private parseNode(): StructNode | undefined {
        if (!this.check('identifier') && !this.check('assetPath')) {
            this.advance();
            return undefined;
        }
        const typeToken = this.current();
        this.advance();

        let tag = typeToken.text;
        // `Native.Toggle` -- a scoped tag. The scanner hands it over as identifier/dot/identifier
        // because a dot elsewhere separates property path segments; the tag position is the one
        // place they mean a single name, joined here exactly as the compiler joins them.
        if (this.check('dot') && this.peek(1).kind === 'identifier') {
            this.advance();
            tag = `${tag}.${this.current().text}`;
            this.advance();
        }

        const node: StructNode = {
            kind: 'node', tag, id: '',
            line: typeToken.line, column: typeToken.column, start: typeToken.start,
            components: [], children: [], properties: [],
        };

        if (this.check('identifier')) {
            const idToken = this.current();
            node.id = idToken.text;
            node.idLine = idToken.line;
            node.idColumn = idToken.column;
            node.idStart = idToken.start;
            if (RESERVED_WORDS.has(node.id)) {
                this.error(3002, `'${node.id}' is a keyword and cannot be a node id`, idToken);
            }
            this.advance();
        } else if (this.check('number')) {
            // Where `2ndPanel` lands, and a bare `2` with it: SanitizeIdentifier WOULD take it, by
            // prefixing an underscore -- and then every binding written against the file's name
            // resolves to nothing.
            const idToken = this.current();
            this.error(3002,
                `'${ellipsize(idToken.text)}' cannot be a node id: an id does not begin with a digit`, idToken);
            node.id = idToken.text;
            node.idLine = idToken.line;
            node.idColumn = idToken.column;
            node.idStart = idToken.start;
            this.advance();
        } else {
            this.error(2004,
                `'${node.tag}' needs an id, as in '${node.tag} MyName' -- or an '=' if it was meant to be a property`,
                typeToken);
        }

        // The two optional clauses in either order, as the compiler takes them.
        for (;;) {
            if (this.check('openParen')) {
                this.parseWasClause(node);
                continue;
            }
            if (this.check('colon')) {
                this.advance();
                if (this.check('identifier')) {
                    const styleToken = this.current();
                    node.styleName = styleToken.text;
                    node.styleNameStart = styleToken.start;
                    node.styleNameLine = styleToken.line;
                    node.styleNameColumn = styleToken.column;
                    this.advance();
                }
                continue;
            }
            break;
        }

        if (this.check('openBrace')) {
            const open = this.current();
            this.advance();
            node.bodyStart = this.current().start;
            this.parseNodeBody(node, open);
            node.bodyEnd = this.tokens[Math.max(0, this.index - 1)].start;
            this.result.scopes.push({
                kind: 'node', name: node.tag, id: node.id, bodyStart: node.bodyStart, bodyEnd: node.bodyEnd,
            });
        }
        return node;
    }

    private parseWasClause(node: StructNode): void {
        const open = this.current();
        this.advance(); // '('
        if (this.checkKeyword('was') && this.peek(1).kind === 'colon'
            && this.peek(2).kind === 'identifier' && this.peek(3).kind === 'closeParen') {
            node.wasId = this.peek(2).text;
            node.wasStart = open.start;
            node.wasEnd = this.peek(3).end;
            this.advance(); this.advance(); this.advance(); this.advance();
            return;
        }
        // Malformed (DUI2008 in the compiler); stepped over here, past the ')'.
        let depth = 1;
        while (!this.atEnd() && depth > 0) {
            if (this.check('openParen')) depth++;
            if (this.check('closeParen')) depth--;
            if (this.check('closeBrace') || this.check('separator')) break;
            this.advance();
        }
    }

    /**
     * True (and reported once) when the cursor is already as deep as this parser will descend.
     *
     * Reported at the '{' the way DUI2002 is, and for the same reason: the brace is where the
     * reader has to go. The mirror counts BLOCKS only, where the compiler also spends the budget
     * on parenthesised sub-expressions -- less than the compiler, never different, and the reason
     * this code is not filtered out of the mailbox.
     */
    private isTooDeep(at: Token): boolean {
        if (this.nestingDepth < MAX_NESTING_DEPTH) {
            return false;
        }
        if (!this.reportedNestingLimit) {
            this.reportedNestingLimit = true;
            this.error(2013,
                `this nests more than ${MAX_NESTING_DEPTH} levels deep; nothing below here was read`, at);
        }
        return true;
    }

    /** Steps over one block body, braces balanced, leaving the cursor past its '}'. */
    private skipBalancedBlockBody(): void {
        let depth = 1;
        while (depth > 0 && !this.atEnd()) {
            if (this.check('openBrace')) {
                depth++;
            } else if (this.check('closeBrace')) {
                depth--;
            }
            this.advance();
        }
    }

    private parseNodeBody(node: StructNode, open: Token): void {
        if (this.isTooDeep(open)) {
            this.skipBalancedBlockBody();
            return;
        }
        this.nestingDepth++;
        try {
            for (;;) {
                this.skipSeparators();
                if (this.check('closeBrace')) {
                    this.advance();
                    return;
                }
                if (this.atEnd()) {
                    // Reported at the '{': the brace is where the reader has to go.
                    this.error(2002, "this '{' never reaches its '}'", open);
                    return;
                }

                const before = this.index;
                this.parseNodeStatement(node);
                if (this.index === before) {
                    this.advance();
                }
            }
        } finally {
            this.nestingDepth--;
        }
    }

    private parseNodeStatement(node: StructNode): void {
        if (this.check('plus')) {
            this.parseComponent(node);
            return;
        }
        if (this.check('at')) {
            // '@slot Prop = Value' and '@key("...")' -- directives, stepped through so their
            // values still get tuple pairing and reference collection.
            this.advance();
            if (this.checkKeyword('slot')) {
                this.advance();
                if (this.looksLikeProperty()) {
                    const stmt = this.parseProperty(true);
                    if (stmt) {
                        node.properties.push(stmt);
                    }
                    return;
                }
            }
            this.skipToStatementBoundary();
            return;
        }
        // Contextual keywords: they only lead a statement when an identifier follows, which is
        // what lets a property actually called Slot keep working.
        if (this.checkKeyword('slot') && this.peek(1).kind === 'identifier') {
            this.parseNamedSlot(node);
            return;
        }
        if ((this.checkKeyword('for') || this.checkKeyword('each')) && this.peek(1).kind === 'identifier') {
            this.parseLoop(node);
            return;
        }
        if (this.checkKeyword('class')) {
            this.skipToStatementBoundary();
            return;
        }
        if (this.looksLikeProperty()) {
            const stmt = this.parseProperty();
            if (stmt) {
                node.properties.push(stmt);
            }
            return;
        }
        const child = this.parseNode();
        if (child) {
            node.children.push(child);
        }
    }

    /**
     * Property or child node, decided by one token of lookahead -- a dotted path settles it on its
     * own, since a node type can never contain a '.'.
     */
    private looksLikeProperty(): boolean {
        if (!this.check('identifier')) {
            return false;
        }
        const next = this.peek(1).kind;
        if (next === 'dot') {
            // `AnchorData.SizeDelta = ...` is a property; `Native.Toggle Mute {` is a node whose
            // tag has a scope. Walk the dotted run and let what FOLLOWS it decide, exactly as the
            // compiler's parser does -- and only an id or an open brace reads as a node, so a
            // property missing its '=' still fails as the property it was meant to be.
            let ahead = 1;
            while (this.peek(ahead).kind === 'dot' && this.peek(ahead + 1).kind === 'identifier') {
                ahead += 2;
            }
            const after = this.peek(ahead).kind;
            return after !== 'identifier' && after !== 'openBrace';
        }
        return next === 'equals' || next === 'arrow' || next === 'eventArrow'
            || next === 'twoWayArrow';
    }

    private parseProperty(isSlot = false): PropertyStmt | undefined {
        // The dotted path.
        const first = this.current();
        let pathEnd = first.end;
        let path = first.text;
        this.advance();
        while (this.check('dot') && this.peek(1).kind === 'identifier') {
            this.advance();
            path += '.' + this.current().text;
            pathEnd = this.current().end;
            this.advance();
        }
        if (this.check('eventArrow')) {
            // `OnClicked -> Confirm` -- a bare handler name, exactly one.
            this.advance();
            if (this.check('identifier')) {
                const fn = this.current();
                this.result.bindings.push({
                    isEvent: true, pathStart: first.start, pathEnd, name: fn.text, nameStart: fn.start,
                });
                this.advance();
            }
            this.parseValueUntilBoundary();
            return {
                path, pathStart: first.start, start: first.start,
                end: this.tokens[Math.max(0, this.index - 1)].end,
                op: 'eventArrow', isSlot,
            };
        }
        if (this.check('twoWayArrow')) {
            // `Value <-> Volume` -- a bare VARIABLE name: the two sides mirror each other, and a
            // call or an expression has no left-hand side to write back into.
            this.advance();
            if (this.check('identifier')) {
                const variable = this.current();
                this.result.bindings.push({
                    isEvent: false, pathStart: first.start, pathEnd,
                    name: variable.text, nameStart: variable.start, isVariable: true,
                });
                this.advance();
            }
            this.parseValueUntilBoundary();
            return {
                path, pathStart: first.start, start: first.start,
                end: this.tokens[Math.max(0, this.index - 1)].end,
                op: 'twoWayArrow', isSlot,
            };
        }
        if (this.check('arrow')) {
            // `Prop <- Expr` -- the right side is an expression now. Whether it type-checks is the
            // thunk generator's verdict (DUI2011/5011); what THIS layer owes downstream is every
            // name the expression mentions: calls as functions, bare identifiers as variables.
            this.advance();
            this.scanBindingExpression(first.start, pathEnd);
            return {
                path, pathStart: first.start, start: first.start,
                end: this.tokens[Math.max(0, this.index - 1)].end,
                op: 'arrow', isSlot,
            };
        }
        if (this.check('equals')) {
            this.advance();
            const valueStart = this.current().start;
            this.parseValueUntilBoundary();
            const valueEnd = Math.max(valueStart, this.tokens[Math.max(0, this.index - 1)].end);
            return {
                path, pathStart: first.start, start: first.start, end: valueEnd,
                op: 'equals', isSlot, valueStart, valueEnd,
            };
        }
        this.skipToStatementBoundary();
        return undefined;
    }

    /**
     * Walks a binding expression to the statement boundary, collecting references and judging
     * nothing: `Count() - Base()` yields two function refs, `Prefix` a variable ref, `Item.Title`
     * one dotted variable ref (how a binding says something about an `each` item). Parens are what
     * make a call, exactly as in the compiler's grammar, and nested calls inside argument lists
     * are found because this walk does not skip tuples. Operators, literals and mistakes alike are
     * stepped over -- DUI2011 is the compiler's to word.
     */
    private scanBindingExpression(pathStart: number, pathEnd: number): void {
        while (!this.atEnd() && !this.check('separator') && !this.check('closeBrace')) {
            if (!this.check('identifier')) {
                this.advance();
                continue;
            }
            const name = this.current();
            if (name.text === 'true' || name.text === 'false') {
                this.advance();
                continue;
            }
            this.advance();
            if (this.check('openParen')) {
                this.result.bindings.push({
                    isEvent: false, pathStart, pathEnd, name: name.text, nameStart: name.start,
                });
                continue; // the '(' and its arguments keep walking through this same loop
            }
            let full = name.text;
            while (this.check('dot') && this.peek(1).kind === 'identifier') {
                this.advance();
                full += '.' + this.current().text;
                this.advance();
            }
            this.result.bindings.push({
                isEvent: false, pathStart, pathEnd, name: full, nameStart: name.start, isVariable: true,
            });
        }
    }

    /** Consumes a value up to the statement boundary, pairing tuples and reporting DUI2003. */
    private parseValueUntilBoundary(): void {
        while (!this.atEnd() && !this.check('separator') && !this.check('closeBrace')) {
            if (this.check('openParen')) {
                this.skipTuple();
                continue;
            }
            this.advance();
        }
    }

    private skipTuple(): void {
        const open = this.current();
        this.advance();
        let depth = 1;
        while (!this.atEnd()) {
            if (this.check('openParen')) {
                depth++;
            } else if (this.check('closeParen')) {
                depth--;
                this.advance();
                if (depth === 0) {
                    return;
                }
                continue;
            } else if (this.check('closeBrace')) {
                // A '}' ends the hunt as surely as the end of the file does.
                break;
            }
            this.advance();
        }
        this.error(2003, "this '(' never reaches its ')'", open);
    }

    private parseComponent(node: StructNode): void {
        this.advance(); // '+'
        if (!this.check('identifier') && !this.check('assetPath')) {
            this.skipToStatementBoundary();
            return;
        }
        const nameToken = this.current();
        const component: StructComponent = {
            name: nameToken.text, line: nameToken.line, column: nameToken.column, start: nameToken.start,
        };
        this.advance();
        this.skipSeparators();

        if (this.check('openBrace')) {
            const open = this.current();
            this.advance();
            component.bodyStart = this.current().start;
            this.parsePropertyOnlyBlock(open);
            component.bodyEnd = this.tokens[Math.max(0, this.index - 1)].start;
            this.result.scopes.push({
                kind: 'component', name: component.name,
                bodyStart: component.bodyStart, bodyEnd: component.bodyEnd,
            });
        }
        node.components.push(component);
    }

    private parsePropertyOnlyBlock(open: Token, out?: PropertyStmt[]): void {
        if (this.isTooDeep(open)) {
            this.skipBalancedBlockBody();
            return;
        }
        this.nestingDepth++;
        try {
            for (;;) {
                this.skipSeparators();
                if (this.check('closeBrace')) {
                    this.advance();
                    return;
                }
                if (this.atEnd()) {
                    this.error(2002, "this '{' never reaches its '}'", open);
                    return;
                }
                const before = this.index;
                if (this.looksLikeProperty()) {
                    const stmt = this.parseProperty();
                    if (stmt && out) {
                        out.push(stmt);
                    }
                } else {
                    this.skipToStatementBoundary();
                }
                if (this.index === before) {
                    this.advance();
                }
            }
        } finally {
            this.nestingDepth--;
        }
    }

    private parseNamedSlot(node: StructNode): void {
        const keyword = this.current();
        this.advance(); // 'slot'

        const nameToken = this.current();
        const slot: StructNode = {
            kind: 'namedSlot', tag: 'slot', id: nameToken.text,
            idLine: nameToken.line, idColumn: nameToken.column, idStart: nameToken.start,
            line: keyword.line, column: keyword.column, start: keyword.start,
            components: [], children: [], properties: [],
        };
        if (RESERVED_WORDS.has(slot.id)) {
            this.error(3002, `'${slot.id}' is a keyword and cannot name a slot`, nameToken);
        }
        this.advance();

        // A named slot declares a hole and takes no block; a block that is there anyway is the
        // compiler's refusal to word, and stepped over here.
        this.skipSeparators();
        if (this.check('openBrace')) {
            const open = this.current();
            this.advance();
            this.parseNodeBody({ ...slot, children: [], components: [] }, open);
        }
        node.children.push(slot);
    }

    private parseLoop(node: StructNode): void {
        const keyword = this.current();
        this.advance(); // 'for' | 'each'

        const variableToken = this.current();
        const loop: StructNode = {
            kind: 'loop', tag: keyword.text, id: variableToken.text,
            idLine: variableToken.line, idColumn: variableToken.column, idStart: variableToken.start,
            line: keyword.line, column: keyword.column, start: keyword.start,
            components: [], children: [], properties: [],
        };
        this.advance();

        // A warning, deliberately: nothing in today's grammar can reference a loop variable, so a
        // shadowed one provably cannot change the tree. Case SENSITIVE, unlike names -- this
        // follows the compiler exactly.
        if (this.loopVariables.includes(loop.id)) {
            this.warning(3008, `'${loop.id}' is already the variable of an enclosing loop`, variableToken);
        }

        if (this.checkKeyword('in')) {
            this.advance();
            if (this.check('identifier')) {
                this.advance();
                if (this.check('openParen')) {
                    this.skipTuple();
                }
            }
        } else {
            this.skipToStatementBoundary();
        }

        this.skipSeparators();
        if (this.check('openBrace')) {
            const open = this.current();
            this.advance();
            loop.bodyStart = this.current().start;
            this.loopVariables.push(loop.id);
            this.parseNodeBody(loop, open);
            this.loopVariables.pop();
            loop.bodyEnd = this.tokens[Math.max(0, this.index - 1)].start;
            this.result.scopes.push({
                kind: 'loop', name: loop.tag, id: loop.id, bodyStart: loop.bodyStart, bodyEnd: loop.bodyEnd,
            });
        }
        node.children.push(loop);
    }

    // ---- the tree-wide name checks -------------------------------------------------------------

    private checkNamesAcrossTheTree(): void {
        // Case insensitive on purpose: every id becomes an FName member variable downstream, and
        // FName would collide OkBtn with okbtn anyway. Catching it here names both lines.
        const firstSeen = new Map<string, StructNode>();
        const wasSeen = new Map<string, StructNode>();
        const allNodes: StructNode[] = [];

        const visit = (node: StructNode): void => {
            allNodes.push(node);
            if (node.kind !== 'loop' && node.id.length > 0) {
                const key = foldName(node.id);
                const first = firstSeen.get(key);
                if (first) {
                    // Never uniquified: the id is the node's identity, and inventing OkBtn_1 would
                    // silently repoint whichever of the two the author's bindings meant.
                    this.error(3001, `'${node.id}' is already the id of the node on line ${first.line}`,
                        this.idAnchor(node));
                } else {
                    firstSeen.set(key, node);
                }
            }
            for (const child of node.children) {
                visit(child);
            }
        };
        for (const root of this.result.roots) {
            visit(root);
        }

        for (const node of allNodes) {
            if (node.styleName && !this.findStyle(node.styleName)) {
                this.error(3004, `'${node.styleName}' names a style this file does not declare`, {
                    line: node.styleNameLine ?? node.line, column: node.styleNameColumn ?? node.column,
                    start: node.styleNameStart ?? node.start,
                    end: (node.styleNameStart ?? node.start) + node.styleName.length,
                });
            }

            if (!node.wasId) {
                continue;
            }
            // DUI3010/3011/3012, and the compiler DOES raise them now (as errors, one per node,
            // failing the compile and refusing the whole file's migration). Kept as warnings here
            // anyway: this mirror answers on every keystroke and the compiler answers on compile,
            // its message names both nodes and both fixes, and both now reach the Problems panel.
            // A yellow hint ahead of a red verdict reads correctly; two reds for one fact do not.
            const anchor = this.idAnchor(node);
            if (foldName(node.wasId) === foldName(node.id)) {
                this.warning(3012, `'(was: ${node.wasId})' names the node itself -- nothing to migrate`, anchor);
            }
            const live = firstSeen.get(foldName(node.wasId));
            if (live && live !== node) {
                this.warning(3010,
                    `'(was: ${node.wasId})' but '${live.id}' is still a live id in this file (line ${live.line})`,
                    anchor);
            }
            const earlier = wasSeen.get(foldName(node.wasId));
            if (earlier) {
                this.warning(3011,
                    `two nodes both claim '(was: ${node.wasId})' -- nothing can decide which one inherits its references`,
                    anchor);
            } else {
                wasSeen.set(foldName(node.wasId), node);
            }
        }

        this.checkStyleChains(allNodes);
    }

    /**
     * Style inheritance, judged the way the builder judges it: a chain is only walked from a node
     * that wears it, a cycle is refused at the wearing node, and an unknown base is reported at
     * the style that names it. An unworn style with a missing base gets a warning -- the compiler
     * says nothing there today, and a warning cannot claim more than it knows.
     */
    private checkStyleChains(nodes: StructNode[]): void {
        const wornStyles = new Set<string>();
        for (const node of nodes) {
            if (!node.styleName) {
                continue;
            }
            const style = this.findStyle(node.styleName);
            if (!style) {
                continue;
            }
            wornStyles.add(foldName(style.name));

            const visited = new Set<StyleDecl>();
            for (let link: StyleDecl | undefined = style; link;) {
                if (visited.has(link)) {
                    this.error(3015,
                        `style '${style.name}' inherits itself through its bases, so nothing was applied`,
                        this.idAnchor(node));
                    break;
                }
                visited.add(link);
                if (!link.base) {
                    break;
                }
                const base: StyleDecl | undefined = this.findStyle(link.base);
                if (!base) {
                    this.reportUnknownBase(link, 'error');
                    break;
                }
                wornStyles.add(foldName(base.name));
                link = base;
            }
        }

        for (const style of this.result.styles) {
            if (style.base && !this.findStyle(style.base) && !wornStyles.has(foldName(style.name))) {
                this.reportUnknownBase(style, 'warning');
            }
        }
    }

    private readonly unknownBaseReported = new Set<StyleDecl>();

    private reportUnknownBase(style: StyleDecl, severity: 'error' | 'warning'): void {
        if (this.unknownBaseReported.has(style)) {
            return;
        }
        this.unknownBaseReported.add(style);
        const at = {
            line: style.baseLine ?? style.line, column: style.baseColumn ?? style.column,
            start: style.baseStart ?? style.nameStart,
            end: (style.baseStart ?? style.nameStart) + (style.base?.length ?? 0),
        };
        const message = `style '${style.name}' inherits '${style.base}', which this file does not declare`;
        if (severity === 'error') {
            this.error(3004, message, at);
        } else {
            this.warning(3004, message, at);
        }
    }

    private findStyle(name: string): StyleDecl | undefined {
        return this.result.styles.find((style) => foldName(style.name) === foldName(name));
    }

    private idAnchor(node: StructNode): { line: number; column: number; start: number; end: number } {
        if (node.idStart !== undefined) {
            return {
                line: node.idLine!, column: node.idColumn!,
                start: node.idStart, end: node.idStart + node.id.length,
            };
        }
        return { line: node.line, column: node.column, start: node.start, end: node.start + node.tag.length };
    }
}

function ellipsize(text: string, maxLength = 16): string {
    return text.length <= maxLength ? text : text.slice(0, maxLength) + '...';
}

/** The innermost scope containing an offset, or undefined at the top level. */
export function scopeAt(structure: StructureResult, offset: number): Scope | undefined {
    let best: Scope | undefined;
    for (const scope of structure.scopes) {
        if (offset >= scope.bodyStart && offset <= scope.bodyEnd) {
            if (!best || scope.bodyStart >= best.bodyStart) {
                best = scope;
            }
        }
    }
    return best;
}

/**
 * Builds the structural model for one file. Runs the scanner itself so callers hold one result
 * carrying both layers' diagnostics (lexical first, as the compiler emits them) and the token
 * stream, for consumers that need token-level facts -- colours, brace balance, semantic tokens.
 */
export function buildStructure(text: string): StructureResult
    & { lexical: DuiDiagnostic[]; tokens: Token[]; comments: CommentSpan[] } {
    const scanned = scan(text);
    const parser = new Parser(scanned.tokens);
    parser.parseFile();

    // Resource values and @references are read off the source, not re-printed from tokens.
    for (const resource of parser.result.resources) {
        resource.valueText = text.slice(resource.valueStart, resource.valueEnd).trim();
    }
    collectResourceRefs(scanned.tokens, parser.result);

    return { ...parser.result, lexical: scanned.diagnostics, tokens: scanned.tokens, comments: scanned.comments };
}

/** Every `@Name` in value position: an '@' immediately followed by an identifier that is not a directive. */
function collectResourceRefs(tokens: Token[], result: StructureResult): void {
    for (let index = 0; index + 1 < tokens.length; index++) {
        const at = tokens[index];
        const name = tokens[index + 1];
        if (at.kind === 'at' && name.kind === 'identifier' && at.end === name.start
            && name.text !== 'slot' && name.text !== 'key') {
            result.resourceRefs.push({ name: name.text, line: at.line, column: at.column, start: at.start });
        }
    }
}
