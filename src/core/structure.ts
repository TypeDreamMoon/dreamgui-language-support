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
 * case sensitively. Three codes (DUI3010/3011/3012) are defined in the compiler's code table but
 * have no raise site there yet; they are reported here as warnings on the code table's own
 * reasoning, never as errors.
 *
 * No vscode import here: src/core/ is the seam a future LSP server or another IDE reuses.
 */

import { Token, TokenKind, LexicalDiagnostic, scan, RESERVED_WORDS } from './scanner';

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
    styleName?: string;
    styleNameStart?: number;
    styleNameLine?: number;
    styleNameColumn?: number;
    components: StructComponent[];
    children: StructNode[];
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
    scopes: Scope[];
    diagnostics: DuiDiagnostic[];
}

const foldName = (name: string): string => name.toLowerCase();

class Parser {
    private index = 0;
    private readonly loopVariables: string[] = [];

    readonly result: StructureResult = {
        roots: [], styles: [], resources: [], resourceRefs: [], scopes: [], diagnostics: [],
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

    // ---- styles and resources ------------------------------------------------------------------

    private parseStyleDeclaration(): void {
        const keyword = this.current();
        this.advance(); // 'style'

        const nameToken = this.current();
        const style: StyleDecl = {
            name: nameToken.text,
            line: keyword.line, column: keyword.column, nameStart: nameToken.start,
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
            this.parsePropertyOnlyBlock(open);
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

        const node: StructNode = {
            kind: 'node', tag: typeToken.text, id: '',
            line: typeToken.line, column: typeToken.column, start: typeToken.start,
            components: [], children: [],
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
        this.advance(); // '('
        if (this.checkKeyword('was') && this.peek(1).kind === 'colon'
            && this.peek(2).kind === 'identifier' && this.peek(3).kind === 'closeParen') {
            node.wasId = this.peek(2).text;
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

    private parseNodeBody(node: StructNode, open: Token): void {
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
                    this.parseProperty();
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
            this.parseProperty();
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
        return next === 'dot' || next === 'equals' || next === 'arrow' || next === 'eventArrow';
    }

    private parseProperty(): void {
        // The dotted path.
        this.advance();
        while (this.check('dot') && this.peek(1).kind === 'identifier') {
            this.advance();
            this.advance();
        }
        if (this.check('equals') || this.check('arrow') || this.check('eventArrow')) {
            this.advance();
            this.parseValueUntilBoundary();
            return;
        }
        this.skipToStatementBoundary();
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

    private parsePropertyOnlyBlock(open: Token): void {
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
                this.parseProperty();
            } else {
                this.skipToStatementBoundary();
            }
            if (this.index === before) {
                this.advance();
            }
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
            components: [], children: [],
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
            components: [], children: [],
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
            // DUI3010/3011/3012 exist in the compiler's code table with exactly these meanings but
            // have no raise site there yet -- warnings here, never errors, until the compiler
            // speaks for itself.
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
 * carrying both layers' diagnostics; lexical ones come first, as the compiler emits them.
 */
export function buildStructure(text: string): StructureResult & { lexical: DuiDiagnostic[] } {
    const scanned = scan(text);
    const parser = new Parser(scanned.tokens);
    parser.parseFile();

    // Resource values and @references are read off the source, not re-printed from tokens.
    for (const resource of parser.result.resources) {
        resource.valueText = text.slice(resource.valueStart, resource.valueEnd).trim();
    }
    collectResourceRefs(scanned.tokens, parser.result);

    return { ...parser.result, lexical: scanned.diagnostics };
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
