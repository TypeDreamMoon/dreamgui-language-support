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
 * Forgiving in what it SAYS, faithful in what it CONSUMES. Where the compiler recovers from a bad
 * statement it walks to the statement's end with braces and parentheses balanced
 * (RecoverToStatementBoundary), and this layer walks exactly as far: a mirror that stopped earlier
 * would read the rest of a skipped block as statements of the block around it, and report the
 * follow-on mistakes the compiler never sees -- a second root, an id on a line that is not a node.
 * So the token consumption of every production here is the compiler's, even where the diagnostic
 * is withheld.
 *
 * Where this file does diagnose, the wording is the compiler's, verbatim, and the same rules
 * apply: names compare case insensitively (they all become FNames downstream), keywords compare
 * case sensitively. Three codes (DUI3010/3011/3012) are reported here as warnings and never as
 * errors: the compiler raises them as errors and its message is the fuller one, so these are the
 * live hint that arrives before a compile does -- see MAILBOX_SUPPRESSED in core/mailbox.ts, which
 * deliberately no longer filters them.
 *
 * Two things the compiler does to the tree are mirrored rather than performed:
 *
 *   - `if` / `else` blocks are LOWERED by the compiler into the enclosing node's children, each
 *     widget carrying a made `Shown <- …`. This layer keeps each arm as a 'branch' node in place, so
 *     the outline and the folding can show it, and every tree-wide rule (made ids, duplicate ids,
 *     unknown styles) reads the tree through `lowered()`, which sees what the compiler sees.
 *   - an unnamed node gets the id the compiler makes for it (NameAnonymousNodes), collision bumping
 *     included -- see StructNode.anonymous.
 *
 * No vscode import here: src/core/ is the seam a future LSP server or another IDE reuses.
 */

import {
    Token, TokenKind, LexicalDiagnostic, CommentSpan, scan, RESERVED_WORDS, NAME_SIZE, isIdentifierChar,
} from './scanner';

export type DuiDiagnostic = LexicalDiagnostic;

export interface StructNode {
    /**
     * 'branch' is one arm of an `if` / `else if` / `else`: its children are the arm's widgets. The compiler lowers the
     * arms into children of the enclosing node with a synthesized `Shown <- <condition>`; this layer keeps the arm so
     * the outline and the folding can show it.
     */
    kind: 'node' | 'namedSlot' | 'loop' | 'branch';
    /**
     * Node: the type as written -- a tag (`Text`), a container (`VerticalBox`), an alias (`Row`, `nier.Row`), `@Name`,
     * a registry tag (`Native.Button`) or an /asset path. NamedSlot: 'slot'. Loop: 'for' | 'each'.
     * Branch: 'if' | 'else if' | 'else'.
     */
    tag: string;
    /** Node id / slot name / loop variable. Empty when the header is missing one. */
    id: string;
    /** Position of the id token itself, when there is one -- rename and references anchor here. */
    idLine?: number;
    idColumn?: number;
    idStart?: number;
    /**
     * Position of the header: the type token (the '@' of `@Row`), the `slot` / `for` / `each` keyword, or the `if` /
     * `else` that opens a branch (an `else if` arm is located at its `else`, as the compiler locates it).
     */
    line: number;
    column: number;
    start: number;
    /** Node: one past the type as written -- `Native.Toggle` and `nier.Row` are three tokens joined into one name. */
    tagEnd?: number;
    wasId?: string;
    /** The whole '(was: X)' clause, opening paren to closing paren inclusive. */
    wasStart?: number;
    wasEnd?: number;
    /** `: Card`, or `: nier.Card` -- a namespaced style keeps its dots, and styleNameStart is its first word. */
    styleName?: string;
    styleNameStart?: number;
    styleNameLine?: number;
    styleNameColumn?: number;
    components: StructComponent[];
    /**
     * As written, branches included. A branch's own children are the arm's widgets; see `lowered` for the children
     * the compiler sees.
     */
    children: StructNode[];
    /** The node's own property statements, '@slot' ones included and flagged. */
    properties: PropertyStmt[];
    /** Offsets of the body: first token after '{', and the '}' itself. Absent when there is no block. */
    bodyStart?: number;
    bodyEnd?: number;
    /**
     * A node written without an id (`HorizontalBox { … }`, `Text : Caption { … }`). `id` then holds the id the
     * compiler makes for it -- `<id of the nearest enclosing node that has one, or Root>__<type with every character
     * an id cannot hold made _><count of earlier unnamed siblings of that sanitized type>` -- and idStart / idLine /
     * idColumn are absent, because no token spells it. Loops and slot fills are see-through for the "enclosing node".
     *
     * Made exactly as AssignAnonymousId makes it: the count is per enclosing node and per type spelling (compared
     * without regard to case), `@Row` counts as `_Row` and `nier.Row` as `nier_Row`, the widgets of an `if` count
     * where the compiler lowers them -- among the enclosing node's own children -- and a made id that meets one the
     * author wrote anywhere in the file is bumped with `_1`, `_2`, ... Only the first root is named the compiler's
     * way; a second root (already DUI2006) gets ids of the same shape, made apart from the first's.
     */
    anonymous?: boolean;
    /** namedSlot: `slot Rows default`. */
    defaultSlot?: boolean;
    /**
     * namedSlot: a host filling a component's slot (`slot Detail { Text Note { } }` inside an instance) rather than
     * a component declaring one. Decided as the compiler's parser decides it: a slot block holding child nodes is a
     * fill; one holding properties, components, `default` or a style is a declaration.
     */
    fillsSlot?: boolean;
    /** branch: the condition as written (absent for `else`), as offsets into the source. */
    condition?: string;
    conditionStart?: number;
    conditionEnd?: number;
    /** loop: the source after `in` -- `GetItems` for `GetItems()`, `Items` for a variable -- and which of the two. */
    loopSource?: string;
    loopSourceStart?: number;
    loopSourceIsFunction?: boolean;
    /**
     * loop: a header the compiler refuses (DUI2010) -- `each Track in ` while it is being typed. The compiler makes no
     * loop and steps over its block; this layer keeps the node, its body read, so the editor can answer inside it, and
     * leaves it out of `loweredChildren` and of every rule about the compiler's tree.
     */
    refused?: boolean;
}

export interface StructComponent {
    /** As written: 'Overlay' or '/Script/Module.Class'. */
    name: string;
    line: number;
    column: number;
    /** Offset of the name (not the '+'). */
    start: number;
    bodyStart?: number;
    bodyEnd?: number;
    /** The block's `Name = Value` lines. */
    properties?: PropertyStmt[];
}

export interface StyleDecl {
    name: string;
    /** `style Danger : Card`, or `: nier.Card` -- dots kept, baseStart at the first word. */
    base?: string;
    line: number;
    column: number;
    nameStart: number;
    baseStart?: number;
    baseLine?: number;
    baseColumn?: number;
    bodyStart?: number;
    bodyEnd?: number;
    /** The style's own lines, its `@slot` lines included and flagged. */
    properties: PropertyStmt[];
    /** `+ Component { … }` blocks inside the style. */
    components: StructComponent[];
}

/**
 * One `props { … }` entry: `Text Label`, `Number ValueIndex = 0`, `Enum /Script/M.EKind Kind = Cycle`.
 *
 * line / column are the NAME's, like every other declaration site this layer records (a resource's, a style's); the
 * compiler locates a duplicate at the type, and so does DUI3019 here.
 */
export interface PropDecl {
    /** The type keyword as written: Text, String, Number, Integer, Bool, Color, Vector2, Asset, Class, Enum. */
    type: string;
    /** For an Enum prop, the enum's path. */
    enumPath?: string;
    name: string;
    /** The default value as written, when there is one. */
    defaultText?: string;
    line: number;
    column: number;
    nameStart: number;
}

/** One parameter of an `events { … }` entry: `Number Index`. */
export interface EventParamDecl {
    type: string;
    enumPath?: string;
    name: string;
}

/** One `events { … }` entry: `Picked(Number Index)`, `Closed`. */
export interface EventDecl {
    name: string;
    params: EventParamDecl[];
    line: number;
    column: number;
    nameStart: number;
}

/**
 * `timeline Pulse { … }` or `timeline Celebrate external`.
 *
 * Recorded, never judged: the block's contents resolve against the TREE (a node path, an Interp
 * property, a curve name out of the engine's enum), and this layer sees one file's characters. What
 * it has to do is recognise the shape so nothing inside a valid block is painted as a mistake --
 * which is the extension's one rule, that it may report less than the compiler but never differently.
 */
export interface TimelineDecl {
    name: string;
    external: boolean;
    line: number;
    column: number;
    nameStart: number;
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

/**
 * One `@Name` reference: in a value, inside a binding expression or a condition, in a timeline key, or as a node
 * type (`@Row Row1 { }`). Not `@slot`, `@key(…)` or the `@fill` shorthand, which are annotations; not an `@` inside a
 * tuple, which the compiler keeps as raw text and never resolves.
 */
export interface ResourceRef {
    /** As written after the '@', dots kept: `Accent`, `nier.Ink`. */
    name: string;
    line: number;
    column: number;
    /** Offset of the '@'. */
    start: number;
    /** One past the name's last character. */
    end?: number;
    /** `@Row Row1 { }`: the resource names a node's class rather than a value. */
    nodeType?: boolean;
}

/**
 * A name qualified by a namespace -- `: nier.Label`, `style X : nier.Base`, `@nier.Ink`, `@nier.Row` -- which the
 * compiler holds to DUI3021 once the whole file is read (CheckNamespaceReferences). A node TYPE `nier.Row` is not
 * one: a scoped type may be a registry tag (`Native.Button`), and the builder is what tells the two apart.
 */
export interface NamespaceRef {
    /** The text before the first dot. */
    prefix: string;
    /** The whole qualified name, without the '@'. */
    name: string;
    kind: 'style' | 'resource';
    line: number;
    column: number;
    /** The '@' of a resource reference, the first word of a style name. */
    start: number;
    end: number;
    /** DUI3021 was already raised for it here, from this file alone. */
    reported?: boolean;
}

/** One property statement, as spans into the source. */
export interface PropertyStmt {
    /** The dotted path as written. For the `@fill` shorthand, 'SizeRule' -- what it stands for. */
    path: string;
    /** The path's first token; for the `@fill` shorthand, its '@'. */
    pathStart: number;
    /**
     * Whole statement: first path token to the end of the value. An `@slot Name = …` line starts at its path, with
     * the directive before it; the `@fill` shorthand spans `@fill` and its weight.
     */
    start: number;
    end: number;
    op: 'equals' | 'arrow' | 'eventArrow' | 'twoWayArrow';
    /**
     * True when the statement was led by '@slot', sits inside an `@slot { … }` block (one statement per assignment
     * there), or is the `@fill` shorthand.
     */
    isSlot: boolean;
    /**
     * `@fill` / `@fill 2`: the shorthand for `@slot SizeRule = Fill` (and `@slot FillWeight = N`). Its op is 'equals'
     * and it carries no value span: no value is spelt, and an edit that treated the weight as one would rewrite the
     * shorthand into something that does not parse.
     */
    shorthand?: 'fill';
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
    /** The left-hand path, as offsets. For a condition's names, the `if` / `else` keyword that leads it. */
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
    /**
     * `Event -> emit Picked(Index)`: `name` is an event this file's `events` block declares, not a handler on the
     * class. The arguments' calls and variables are separate BindingRefs, as an expression's are.
     */
    isEmit?: boolean;
    /**
     * A name in an `if` / `else if` condition. The compiler binds it as `Shown <- condition` on every widget of the
     * branch, so it is a binding like any other -- of `Shown`, which no line spells.
     */
    isCondition?: boolean;
}

/**
 * One `use` directive: `use "Lib.dui"`, `use "Row.dui" as Row`, `use /Game/UI/WBP_Row as Row`, `use "Lib.dui" as nier`.
 * The path is as written; resolution belongs to the compiler (and, for this extension, WorkspaceIndex). Whether
 * `as X` names a component or a namespace depends on whether the target file has a root, which one file cannot see.
 */
export interface UseDirective {
    path: string;
    /** 'file' for a quoted .dui path (the default when absent), 'class' for an unquoted /Game or /Script path. */
    target?: 'file' | 'class';
    /** The name after `as`, and where it is. */
    alias?: string;
    aliasStart?: number;
    aliasLine?: number;
    aliasColumn?: number;
    line: number;
    column: number;
    /** Offset of the 'use' keyword. */
    start: number;
    /** The quoted string, quotes included -- what a document link underlines. For a class path, the path. */
    pathStart: number;
    pathEnd: number;
    /**
     * The compiler refuses the line and imports nothing through it: an `as` with no usable name (DUI2015), a name
     * given twice (DUI3017), a class path without `as`. Kept so navigation can still follow the path; every rule
     * about what the file can SEE skips it.
     */
    refused?: boolean;
}

/** A block something can stand inside, for answering "what scope is this offset in". */
export interface Scope {
    kind: 'node' | 'namedSlot' | 'component' | 'style' | 'resources' | 'loop' | 'branch' | 'props' | 'events' | 'slotLines';
    /** Node type / component name / style name / loop keyword / 'slot' / 'if' | 'else if' | 'else' / '@slot'. */
    name: string;
    /** Node id, when the scope is a node (the made one for an unnamed node); slot name; loop variable. */
    id?: string;
    bodyStart: number;
    bodyEnd: number;
}

export interface StructureResult {
    classPath?: { path: string; line: number; column: number; start: number; end: number };
    /** Top-level nodes. A well-formed file has exactly one. */
    roots: StructNode[];
    styles: StyleDecl[];
    /** `timeline` blocks, in declaration order. See TimelineDecl for why the bodies are not parsed. */
    timelines: TimelineDecl[];
    resources: ResourceDecl[];
    /** In source order. */
    resourceRefs: ResourceRef[];
    bindings: BindingRef[];
    imports: UseDirective[];
    /** `props { … }` entries, in declaration order. */
    props: PropDecl[];
    /** `events { … }` entries, in declaration order. */
    events: EventDecl[];
    scopes: Scope[];
    diagnostics: DuiDiagnostic[];
    /** Every namespace-qualified style and resource name, for the index-aware DUI3021 / DUI3004 / DUI4007. */
    namespaceRefs?: NamespaceRef[];
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

/** 0 means "not a binary operator". GetBinaryPrecedence, mirrored: higher binds tighter. */
function binaryPrecedence(kind: TokenKind): number {
    switch (kind) {
        case 'pipePipe': return 1;
        case 'ampAmp': return 2;
        case 'equalEqual': case 'bangEqual': return 3;
        case 'less': case 'lessEqual': case 'greater': case 'greaterEqual': return 4;
        case 'plus': case 'minus': return 5;
        case 'star': case 'percent': return 6;
        default: return 0;
    }
}

/** CanBeginCondition: what may follow `if` for it to lead a conditional -- or the '{' of one whose condition is missing. */
function canBeginCondition(kind: TokenKind): boolean {
    return kind === 'identifier' || kind === 'openParen' || kind === 'bang' || kind === 'minus'
        || kind === 'number' || kind === 'string' || kind === 'at' || kind === 'openBrace';
}

/** Where a diagnostic sits: a token, or a span with its line and column. */
type Anchor = { line: number; column: number; start: number; end: number };

/** What every name a binding expression mentions is recorded against. */
interface RefContext {
    pathStart: number;
    pathEnd: number;
    isCondition?: boolean;
}

class Parser {
    private index = 0;
    private readonly loopVariables: string[] = [];
    /** How many nested block bodies the cursor is inside. One counter: the stack is one stack. */
    private nestingDepth = 0;
    /** DUI2013 is said once per file: a file that reaches the limit reaches it at every level. */
    private reportedNestingLimit = false;
    /**
     * Parenthesised sub-expressions the cursor is inside. Not reported -- the compiler spends its DUI2013 budget on
     * them and this layer does not, which is why DUI2013 stays out of MAILBOX_SUPPRESSED -- but bounded, because a
     * file of ten thousand '(' would otherwise take the extension host's stack with it.
     */
    private expressionDepth = 0;

    /**
     * Nodes the compiler leaves without an Id although this layer shows one: `Text 2ndPanel` (DUI3002), whose digit-led
     * word the outline still wants. For every rule about ids -- made ones, duplicates -- they have none.
     */
    private readonly idless = new WeakSet<StructNode>();
    /**
     * The token the compiler LOCATES a statement at, where that is not where this layer's span starts: the '@' of
     * `@slot Padding = …`, the '+' of a component. Diagnostics about the statement are reported there.
     */
    private readonly anchors = new WeakMap<object, Token>();
    /** `Shown <-> X`: the X, for the one message (DUI2018) that names it. */
    private readonly twoWayVariables = new WeakMap<PropertyStmt, string>();
    /** `@fill 2` rather than `@fill`: the compiler makes a FillWeight line too, and a branch reports both. */
    private readonly weightedFills = new WeakSet<PropertyStmt>();
    /** `use … as` names given so far, folded, with the line each was given on (DUI3017). */
    private readonly ownAsNames = new Map<string, number>();
    /** The first `slot … default` of the file, for the one DUI3022 names when there is a second. */
    private firstDefaultSlot: { name: string; line: number } | undefined;

    readonly result: StructureResult = {
        roots: [], styles: [], timelines: [], resources: [], resourceRefs: [], bindings: [], imports: [], props: [],
        events: [], scopes: [], diagnostics: [], namespaceRefs: [],
    };

    constructor(private readonly tokens: Token[], private readonly text: string) {}

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

    /** One past the last token consumed. */
    private previousEnd(): number {
        return this.tokens[Math.max(0, this.index - 1)].end;
    }

    /** Where the '}' of a body that was just consumed starts -- the convention every bodyEnd here follows. */
    private previousStart(): number {
        return this.tokens[Math.max(0, this.index - 1)].start;
    }

    private skipSeparators(): void {
        while (this.check('separator')) {
            this.advance();
        }
    }

    /** True at the end of a line, at a ';', at a '}' or at the end of the file: where a one-line declaration may stop. */
    private atStatementEnd(): boolean {
        return this.check('separator') || this.check('closeBrace') || this.atEnd();
    }

    /**
     * RecoverToStatementBoundary: to the end of the statement that went wrong, braces and parentheses balanced,
     * leaving its terminator for the caller. Balanced is the point -- a mistake in a header must not throw the block
     * after it at the enclosing loop, which would read its lines as statements of the wrong block.
     */
    private recover(): void {
        let depth = 0;
        while (!this.atEnd()) {
            const kind = this.current().kind;
            if (depth === 0 && (kind === 'separator' || kind === 'closeBrace')) {
                return;
            }
            if (kind === 'openBrace' || kind === 'openParen') {
                depth++;
            } else if (kind === 'closeBrace' || kind === 'closeParen') {
                depth = Math.max(0, depth - 1);
            }
            this.advance();
        }
    }

    /** SkipBalancedBlock: the cursor on a '{', past its '}'. */
    private skipBalancedBlock(): void {
        if (!this.check('openBrace')) {
            return;
        }
        let depth = 0;
        do {
            if (this.check('openBrace')) {
                depth++;
            } else if (this.check('closeBrace')) {
                depth--;
            }
            this.advance();
        } while (depth > 0 && !this.atEnd());
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

    /** Past the next ')', but never out of the statement -- a missing one must not eat the block. */
    private skipPastCloseParen(): void {
        while (!this.atEnd() && !this.check('separator') && !this.check('closeBrace')) {
            const wasClose = this.check('closeParen');
            this.advance();
            if (wasClose) {
                return;
            }
        }
    }

    /** DescribeCurrent: what the reader sees at the cursor, in the words they wrote, so a message can quote it. */
    private describeCurrent(): string {
        const token = this.current();
        switch (token.kind) {
            case 'end': return 'the end of the file';
            case 'separator': return 'the end of the line';
            case 'string': return `"${ellipsize(token.text)}"`;
            case 'hexColor': return `#${ellipsize(token.text)}`;
            default: return ellipsize(token.text);
        }
    }

    private error(code: number, message: string, at: Anchor): void {
        this.result.diagnostics.push({
            code, severity: 'error', message,
            line: at.line, column: at.column, start: at.start, end: at.end,
        });
    }

    private warning(code: number, message: string, at: Anchor): void {
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
            } else if (this.checkKeyword('resources')) {
                this.parseResourcesBlock();
            } else if (this.checkKeyword('props') && this.peek(1).kind === 'openBrace') {
                // Only with its brace: `props` with anything else after it is whatever it was before the block
                // existed, so a file that happened to use the word keeps meaning what it meant.
                this.parsePropsBlock();
            } else if (this.checkKeyword('events') && this.peek(1).kind === 'openBrace') {
                this.parseEventsBlock();
            } else if (this.checkKeyword('if') || this.checkKeyword('else')) {
                // No lookahead here, exactly as the compiler: a condition chooses between children, and the top of a
                // file has no parent to give them to.
                const keyword = this.current();
                this.error(2018, `'${keyword.text}' chooses between the children of a node, so it belongs inside one`, keyword);
                this.recover();
            } else if (this.checkKeyword('style')) {
                this.parseStyleDeclaration();
            } else if (this.checkKeyword('timeline')) {
                this.parseTimelineDeclaration();
            } else if (this.checkKeyword('slot') || this.checkKeyword('for') || this.checkKeyword('each')) {
                // The compiler's DUI2001 to word ("belongs inside a node"); stepped over whole, block included, rather
                // than read as a node of type `for` whose block then lands at the top level.
                this.recover();
            } else if (this.looksLikeProperty()) {
                // A property at the top level is the compiler's refusal to word; stepping over it
                // beats mistaking `A = 1` for a node header with no id.
                this.recover();
            } else if (this.check('identifier') || this.check('assetPath')
                || (this.check('at') && this.peek(1).kind === 'identifier')) {
                const node = this.parseNode();
                if (node) {
                    if (this.result.roots.length > 0) {
                        // The first one wins and the rest are reported where they stand. An unnamed second root has
                        // no id yet -- the compiler names its type, as DescribeNode does.
                        this.error(2006,
                            `a .dui holds exactly one root node, and '${node.id || node.tag}' is a second one`,
                            this.idAnchor(node));
                    }
                    this.result.roots.push(node); // kept for the outline; the diagnostic is the verdict
                }
            } else {
                // Something the grammar does not start a statement with. The compiler words this
                // refusal (DUI2001); this layer steps over it.
                this.recover();
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

        // The compiler's order: the ids first (a made one has to exist before anything can ask whether it collides),
        // then the namespaces, then the names.
        this.result.roots.forEach((root, position) => this.nameAnonymousNodes(root, position === 0));
        this.checkNamespaceReferences();
        this.checkNamesAcrossTheTree();
        this.result.resourceRefs.sort((a, b) => a.start - b.start);
    }

    private parseClassDeclaration(): void {
        this.advance(); // 'class'
        if (!this.check('assetPath')) {
            this.recover();
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
     * `use "Styles/Common.dui"`, `use "Row.dui" as Row`, `use /Game/UI/WBP_Row as Row`, `use "Lib.dui" as nier` --
     * recorded for navigation and for the index, judged only where one line settles it: the name after `as`
     * (DUI2015) and the same name given twice (DUI3017), both raised by the compiler before it reads any file.
     * Whether the path resolves, whether the file parses, whether the chain cycles all need OTHER files, and those
     * verdicts (DUI2012) are the compiler's to word. A `use` of neither a string nor a path is likewise its refusal.
     */
    private parseUseDirective(): void {
        const keyword = this.current();
        this.advance(); // 'use'
        if (this.check('assetPath')) {
            this.parseUseClassPath(keyword);
            return;
        }
        if (!this.check('string')) {
            this.recover();
            return;
        }
        const pathToken = this.current();
        const directive: UseDirective = {
            path: pathToken.text, target: 'file',
            line: keyword.line, column: keyword.column, start: keyword.start,
            pathStart: pathToken.start, pathEnd: pathToken.end,
        };
        this.advance();
        // `as` is a keyword here, after a path, and nowhere else.
        if (this.checkKeyword('as') && !this.parseUseAsName(pathToken.text, directive)) {
            directive.refused = true;
        }
        this.result.imports.push(directive);
    }

    /** `use /Game/UI/WBP_Row as Row` -- a class with no .dui behind it, named by its path. The cursor is on the path. */
    private parseUseClassPath(keyword: Token): void {
        const pathToken = this.current();
        const path = pathToken.text;
        const directive: UseDirective = {
            path, target: 'class',
            line: keyword.line, column: keyword.column, start: keyword.start,
            pathStart: pathToken.start, pathEnd: pathToken.end,
        };
        this.result.imports.push(directive);
        this.advance();

        if (path.length <= 1) {
            this.error(2015, "this 'use' has an empty path", pathToken);
            this.recover();
            directive.refused = true;
            return;
        }
        if (!this.checkKeyword('as')) {
            // Required here, unlike after a quoted path: a class path has nothing to offer but the class, and a class
            // nobody can write is a line that does nothing.
            this.error(2015, `'use ${path}' names a class, and needs a name to write it by, as in 'use ${path} as Row'`,
                { line: keyword.line, column: keyword.column, start: keyword.start, end: keyword.end });
            this.recover();
            directive.refused = true;
            return;
        }
        if (!this.parseUseAsName(path, directive)) {
            directive.refused = true;
        }
    }

    /** ParseUseAsName: the cursor on `as`. False, with the line consumed and the reason reported, when there is no usable name. */
    private parseUseAsName(what: string, directive: UseDirective): boolean {
        const asToken = this.current();
        this.advance(); // 'as'

        if (!this.check('identifier') || RESERVED_WORDS.has(this.current().text)) {
            // A keyword cannot be the name, for the reason it cannot be an id: `use "Row.dui" as for` would turn
            // every `for Row1 { }` after it into a loop header.
            this.error(2015, `'use ${what} as' needs a name after 'as', as in 'use ${what} as Row', found '${this.describeCurrent()}'`,
                this.check('identifier') ? this.current() : asToken);
            this.recover();
            return false;
        }
        const nameToken = this.current();
        directive.alias = nameToken.text;
        directive.aliasStart = nameToken.start;
        directive.aliasLine = nameToken.line;
        directive.aliasColumn = nameToken.column;
        this.advance();

        if (!this.check('separator') && !this.atEnd()) {
            // `as nier.Row` included: the name is the importer's one word.
            this.error(2015, `'${nameToken.text}' after 'as' is the whole name, and '${this.describeCurrent()}' cannot follow it`,
                this.current());
            this.recover();
            return false;
        }

        // One table for aliases and namespaces alike: a node type, a style clause and a resource reference spell them
        // the same way (`Row`, `nier.Row`), so a second `as Row` is the same collision whichever kind either one is.
        const first = this.ownAsNames.get(foldName(nameToken.text));
        if (first !== undefined) {
            this.error(3017, `'${nameToken.text}' is already the name the 'use' on line ${first} gave`, nameToken);
            return false;
        }
        this.ownAsNames.set(foldName(nameToken.text), nameToken.line);
        return true;
    }

    // ---- styles and resources ------------------------------------------------------------------

    private parseStyleDeclaration(): void {
        const keyword = this.current();
        this.advance(); // 'style'
        if (!this.check('identifier')) {
            this.recover();
            return;
        }

        const nameToken = this.current();
        const style: StyleDecl = {
            name: nameToken.text,
            line: keyword.line, column: keyword.column, nameStart: nameToken.start,
            properties: [], components: [],
        };
        this.advance();

        if (this.check('colon')) {
            // `style Danger : Button`, or `: nier.Button` -- a library's, the same way a node's clause takes one.
            this.advance();
            if (!this.check('identifier')) {
                this.recover();
                return;
            }
            const base = this.parseQualifiedName();
            style.base = base.name;
            style.baseStart = base.first.start;
            style.baseLine = base.first.line;
            style.baseColumn = base.first.column;
            this.noteNamespaceReference(base.name, 'style', base.first, base.end);
        }

        if (!this.check('openBrace')) {
            // Not declared at all, as in the compiler: a style is its block.
            this.recover();
            return;
        }
        const open = this.current();
        this.advance();
        style.bodyStart = this.current().start;
        this.parseStyleBody(style, open);
        style.bodyEnd = this.previousStart();
        this.result.scopes.push({ kind: 'style', name: style.name, bodyStart: style.bodyStart, bodyEnd: style.bodyEnd });

        const duplicate = this.result.styles.find((existing) => foldName(existing.name) === foldName(style.name));
        if (duplicate) {
            this.error(3005, `style '${style.name}' is declared twice`,
                { line: style.line, column: style.column, start: style.nameStart, end: style.nameStart + style.name.length });
            return; // dropped, so the first one keeps naming the style for everybody downstream
        }
        this.result.styles.push(style);
    }

    /**
     * A style's block: property lines, and also `+ Component { … }` and `@slot` lines (with their block and their
     * shorthands), so that a KIND of column is one name. Its own loop rather than the property-only one a behaviour's
     * block shares, as in the compiler: a `+` or a slot line in a behaviour's block is still a mistake there.
     */
    private parseStyleBody(style: StyleDecl, open: Token): void {
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
                if (this.check('plus')) {
                    this.parseComponent(style.components);
                } else if (this.isFillShorthand()) {
                    this.parseFillShorthand(style.properties);
                } else if (this.check('at') && this.peek(1).kind === 'identifier' && this.peek(1).text === 'slot') {
                    this.parseSlotLine(style.properties);
                } else if (this.looksLikeProperty()) {
                    const stmt = this.parseProperty(false);
                    if (stmt) {
                        style.properties.push(stmt);
                    }
                } else {
                    this.recover();
                }
                if (this.index === before) {
                    this.advance();
                }
            }
        } finally {
            this.nestingDepth--;
        }
    }

    /**
     * The timeline header, and the block skipped whole.
     *
     * Skipped rather than parsed line by line, deliberately: a track line's meaning is entirely
     * about the tree and the engine's reflection, so every judgement worth making about one is the
     * compiler's. Walking in to report shapes this layer cannot check would be the extension
     * inventing refusals, which is the one thing it is not allowed to do. The one thing taken out
     * of it is the `@Name` of a key's value, which is a resource reference like any other.
     */
    private parseTimelineDeclaration(): void {
        const keyword = this.current();
        this.advance(); // 'timeline'
        if (!this.check('identifier')) {
            this.recover();
            return;
        }

        const nameToken = this.current();
        const timeline: TimelineDecl = {
            name: nameToken.text, external: false,
            line: keyword.line, column: keyword.column, nameStart: nameToken.start,
        };
        this.advance();

        if (this.checkKeyword('external')) {
            timeline.external = true;
            this.advance();
            if (this.check('openBrace')) {
                this.skipBalancedBlock(); // DUI2014 in the compiler: an external timeline takes no block
            }
        } else {
            if (!this.check('openBrace')) {
                this.recover();
                return;
            }
            this.advance();
            timeline.bodyStart = this.current().start;
            let depth = 1;
            while (!this.atEnd()) {
                if (this.check('openBrace')) {
                    depth += 1;
                } else if (this.check('closeBrace')) {
                    depth -= 1;
                    if (depth === 0) {
                        break;
                    }
                } else if (this.check('at') && this.peek(1).kind === 'identifier') {
                    const at = this.current();
                    this.advance();
                    this.noteResourceRef(at, this.parseQualifiedName(), false);
                    continue;
                }
                this.advance();
            }
            timeline.bodyEnd = this.current().start;
            if (this.check('closeBrace')) {
                this.advance();
            }
        }

        const duplicate = this.result.timelines.find((existing) => foldName(existing.name) === foldName(timeline.name));
        if (duplicate) {
            this.error(3016, `timeline '${timeline.name}' is declared twice`,
                { line: timeline.line, column: timeline.column, start: timeline.nameStart, end: timeline.nameStart + timeline.name.length });
            return;
        }
        this.result.timelines.push(timeline);
    }

    private parseResourcesBlock(): void {
        this.advance(); // 'resources'
        if (!this.check('openBrace')) {
            this.recover();
            return;
        }
        this.advance();
        const bodyStart = this.current().start;

        // Entries accumulate across blocks; the block ends at its '}' or, unclosed, at the end of the file -- which the
        // compiler words as DUI2001, not this layer.
        while (!this.atEnd() && !this.check('closeBrace')) {
            if (this.check('separator')) {
                this.advance();
                continue;
            }
            const before = this.index;
            this.parseResourceEntry();
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

    private parseResourceEntry(): void {
        if (!this.check('identifier')) {
            this.recover();
            return;
        }
        const typeToken = this.current();
        this.advance();
        if (!this.check('identifier')) {
            this.recover();
            return;
        }
        const nameToken = this.current();
        this.advance();
        if (!this.check('equals')) {
            this.recover();
            return;
        }
        this.advance();
        const valueStart = this.current().start;
        if (!this.parseValue()) {
            this.recover();
            return;
        }
        const valueEnd = this.previousEnd();
        const entry: ResourceDecl = {
            type: typeToken.text, name: nameToken.text,
            valueText: this.text.slice(valueStart, valueEnd).trim(),
            line: nameToken.line, column: nameToken.column, nameStart: nameToken.start,
            valueStart, valueEnd,
        };
        const duplicate = this.result.resources.find((existing) => foldName(existing.name) === foldName(entry.name));
        if (duplicate) {
            this.error(3014, `resource '${entry.name}' is declared twice`, nameToken);
            return;
        }
        this.result.resources.push(entry);
    }

    // ---- props and events ----------------------------------------------------------------------

    /**
     * `Text Label`, `Number Gap = 4`, `Enum /Script/MyGame.ERowKind Kind = Cycle` -- the head shared by a `props`
     * line and an `events` parameter. The type is recorded as written and checked by the compiler; only `Enum` changes
     * the SHAPE of the line, by taking a path, so only `Enum` is known here.
     */
    private parseTypedName(code: number, whatItIs: string): { type: Token; enumPath?: Token; name: Token } | undefined {
        if (!this.check('identifier')) {
            this.error(code, `${whatItIs} is written 'Type Name', as in 'Text Label', found '${this.describeCurrent()}'`,
                this.current());
            return undefined;
        }
        const type = this.current();
        this.advance();

        let enumPath: Token | undefined;
        if (type.text === 'Enum') {
            if (!this.check('assetPath')) {
                this.error(code,
                    `'Enum' takes the enum's path before the name, as in 'Enum /Script/MyGame.ERowKind Kind', found '${this.describeCurrent()}'`,
                    this.current());
                return undefined;
            }
            enumPath = this.current();
            this.advance();
        }

        if (!this.check('identifier')) {
            this.error(code, `expected a name after '${type.text}', found '${this.describeCurrent()}'`, this.current());
            return undefined;
        }
        const name = this.current();
        this.advance();
        return { type, enumPath, name };
    }

    /** `props { Text Label … }` -- the cursor on `props`, a '{' after it. Blocks accumulate, as `resources` blocks do. */
    private parsePropsBlock(): void {
        this.advance(); // 'props'
        const open = this.current();
        this.advance(); // '{'
        const bodyStart = this.current().start;
        for (;;) {
            this.skipSeparators();
            if (this.check('closeBrace')) {
                this.result.scopes.push({ kind: 'props', name: 'props', bodyStart, bodyEnd: this.current().start });
                this.advance();
                return;
            }
            if (this.atEnd()) {
                this.error(2002, "this 'props' block never reaches its '}'", open);
                this.result.scopes.push({ kind: 'props', name: 'props', bodyStart, bodyEnd: this.current().start });
                return;
            }
            const before = this.index;
            this.parsePropLine();
            if (this.index === before) {
                this.advance();
            }
        }
    }

    private parsePropLine(): void {
        const typed = this.parseTypedName(2016, "a 'props' line");
        if (!typed) {
            this.recover();
            return;
        }
        const name = typed.name.text;

        let defaultText: string | undefined;
        if (this.check('equals')) {
            this.advance();
            if (this.atStatementEnd()) {
                // Said as the props line it is, rather than as a property missing its value: there is no property
                // here yet, only a declaration whose default was begun and not written.
                this.error(2016, `'${name} =' needs its default value, or no '=' at all`, this.current());
                this.recover();
                return;
            }
            const valueStart = this.current().start;
            if (!this.parseValue()) {
                this.recover(); // MissingPropertyValue, the compiler's to word
                return;
            }
            defaultText = this.text.slice(valueStart, this.previousEnd()).trim();
        }

        if (!this.atStatementEnd()) {
            this.error(2016, `a 'props' line declares one name, and '${this.describeCurrent()}' cannot follow '${name}'`,
                this.current());
            this.recover();
            return;
        }

        // FString's comparison: case insensitive, the first one kept.
        const first = this.result.props.find((existing) => foldName(existing.name) === foldName(name));
        if (first) {
            this.error(3019, `'${name}' is already declared on line ${first.line}`, typed.type);
            return;
        }
        this.result.props.push({
            type: typed.type.text, enumPath: typed.enumPath?.text, name, defaultText,
            line: typed.name.line, column: typed.name.column, nameStart: typed.name.start,
        });
    }

    /** `events { Picked(Number Index); Closed }` -- entries end at a line break or a ';'. */
    private parseEventsBlock(): void {
        this.advance(); // 'events'
        const open = this.current();
        this.advance(); // '{'
        const bodyStart = this.current().start;
        for (;;) {
            this.skipSeparators();
            if (this.check('closeBrace')) {
                this.result.scopes.push({ kind: 'events', name: 'events', bodyStart, bodyEnd: this.current().start });
                this.advance();
                return;
            }
            if (this.atEnd()) {
                this.error(2002, "this 'events' block never reaches its '}'", open);
                this.result.scopes.push({ kind: 'events', name: 'events', bodyStart, bodyEnd: this.current().start });
                return;
            }
            const before = this.index;
            this.parseEventEntry();
            if (this.index === before) {
                this.advance();
            }
        }
    }

    private parseEventEntry(): void {
        if (!this.check('identifier')) {
            this.error(2017, `an 'events' entry is 'Name' or 'Name(Type Param, ...)', found '${this.describeCurrent()}'`,
                this.current());
            this.recover();
            return;
        }
        const nameToken = this.current();
        const name = nameToken.text;
        this.advance();

        const params: EventParamDecl[] = [];
        if (this.check('openParen')) {
            this.advance();
            if (!this.check('closeParen')) {
                for (;;) {
                    const typed = this.parseTypedName(2017, 'an event parameter');
                    if (!typed) {
                        this.skipPastCloseParen();
                        this.recover();
                        return;
                    }
                    // Two pins of one name are a signature the Blueprint compiler refuses with no line to point at.
                    if (params.some((existing) => foldName(existing.name) === foldName(typed.name.text))) {
                        this.error(3020, `'${name}' already has a parameter '${typed.name.text}'`, typed.type);
                    } else {
                        params.push({ type: typed.type.text, enumPath: typed.enumPath?.text, name: typed.name.text });
                    }
                    if (!this.check('comma')) {
                        break;
                    }
                    this.advance();
                }
            }
            if (!this.check('closeParen')) {
                this.error(2017,
                    `the parameters of '${name}' are separated by ',' and closed by ')', found '${this.describeCurrent()}'`,
                    this.current());
                this.recover();
                return;
            }
            this.advance();
        }

        if (!this.atStatementEnd()) {
            this.error(2017, `expected the end of the line or a ';' after event '${name}', found '${this.describeCurrent()}'`,
                this.current());
            this.recover();
            return;
        }

        const first = this.result.events.find((existing) => foldName(existing.name) === foldName(name));
        if (first) {
            this.error(3020, `event '${name}' is already declared on line ${first.line}`, nameToken);
            return;
        }
        this.result.events.push({ name, params, line: nameToken.line, column: nameToken.column, nameStart: nameToken.start });
    }

    // ---- nodes ---------------------------------------------------------------------------------

    /**
     * `Type Id`, `Type { … }`, `Type : Style { … }`, `@Row Id { … }`, `nier.Row Id`. The cursor on the type (or on
     * the '@' of a resource type). The type is taken as written and never checked: whether `Image` is a tag needs
     * reflection, which is the builder's half.
     */
    private parseNode(): StructNode | undefined {
        const resourceType = this.check('at') && this.peek(1).kind === 'identifier';
        if (!resourceType && !this.check('identifier') && !this.check('assetPath')) {
            this.recover(); // "expected a node type or a property name", the compiler's DUI2001
            return undefined;
        }
        const typeToken = this.current();
        if (resourceType) {
            this.advance(); // '@'
        }
        const word = this.current();
        let tag = resourceType ? `@${word.text}` : word.text;
        let tagEnd = word.end;
        this.advance();

        // `Native.Toggle` -- a scoped tag -- or `nier.Row`, an alias a namespace brought in. The scanner hands it over
        // as identifier/dot/identifier because a dot elsewhere separates property path segments; the type position is
        // the one place they mean a single name, joined here exactly as the compiler joins them, as many dots as are
        // written (`nier.pal.Swatch`).
        while (this.check('dot') && this.peek(1).kind === 'identifier') {
            this.advance();
            tag = `${tag}.${this.current().text}`;
            tagEnd = this.current().end;
            this.advance();
        }

        const node: StructNode = {
            kind: 'node', tag, id: '',
            line: typeToken.line, column: typeToken.column, start: typeToken.start, tagEnd,
            components: [], children: [], properties: [],
        };
        const typeAnchor: Anchor = { line: typeToken.line, column: typeToken.column, start: typeToken.start, end: tagEnd };
        if (resourceType) {
            // `@Row` is a resource reference like any other -- and `@nier.Row` is held to the namespace rule with it.
            const name = tag.slice(1);
            this.result.resourceRefs.push({
                name, line: typeToken.line, column: typeToken.column, start: typeToken.start, end: tagEnd, nodeType: true,
            });
            this.noteNamespaceReference(name, 'resource', typeToken, tagEnd);
        }

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
            this.idless.add(node);
            this.advance();
        } else if (this.check('openBrace') || this.check('colon')) {
            // `HorizontalBox { … }`, `Text : Caption { … }` -- a node nothing refers to by name. The id is made once
            // the whole tree is read (nameAnonymousNodes): the rule that keeps it from colliding needs every id the
            // author DID write, and some of those are further down the file.
            node.anonymous = true;
        } else {
            // A type alone on a line is still the mistake it always was -- as likely a property whose '=' went
            // missing as a node -- and a '(' still wants the id a rename clause would carry references to.
            this.error(2004,
                `'${tag}' needs an id or a block, as in '${tag} MyName' or '${tag} { ... }' -- or an '=' if it was meant to be a property`,
                typeAnchor);
        }

        // The two optional clauses in either order, each at most once, as the compiler takes them.
        let hadWasClause = false;
        let hadStyleClause = false;
        for (;;) {
            if (this.check('openParen') && !hadWasClause) {
                this.parseWasClause(node);
                hadWasClause = true;
                continue;
            }
            if (this.check('colon') && !hadStyleClause) {
                this.parseStyleClause(node);
                hadStyleClause = true;
                continue;
            }
            break;
        }

        if (node.anonymous && node.wasId) {
            // A rename carries the old name's references to the new one, and an unnamed widget's variable is hidden
            // from graphs: the node needs an id of its own for the clause to mean anything.
            this.error(2004,
                `'${tag} (was: ${node.wasId})' renames a node, so it needs the new id written: '${tag} MyName : ...'`,
                typeAnchor);
        }

        if (this.check('openBrace')) {
            const open = this.current();
            this.advance();
            node.bodyStart = this.current().start;
            this.parseNodeBody(node, open);
            node.bodyEnd = this.previousStart();
            this.result.scopes.push({
                kind: 'node', name: node.tag, id: node.id, bodyStart: node.bodyStart, bodyEnd: node.bodyEnd,
            });
        } else if (!this.check('separator') && !this.check('closeBrace') && !this.atEnd()) {
            this.recover(); // "expected '{' or the end of the line after node …", the compiler's DUI2001
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
        // Malformed (DUI2008 in the compiler), and cleared rather than half filled: a partial old id is a rename
        // nobody asked for. Stepped over to its ')', never out of the statement.
        node.wasId = undefined;
        this.skipPastCloseParen();
    }

    /** `: Card`, or `: nier.Card`. The compiler reports a ':' with no name after it (DUI2001) and goes on. */
    private parseStyleClause(node: StructNode): void {
        this.advance(); // ':'
        if (!this.check('identifier')) {
            return;
        }
        const name = this.parseQualifiedName();
        node.styleName = name.name;
        node.styleNameStart = name.first.start;
        node.styleNameLine = name.first.line;
        node.styleNameColumn = name.first.column;
        this.noteNamespaceReference(name.name, 'style', name.first, name.end);
    }

    /** `Card` or `nier.Card`, the cursor on the first word; dots joined only with a word after them. */
    private parseQualifiedName(): { name: string; first: Token; end: number } {
        const first = this.current();
        let name = first.text;
        let end = first.end;
        this.advance();
        while (this.check('dot') && this.peek(1).kind === 'identifier') {
            this.advance();
            name += `.${this.current().text}`;
            end = this.current().end;
            this.advance();
        }
        return { name, first, end };
    }

    private noteNamespaceReference(name: string, kind: NamespaceRef['kind'], at: Token, end: number): void {
        const dot = name.indexOf('.');
        if (dot > 0) {
            this.result.namespaceRefs!.push({
                prefix: name.slice(0, dot), name, kind, line: at.line, column: at.column, start: at.start, end,
            });
        }
    }

    private noteResourceRef(at: Token, name: { name: string; end: number }, nodeType: boolean): void {
        this.result.resourceRefs.push({
            name: name.name, line: at.line, column: at.column, start: at.start, end: name.end,
            ...(nodeType ? { nodeType } : {}),
        });
        this.noteNamespaceReference(name.name, 'resource', at, name.end);
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
            this.parseComponent(node.components);
            return;
        }
        if (this.check('at')) {
            // `@slot …` (or `@slot { … }`) annotates this node's slot, and `@fill` / `@fill 2` stand for the two
            // slot lines written most; `@Row Row1 { }` is a child whose type an Asset resource names. `fill` is the
            // shorthand only where a resource node cannot stand -- alone, or before a number. The compiler asks
            // `!= "slot"` with FString's operator, which ignores case, and so does this.
            if (this.isFillShorthand()) {
                this.parseFillShorthand(node.properties);
                return;
            }
            if (this.peek(1).kind === 'identifier' && foldName(this.peek(1).text) !== 'slot') {
                const child = this.parseNode();
                if (child) {
                    node.children.push(child);
                }
                return;
            }
            this.parseSlotLine(node.properties);
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
            this.recover(); // DUI2007, the compiler's to word
            return;
        }
        if ((this.checkKeyword('props') || this.checkKeyword('events')) && this.peek(1).kind === 'openBrace') {
            // What the CLASS declares, so the top of the file, like `class`. Read as a block rather than as the
            // unnamed node of type `props` it would otherwise parse as.
            const keyword = this.current();
            this.error(keyword.text === 'props' ? 2016 : 2017,
                `'${keyword.text}' declares what this file's class has, so it belongs at the top of the file, not inside a node`,
                keyword);
            this.advance();
            this.skipBalancedBlock();
            return;
        }
        // `if` leads a statement only before something a condition can begin with (or a '{', the condition
        // forgotten), and `else` only before '{' or `if`: a property named either -- `if = 1`, `else <- F()` --
        // has an operator there instead and keeps reading as the property it is.
        if (this.checkKeyword('if') && canBeginCondition(this.peek(1).kind)) {
            this.parseConditional(node);
            return;
        }
        if (this.checkKeyword('else')
            && (this.peek(1).kind === 'openBrace' || (this.peek(1).kind === 'identifier' && this.peek(1).text === 'if'))) {
            // Reached only when no `if` came before it: an `else` that follows a branch is read by parseConditional
            // as part of the same statement and never gets back here.
            this.error(2018, "this 'else' follows no 'if' block", this.current());
            this.advance();
            if (this.checkKeyword('if')) {
                this.advance();
            }
            this.recover();
            return;
        }
        if (this.looksLikeProperty()) {
            const stmt = this.parseProperty(false);
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
            // `AnchorData.SizeDelta = ...` is a property; `Native.Toggle Mute {`, `nier.Row { … }` and
            // `nier.Row : Card { … }` are nodes whose type has a scope. Walk the dotted run and let what FOLLOWS it
            // decide, exactly as the compiler's parser does -- and only an id, an open brace or a style clause reads
            // as a node, so a property missing its '=' still fails as the property it was meant to be.
            let ahead = 1;
            while (this.peek(ahead).kind === 'dot' && this.peek(ahead + 1).kind === 'identifier') {
                ahead += 2;
            }
            const after = this.peek(ahead).kind;
            return after !== 'identifier' && after !== 'openBrace' && after !== 'colon';
        }
        return next === 'equals' || next === 'arrow' || next === 'eventArrow'
            || next === 'twoWayArrow';
    }

    /**
     * StartsAnotherProperty: a name, dotted or not, and then `=`, `<-`, `->` or `<->`. Narrower than
     * looksLikeProperty on purpose: it is asked where a statement may END, and only a line that cannot be read any
     * other way may start there -- `Label <- Item.Label  Kind <- Item.Kind` is two bindings on one line.
     */
    private startsAnotherProperty(): boolean {
        if (!this.check('identifier')) {
            return false;
        }
        let ahead = 1;
        while (this.peek(ahead).kind === 'dot' && this.peek(ahead + 1).kind === 'identifier') {
            ahead += 2;
        }
        const after = this.peek(ahead).kind;
        return after === 'equals' || after === 'arrow' || after === 'eventArrow' || after === 'twoWayArrow';
    }

    /**
     * ParseProperty, mirrored: the path, then exactly one of `= value`, `-> Handler`, `-> emit Event(args)`,
     * `<-> Variable` or `<- expression`. A statement the compiler refuses is stepped over the way it steps over it and
     * not recorded -- it is not in the compiler's tree either.
     */
    private parseProperty(isSlot: boolean): PropertyStmt | undefined {
        if (!this.check('identifier')) {
            this.recover();
            return undefined;
        }
        const first = this.current();
        let pathEnd = first.end;
        let path = first.text;
        this.advance();
        while (this.check('dot')) {
            this.advance();
            if (!this.check('identifier')) {
                this.recover(); // "expected a field name after …", DUI2001
                return undefined;
            }
            path += `.${this.current().text}`;
            pathEnd = this.current().end;
            this.advance();
        }
        const make = (op: PropertyStmt['op']): PropertyStmt => {
            const stmt: PropertyStmt = {
                path, pathStart: first.start, start: first.start, end: this.previousEnd(), op, isSlot,
            };
            this.anchors.set(stmt, first);
            return stmt;
        };

        if (this.check('equals')) {
            this.advance();
            const valueStart = this.current().start;
            if (!this.parseValue()) {
                this.recover(); // MissingPropertyValue, DUI2005
                return undefined;
            }
            const stmt = make('equals');
            stmt.valueStart = valueStart;
            stmt.valueEnd = Math.max(valueStart, this.previousEnd());
            return stmt;
        }
        if (this.check('eventArrow')) {
            // `OnClicked -> Confirm` -- a bare handler name -- or `OnClicked -> emit Picked(Index)`, the one place
            // arguments ARE written after `->`. `emit` is the keyword only with an event name after it.
            this.advance();
            if (this.checkKeyword('emit') && this.peek(1).kind === 'identifier') {
                this.advance(); // 'emit'
                if (!this.parseEmitRoute(first.start, pathEnd)) {
                    return undefined;
                }
                return make('eventArrow');
            }
            if (!this.check('identifier')) {
                this.recover();
                return undefined;
            }
            const fn = this.current();
            this.result.bindings.push({
                isEvent: true, pathStart: first.start, pathEnd, name: fn.text, nameStart: fn.start,
            });
            this.advance();
            return make('eventArrow');
        }
        if (this.check('twoWayArrow')) {
            // `Value <-> Volume` -- a bare VARIABLE name: the two sides mirror each other, and a
            // call or an expression has no left-hand side to write back into.
            this.advance();
            if (!this.check('identifier')) {
                this.recover(); // DUI2011
                return undefined;
            }
            const variable = this.current();
            this.result.bindings.push({
                isEvent: false, pathStart: first.start, pathEnd,
                name: variable.text, nameStart: variable.start, isVariable: true,
            });
            this.advance();
            const stmt = make('twoWayArrow');
            this.twoWayVariables.set(stmt, variable.text);
            return stmt;
        }
        if (this.check('arrow')) {
            // `Prop <- Expr` -- whether it type-checks is the thunk generator's verdict (DUI2011/5011); what THIS layer
            // owes downstream is every name the expression mentions, and the expression's true extent: it ends at the
            // end of the line or where another property line plainly begins.
            this.advance();
            if (!this.parseExpression(1, { pathStart: first.start, pathEnd })) {
                return undefined;
            }
            if (!this.atStatementEnd() && !this.startsAnotherProperty()) {
                this.recover(); // "unexpected … after the binding expression", DUI2011
                return undefined;
            }
            return make('arrow');
        }
        this.recover(); // MissingPropertyValue, DUI2005
        return undefined;
    }

    /** The rest of `Event -> emit Name(args)`, the cursor on Name. */
    private parseEmitRoute(pathStart: number, pathEnd: number): boolean {
        const event = this.current();
        this.result.bindings.push({
            isEvent: true, isEmit: true, pathStart, pathEnd, name: event.text, nameStart: event.start,
        });
        this.advance();
        if (!this.check('openParen')) {
            return true;
        }
        this.advance();
        if (!this.check('closeParen')) {
            for (;;) {
                if (!this.parseExpression(1, { pathStart, pathEnd })) {
                    return false;
                }
                if (!this.check('comma')) {
                    break;
                }
                this.advance();
            }
        }
        if (!this.check('closeParen')) {
            this.recover(); // DUI2011
            return false;
        }
        this.advance();
        return true;
    }

    // ---- binding expressions -------------------------------------------------------------------

    /**
     * ParseBindingExpression, mirrored for its EXTENT and its failures, collecting names as it goes: a call is a
     * function ref, a bare or dotted word a variable ref, `@Name` a resource ref. Nothing is reported -- DUI2011 is
     * the compiler's to word -- but where the compiler gives up on an expression this layer gives up too, at the same
     * token, and recovers the same way, so the statements after it are the compiler's statements.
     */
    private parseExpression(minPrecedence: number, context: RefContext): boolean {
        if (!this.parseUnary(context)) {
            return false;
        }
        for (;;) {
            const precedence = binaryPrecedence(this.current().kind);
            if (precedence === 0 || precedence < minPrecedence) {
                return true;
            }
            this.advance();
            // Precedence + 1 makes every level left-associative, as in the compiler; a chain of one operator is a
            // loop here, not a recursion.
            if (!this.parseExpression(precedence + 1, context)) {
                return false;
            }
        }
    }

    private parseUnary(context: RefContext): boolean {
        while (this.check('bang') || this.check('minus')) {
            this.advance();
        }
        return this.parsePrimary(context);
    }

    private parsePrimary(context: RefContext): boolean {
        const token = this.current();
        switch (token.kind) {
            case 'openParen': {
                if (this.expressionDepth >= MAX_NESTING_DEPTH) {
                    this.recover();
                    return false;
                }
                this.advance();
                this.expressionDepth++;
                try {
                    if (!this.parseExpression(1, context)) {
                        return false;
                    }
                } finally {
                    this.expressionDepth--;
                }
                if (!this.check('closeParen')) {
                    this.recover();
                    return false;
                }
                this.advance();
                return true;
            }
            case 'number':
            case 'string':
                this.advance();
                return true;
            case 'at': {
                this.advance();
                if (!this.check('identifier')) {
                    this.recover();
                    return false;
                }
                this.noteResourceRef(token, this.parseQualifiedName(), false);
                return true;
            }
            case 'identifier': {
                this.advance();
                if (token.text === 'true' || token.text === 'false') {
                    return true;
                }
                if (this.check('openParen')) {
                    this.result.bindings.push({
                        isEvent: false, pathStart: context.pathStart, pathEnd: context.pathEnd,
                        name: token.text, nameStart: token.start, ...(context.isCondition ? { isCondition: true } : {}),
                    });
                    if (this.expressionDepth >= MAX_NESTING_DEPTH) {
                        this.recover();
                        return false;
                    }
                    this.advance();
                    this.expressionDepth++;
                    try {
                        if (!this.check('closeParen')) {
                            for (;;) {
                                if (!this.parseExpression(1, context)) {
                                    return false;
                                }
                                if (this.check('comma')) {
                                    this.advance();
                                    continue;
                                }
                                break;
                            }
                        }
                    } finally {
                        this.expressionDepth--;
                    }
                    if (!this.check('closeParen')) {
                        this.recover();
                        return false;
                    }
                    this.advance();
                    return true;
                }
                // A bare identifier is a variable on the user widget -- a `props` entry included -- and dots extend
                // it into a path (`Item.Title` inside a loop body).
                let full = token.text;
                while (this.check('dot')) {
                    this.advance();
                    if (!this.check('identifier')) {
                        this.recover();
                        return false;
                    }
                    full += `.${this.current().text}`;
                    this.advance();
                }
                this.result.bindings.push({
                    isEvent: false, pathStart: context.pathStart, pathEnd: context.pathEnd,
                    name: full, nameStart: token.start, isVariable: true,
                    ...(context.isCondition ? { isCondition: true } : {}),
                });
                return true;
            }
            default:
                this.recover();
                return false;
        }
    }

    // ---- values --------------------------------------------------------------------------------

    /**
     * ParseValue, mirrored: exactly one value -- a word, a number, a string, a colour, a path, a tuple, `@Name` --
     * and the `@key("…")` that may follow a string. Not "everything to the end of the line": `A = 1  B = 2` is two
     * statements to the compiler, and has to be two here. False where the compiler's would be.
     */
    private parseValue(): boolean {
        const token = this.current();
        switch (token.kind) {
            case 'number':
            case 'identifier':
            case 'string':
            case 'hexColor':
            case 'assetPath':
                this.advance();
                break;
            case 'openParen':
                if (!this.parseTuple()) {
                    return false;
                }
                break;
            case 'at':
                this.advance();
                if (!this.check('identifier')) {
                    return false;
                }
                this.noteResourceRef(token, this.parseQualifiedName(), false);
                break;
            default:
                return false;
        }
        this.parseKeyOverride();
        return true;
    }

    /**
     * ParseTuple: to the matching ')', across lines -- inside the parentheses a newline is whitespace. A '}' ends the
     * hunt as surely as the end of the file does, and that is DUI2003. The elements are raw text to the compiler, so
     * nothing inside is a reference.
     */
    private parseTuple(): boolean {
        const open = this.current();
        this.advance();
        let depth = 1;
        for (;;) {
            const token = this.current();
            if (token.kind === 'end' || token.kind === 'closeBrace') {
                this.error(2003, "this '(' never reaches its ')'", open);
                return false;
            }
            this.advance();
            if (token.kind === 'openParen') {
                depth++;
            } else if (token.kind === 'closeParen') {
                depth--;
                if (depth === 0) {
                    return true;
                }
            }
        }
    }

    /** ParseOptionalKeyOverride: `@key("Some.Key")` after a value, stepped over the way the compiler steps over it. */
    private parseKeyOverride(): void {
        if (!this.check('at') || this.peek(1).kind !== 'identifier') {
            return;
        }
        if (this.peek(1).text !== 'key') {
            this.recover(); // "'@key(\"...\")' is the only annotation a value takes", DUI2001
            return;
        }
        this.advance(); // '@'
        this.advance(); // 'key'
        if (!this.check('openParen')) {
            this.recover();
            return;
        }
        this.advance();
        if (!this.check('string')) {
            this.skipPastCloseParen();
            this.recover();
            return;
        }
        this.advance();
        if (!this.check('closeParen')) {
            this.skipPastCloseParen();
            this.recover();
            return;
        }
        this.advance();
    }

    // ---- components and slot lines -------------------------------------------------------------

    /** `+ VerticalBox { Spacing = 15 }`, into a node's components or a style's. The cursor is on the '+'. */
    private parseComponent(out: StructComponent[]): void {
        const plus = this.current();
        this.advance(); // '+'
        if (!this.check('identifier') && !this.check('assetPath')) {
            this.recover();
            return;
        }
        const nameToken = this.current();
        const component: StructComponent = {
            name: nameToken.text, line: nameToken.line, column: nameToken.column, start: nameToken.start,
            properties: [],
        };
        this.anchors.set(component, plus);
        this.advance();

        if (this.check('openBrace')) {
            const open = this.current();
            this.advance();
            component.bodyStart = this.current().start;
            this.parsePropertyOnlyBlock(open, component.properties!, false);
            component.bodyEnd = this.previousStart();
            this.result.scopes.push({
                kind: 'component', name: component.name,
                bodyStart: component.bodyStart, bodyEnd: component.bodyEnd,
            });
        } else if (!this.atStatementEnd()) {
            this.recover(); // "expected '{' or the end of the line after '+ …'", DUI2001
        }
        out.push(component);
    }

    /** A behaviour's block and an `@slot { … }` block: `Name = Value` lines and nothing else. */
    private parsePropertyOnlyBlock(open: Token, out: PropertyStmt[], isSlot: boolean): void {
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
                    const stmt = this.parseProperty(isSlot);
                    if (stmt) {
                        out.push(stmt);
                    }
                } else {
                    this.recover(); // "… holds only 'Name = Value' lines", DUI2001
                }
                if (this.index === before) {
                    this.advance();
                }
            }
        } finally {
            this.nestingDepth--;
        }
    }

    /**
     * `@slot Padding = (8, 8, 8, 8)`, or the block form `@slot { SizeRule = Fill  Padding = (0, 8, 0, 0) }` -- into a
     * node's lines or a style's, flagged. The cursor is on the '@'. A one-line `@slot` is located at its '@' by the
     * compiler, a block's lines each at its own name.
     */
    private parseSlotLine(out: PropertyStmt[]): void {
        const at = this.current();
        this.advance(); // '@'
        if (!this.checkKeyword('slot')) {
            this.recover(); // "'@slot' and '@fill' are the only annotations that lead a line", DUI2001
            return;
        }
        this.advance();

        if (this.check('openBrace')) {
            const open = this.current();
            this.advance();
            const bodyStart = this.current().start;
            this.parsePropertyOnlyBlock(open, out, true);
            this.result.scopes.push({ kind: 'slotLines', name: '@slot', bodyStart, bodyEnd: this.previousStart() });
            return;
        }

        const stmt = this.parseProperty(true);
        if (stmt) {
            this.anchors.set(stmt, at);
            out.push(stmt);
        }
    }

    /** IsFillShorthand: `@fill` alone on its line, or before a number -- a digit-led word is a node's id, not a weight. */
    private isFillShorthand(): boolean {
        if (!this.check('at') || this.peek(1).kind !== 'identifier' || this.peek(1).text !== 'fill') {
            return false;
        }
        const after = this.peek(2);
        return after.kind === 'separator' || after.kind === 'closeBrace' || after.kind === 'end'
            || (after.kind === 'number' && !after.digitLeadingWord);
    }

    private parseFillShorthand(out: PropertyStmt[]): void {
        const at = this.current();
        this.advance(); // '@'
        this.advance(); // 'fill'
        const stmt: PropertyStmt = {
            path: 'SizeRule', pathStart: at.start, start: at.start, end: this.previousEnd(), op: 'equals',
            isSlot: true, shorthand: 'fill',
        };
        this.anchors.set(stmt, at);
        if (this.check('number')) {
            this.advance();
            stmt.end = this.previousEnd();
            this.weightedFills.add(stmt);
        }
        out.push(stmt);
        if (!this.atStatementEnd()) {
            this.recover(); // "'@fill' takes at most a weight", DUI2001
        }
    }

    // ---- slots, loops, conditions --------------------------------------------------------------

    /**
     * `slot Name`, `slot Name default : Style { … }` -- a hole this file's class declares -- or `slot Name { widgets }`
     * inside a component instance, filling the hole of that name. The block tells them apart, as in the compiler: a
     * declaration may say how the hole is laid out (components, properties, slot lines, a style) and holds no widgets;
     * a fill holds nothing but widgets. A block with both is DUI2019.
     */
    private parseNamedSlot(parent: StructNode): void {
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

        // The clauses, each at most once and in any order: `(was: Old)`, `default` (a keyword only here), `: Style`.
        let hadWasClause = false;
        let hadStyleClause = false;
        let defaultToken: Token | undefined;
        for (;;) {
            if (this.check('openParen') && !hadWasClause) {
                this.parseWasClause(slot);
                hadWasClause = true;
                continue;
            }
            if (this.checkKeyword('default')) {
                if (defaultToken) {
                    this.error(2019, `slot '${slot.id}' says 'default' twice`, this.current());
                } else {
                    defaultToken = this.current();
                }
                this.advance();
                continue;
            }
            if (this.check('colon') && !hadStyleClause) {
                this.parseStyleClause(slot);
                hadStyleClause = true;
                continue;
            }
            break;
        }

        if (this.check('openBrace')) {
            const open = this.current();
            this.advance();
            slot.bodyStart = this.current().start;
            this.parseNodeBody(slot, open);
            slot.bodyEnd = this.previousStart();
            this.result.scopes.push({
                kind: 'namedSlot', name: 'slot', id: slot.id, bodyStart: slot.bodyStart, bodyEnd: slot.bodyEnd,
            });

            // Read whole first, and judged by which half of the node grammar it used -- with an `if`'s widgets counted
            // where the compiler lowers them, among the slot's own children.
            const widgets = this.lowered(slot);
            const declares = slot.components.length > 0 || slot.properties.length > 0;
            if (widgets.length > 0 && declares) {
                this.error(2019,
                    `slot '${slot.id}' both declares (components, properties, '@slot' lines) and fills (widgets); a declaration holds no widgets and a fill holds nothing else`,
                    this.headerAnchor(widgets[0]));
            } else if (widgets.length > 0) {
                slot.fillsSlot = true;
                // What the HOLE is -- the default, its style, its old name -- is said where the hole is declared.
                if (defaultToken || hadStyleClause || slot.wasId) {
                    this.error(2019,
                        `slot '${slot.id}' is filled here (it holds widgets), and 'default', a style or a rename belongs on the slot's declaration`,
                        keyword);
                }
            }
        }

        if (defaultToken && !slot.fillsSlot) {
            if (this.firstDefaultSlot) {
                // Content nested without a slot name has one place to go; the first keeps the role.
                this.error(3022,
                    `slot '${slot.id}' is a second default; '${this.firstDefaultSlot.name}' on line ${this.firstDefaultSlot.line} already is one`,
                    defaultToken);
            } else {
                this.firstDefaultSlot = { name: slot.id, line: defaultToken.line };
                slot.defaultSlot = true;
            }
        }
        parent.children.push(slot);
    }

    private parseLoop(parent: StructNode): void {
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

        // A header the compiler refuses (DUI2010) makes no loop at all, and its block is stepped over with it. Kept
        // here all the same -- `each Track in ` is what every loop looks like while it is being typed, and completion
        // inside its body needs the scope -- but kept OUT of the tree the compiler sees (see `dropped`).
        const unfinished = (): void => {
            loop.refused = true;
            this.recoverKeepingBody(loop, parent);
        };
        if (!this.checkKeyword('in')) {
            unfinished();
            return;
        }
        this.advance();
        if (!this.check('identifier')) {
            unfinished();
            return;
        }
        const source = this.current();
        loop.loopSource = source.text;
        loop.loopSourceStart = source.start;
        this.advance();
        // The parentheses DISTINGUISH: `in GetItems()` calls a function, `in Items` reads a variable.
        loop.loopSourceIsFunction = false;
        if (this.check('openParen')) {
            this.advance();
            if (!this.check('closeParen')) {
                this.skipPastCloseParen();
                unfinished();
                return;
            }
            this.advance();
            loop.loopSourceIsFunction = true;
        }

        // A warning, deliberately: a shadowed loop variable provably cannot change the tree. Case SENSITIVE, unlike
        // names -- this follows the compiler exactly.
        if (this.loopVariables.includes(loop.id)) {
            this.warning(3008, `'${loop.id}' is already the variable of an enclosing loop`, variableToken);
        }

        if (!this.check('openBrace')) {
            this.recover(); // "a loop needs a '{ ... }' body", DUI2001 -- and the loop is kept, as the compiler keeps it
            parent.children.push(loop);
            return;
        }
        const open = this.current();
        this.advance();
        loop.bodyStart = this.current().start;
        this.loopVariables.push(loop.id);
        this.parseNodeBody(loop, open);
        this.loopVariables.pop();
        loop.bodyEnd = this.previousStart();
        this.result.scopes.push({
            kind: 'loop', name: loop.tag, id: loop.id, bodyStart: loop.bodyStart, bodyEnd: loop.bodyEnd,
        });
        parent.children.push(loop);
    }

    /**
     * `if HasSave() { … } else if Loading() { … } else { … }` -- one 'branch' child per arm, in place. The compiler
     * lowers the arms into the enclosing node's children (each widget shown under its arm's condition); see
     * `lowered`. `else` may stand on the line the '}' closed or on the next one, as in C.
     */
    private parseConditional(parent: StructNode): void {
        let header = this.current();
        this.advance(); // 'if'
        let tag: 'if' | 'else if' | 'else' = 'if';
        let finalElse = false;
        for (;;) {
            let conditionStart: number | undefined;
            let conditionEnd: number | undefined;
            if (!finalElse) {
                if (this.check('openBrace')) {
                    this.error(2018, "this 'if' has no condition before its '{'", header);
                    this.skipBalancedBlock();
                    return;
                }
                conditionStart = this.current().start;
                if (!this.parseExpression(1, { pathStart: header.start, pathEnd: header.end, isCondition: true })) {
                    return; // reported, and the statement recovered, by the expression grammar itself
                }
                conditionEnd = this.previousEnd();
            }

            if (!this.check('openBrace')) {
                this.error(2018, `expected the '{ ... }' block of this branch, found '${this.describeCurrent()}'`, this.current());
                this.recover();
                return;
            }
            const open = this.current();
            this.advance();
            const branch: StructNode = {
                kind: 'branch', tag, id: '',
                line: header.line, column: header.column, start: header.start,
                components: [], children: [], properties: [],
                bodyStart: this.current().start,
            };
            if (conditionStart !== undefined && conditionEnd !== undefined) {
                branch.condition = this.text.slice(conditionStart, conditionEnd);
                branch.conditionStart = conditionStart;
                branch.conditionEnd = conditionEnd;
            }
            this.parseNodeBody(branch, open);
            branch.bodyEnd = this.previousStart();
            this.result.scopes.push({ kind: 'branch', name: tag, bodyStart: branch.bodyStart!, bodyEnd: branch.bodyEnd });
            this.takeBranch(branch);
            parent.children.push(branch);
            if (finalElse) {
                return;
            }

            // The chain goes on through an `else`; the separators stepped over to look mean nothing between statements.
            this.skipSeparators();
            if (!this.checkKeyword('else') || this.startsAnotherProperty()) {
                return;
            }
            header = this.current();
            const elseIf = this.peek(1).kind === 'identifier' && this.peek(1).text === 'if';
            if (!elseIf && this.peek(1).kind !== 'openBrace') {
                this.error(2018, "'else' is followed by its '{ ... }' block, or by 'if' and another condition", header);
                this.advance();
                this.recover();
                return;
            }
            this.advance(); // 'else'
            if (elseIf) {
                this.advance(); // 'if'
                tag = 'else if';
            } else {
                finalElse = true;
                tag = 'else';
            }
        }
    }

    /**
     * TakeBranch's refusals: a branch chooses WIDGETS, so a property, a slot line or a component in one has no widget
     * of its own to be set on, and a slot or a loop has no Shown to carry the condition. And ApplyBranchCondition's:
     * a widget that mirrors its own Shown (`Shown <-> X`) cannot sit in one -- once per `if` it sits in, as the
     * compiler applies each level's condition in turn.
     */
    private takeBranch(branch: StructNode): void {
        for (const stmt of branch.properties) {
            if (!stmt.isSlot) {
                this.error(2018,
                    `'${stmt.path}' is a property, and an 'if' block holds widgets: put it on a widget inside the block`,
                    this.statementAnchor(stmt));
            }
        }
        for (const stmt of branch.properties) {
            if (!stmt.isSlot) {
                continue;
            }
            const names = stmt.shorthand === 'fill'
                ? (this.weightedFills.has(stmt) ? ['SizeRule', 'FillWeight'] : ['SizeRule'])
                : [stmt.path];
            for (const name of names) {
                this.error(2018,
                    `'@slot ${name}' is a slot line, and an 'if' block holds widgets: put it on a widget inside the block`,
                    this.statementAnchor(stmt));
            }
        }
        for (const component of branch.components) {
            const plus = this.anchors.get(component);
            this.error(2018,
                `'+ ${component.name}' attaches to a widget, and an 'if' block holds widgets: put it on a widget inside the block`,
                plus ?? { line: component.line, column: component.column, start: component.start, end: component.start + component.name.length });
        }
        for (const child of branch.children) {
            if (child.kind === 'node') {
                this.checkBranchShown(child);
            } else if (child.kind === 'branch') {
                const widgets: StructNode[] = [];
                this.collectBranchWidgets(child, widgets);
                widgets.forEach((widget) => this.checkBranchShown(widget));
            } else if (!child.refused) {
                this.error(2018,
                    "only widgets can be shown and hidden by an 'if' block; a slot or a loop cannot sit in one",
                    this.headerAnchor(child));
            }
        }
    }

    /** The widget's own Shown -- the last line naming it that is not an event route -- refused when it is a mirror. */
    private checkBranchShown(widget: StructNode): void {
        let own: PropertyStmt | undefined;
        for (let at = widget.properties.length - 1; at >= 0; at--) {
            const stmt = widget.properties[at];
            if (!stmt.isSlot && foldName(stmt.path) === 'shown' && stmt.op !== 'eventArrow') {
                own = stmt;
                break;
            }
        }
        if (own && own.op === 'twoWayArrow') {
            const variable = this.twoWayVariables.get(own) ?? '';
            this.error(2018,
                `'Shown <-> ${variable}' cannot sit in an 'if' block: the branch decides Shown, and a mirror would write that back into '${variable}'`,
                this.statementAnchor(own));
        }
    }

    // ---- the tree the compiler sees ------------------------------------------------------------

    /**
     * A node's children as the compiler holds them: every branch replaced by its widgets (nested branches included),
     * and what a branch held that is not a widget dropped, as TakeBranch drops it.
     */
    private lowered(node: StructNode): StructNode[] {
        return loweredChildren(node);
    }

    /**
     * RecoverToStatementBoundary for a loop whose header failed, consuming exactly what it consumes -- but a block met
     * on the way is read as the loop's body rather than skipped, so the editor still knows what is inside it.
     */
    private recoverKeepingBody(loop: StructNode, parent: StructNode): void {
        let depth = 0;
        let bodyRead = false;
        while (!this.atEnd()) {
            const kind = this.current().kind;
            if (depth === 0 && (kind === 'separator' || kind === 'closeBrace')) {
                break;
            }
            if (depth === 0 && kind === 'openBrace' && !bodyRead) {
                bodyRead = true;
                const open = this.current();
                this.advance();
                loop.bodyStart = this.current().start;
                // Read for the editor's sake only: the compiler never looks inside, so nothing found in there is a
                // verdict of its -- the header's DUI2010 is the one thing it says about this block.
                const diagnosticsBefore = this.result.diagnostics.length;
                const namespaceRefsBefore = this.result.namespaceRefs!.length;
                this.loopVariables.push(loop.id);
                this.parseNodeBody(loop, open);
                this.loopVariables.pop();
                this.result.diagnostics.length = diagnosticsBefore;
                this.result.namespaceRefs!.length = namespaceRefsBefore;
                loop.bodyEnd = this.previousStart();
                this.result.scopes.push({
                    kind: 'loop', name: loop.tag, id: loop.id, bodyStart: loop.bodyStart, bodyEnd: loop.bodyEnd,
                });
                continue;
            }
            if (kind === 'openBrace' || kind === 'openParen') {
                depth++;
            } else if (kind === 'closeBrace' || kind === 'closeParen') {
                depth = Math.max(0, depth - 1);
            }
            this.advance();
        }
        parent.children.push(loop);
    }

    private collectBranchWidgets(branch: StructNode, out: StructNode[]): void {
        collectBranchWidgets(branch, out);
    }

    /** The id the compiler's node carries: none on a loop, none for a refused digit-led one. */
    private compilerId(node: StructNode): string {
        if (node.kind === 'loop' || node.kind === 'branch' || this.idless.has(node)) {
            return '';
        }
        return node.id;
    }

    // ---- made ids ------------------------------------------------------------------------------

    /**
     * NameAnonymousNodes, mirrored: every written id first (a fill's excepted -- it names a hole in another class),
     * then one pass in the compiler's order, the root before its children and each child before ITS children.
     */
    private nameAnonymousNodes(root: StructNode, report: boolean): void {
        const taken = new Set<string>();
        this.collectWrittenIds(root, taken, 0);
        if (root.anonymous) {
            this.assignAnonymousId(root, 'Root', new Map(), taken, report);
        }
        this.nameAnonymousChildren(root, this.compilerId(root), new Map(), taken, 0, report);
    }

    private collectWrittenIds(node: StructNode, taken: Set<string>, depth: number): void {
        if (depth >= MAX_NESTING_DEPTH) {
            return;
        }
        const id = this.compilerId(node);
        if (!node.anonymous && id.length > 0 && !(node.kind === 'namedSlot' && node.fillsSlot)) {
            taken.add(foldName(id));
        }
        for (const child of this.lowered(node)) {
            this.collectWrittenIds(child, taken, depth + 1);
        }
    }

    private nameAnonymousChildren(parent: StructNode, scopeId: string, counts: Map<string, number>,
        taken: Set<string>, depth: number, report: boolean): void {
        if (depth >= MAX_NESTING_DEPTH) {
            return;
        }
        for (const child of this.lowered(parent)) {
            if (child.kind === 'node' && child.anonymous) {
                this.assignAnonymousId(child, scopeId, counts, taken, report);
            }
            // A loop body and a slot being filled have no id to give: their widgets count along with the nearest node
            // that has one.
            if (child.kind === 'loop' || (child.kind === 'namedSlot' && child.fillsSlot)) {
                this.nameAnonymousChildren(child, scopeId, counts, taken, depth + 1, report);
            } else {
                this.nameAnonymousChildren(child, this.compilerId(child), new Map(), taken, depth + 1, report);
            }
        }
    }

    private assignAnonymousId(node: StructNode, scopeId: string, counts: Map<string, number>,
        taken: Set<string>, report: boolean): void {
        // The type with every character an id cannot hold made '_' -- `nier.Row` is `nier_Row`, `@Row` is `_Row` --
        // and counted by that spelling (a TMap of FString: without regard to case).
        let type = '';
        for (let at = 0; at < node.tag.length; at++) {
            type += isIdentifierChar(node.tag.charCodeAt(at)) ? node.tag[at] : '_';
        }
        const scope = scopeId.length === 0 ? 'Root' : scopeId;
        const count = counts.get(foldName(type)) ?? 0;
        counts.set(foldName(type), count + 1);
        let id = `${scope}__${type}${count}`;

        // The one length rule the lexer holds every written name to, held to a made one: a chain of unnamed parents or
        // a long asset path can make a name an FName cannot hold. Cut short enough to bump, as the compiler cuts it.
        const bumpRoom = 12;
        if (id.length >= NAME_SIZE) {
            if (report) {
                this.error(1006,
                    `the id made for this unnamed '${ellipsize(node.tag)}' would be ${id.length} characters long, and an id holds at most ${NAME_SIZE - 1}; give it, or a node above it, an id`,
                    this.headerAnchor(node));
            }
            id = id.slice(0, NAME_SIZE - 1 - bumpRoom);
        }

        // Bumped past an id the author wrote -- the author's is the one their bindings mean -- and past any made earlier.
        if (taken.has(foldName(id))) {
            let bump = 1;
            while (taken.has(foldName(`${id}_${bump}`))) {
                bump++;
            }
            id = `${id}_${bump}`;
        }
        taken.add(foldName(id));
        node.id = id;
    }

    // ---- the whole-file checks -----------------------------------------------------------------

    /**
     * CheckNamespaceReferences, for the cases one file settles: a `ns.` whose `ns` no `use "…" as ns` of this file
     * gives, in a file with no plain `use` of a file -- a plain `use` merges the library's own namespaces, which only
     * the library can say. The rest needs the index and is core/diagnose.ts's. A class path's `as` name is a component,
     * never a namespace, so it does not count.
     */
    private checkNamespaceReferences(): void {
        const usable = this.result.imports.filter((directive) => !directive.refused && directive.target !== 'class');
        if (usable.some((directive) => directive.alias === undefined)) {
            return;
        }
        const asNames = new Set(usable.map((directive) => foldName(directive.alias!)));
        for (const reference of this.result.namespaceRefs!) {
            if (!asNames.has(foldName(reference.prefix))) {
                reference.reported = true;
                this.error(3021,
                    `'${reference.name}' is qualified by '${reference.prefix}', which no 'use "..." as ${reference.prefix}' declares`,
                    reference);
            }
        }
    }

    /**
     * CheckNamesAcrossTheTree: duplicate ids and unknown styles, over the tree the compiler holds -- the first root,
     * lowered -- and, beside them, the rename-clause warnings and the style chains.
     */
    private checkNamesAcrossTheTree(): void {
        // Case insensitive on purpose: every id becomes an FName member variable downstream, and
        // FName would collide OkBtn with okbtn anyway. Catching it here names both lines.
        const firstSeen = new Map<string, StructNode>();
        const wasSeen = new Map<string, StructNode>();
        const allNodes: StructNode[] = [];

        const visit = (node: StructNode, depth: number): void => {
            allNodes.push(node);
            const id = this.compilerId(node);
            // A slot being FILLED is not an identity of this class: two instances each filling their Detail is the
            // language working, not a collision.
            if (id.length > 0 && !(node.kind === 'namedSlot' && node.fillsSlot)) {
                const first = firstSeen.get(foldName(id));
                if (first) {
                    // Never uniquified: the id is the node's identity, and inventing OkBtn_1 would
                    // silently repoint whichever of the two the author's bindings meant.
                    this.error(3001, `'${node.id}' is already the id of the node on line ${first.line}`,
                        this.idAnchor(node));
                } else {
                    firstSeen.set(foldName(id), node);
                }
            }
            if (depth < MAX_NESTING_DEPTH) {
                for (const child of this.lowered(node)) {
                    visit(child, depth + 1);
                }
            }
        };
        if (this.result.roots.length > 0) {
            visit(this.result.roots[0], 0);
        }

        for (const node of allNodes) {
            // A namespaced style is the index's to judge: its library's styles are not in this file, and when the
            // namespace itself is unknown the compiler says that, once, instead (DUI3021).
            if (node.styleName && !node.styleName.includes('.') && !this.findStyle(node.styleName)) {
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
     * says nothing there today, and a warning cannot claim more than it knows. A namespaced base
     * ends the walk unjudged: what it inherits lives in another file.
     */
    private checkStyleChains(nodes: StructNode[]): void {
        const wornStyles = new Set<string>();
        for (const node of nodes) {
            if (!node.styleName || node.styleName.includes('.')) {
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
                if (!link.base || link.base.includes('.')) {
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
            if (style.base && !style.base.includes('.') && !this.findStyle(style.base)
                && !wornStyles.has(foldName(style.name))) {
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

    // ---- anchors -------------------------------------------------------------------------------

    private idAnchor(node: StructNode): Anchor {
        if (node.idStart !== undefined) {
            return {
                line: node.idLine!, column: node.idColumn!,
                start: node.idStart, end: node.idStart + node.id.length,
            };
        }
        return this.headerAnchor(node);
    }

    /** Where the compiler locates a node: its type (the '@' of a resource type), or its `slot` / `for` / `if` keyword. */
    private headerAnchor(node: StructNode): Anchor {
        const end = node.kind === 'node' ? (node.tagEnd ?? node.start + node.tag.length)
            : node.start + node.tag.split(' ')[0].length;
        return { line: node.line, column: node.column, start: node.start, end };
    }

    /**
     * Where the compiler locates a statement: the '@' of a one-line `@slot` and of `@fill`, else the path -- and the
     * span underlined from there to the end of the path (of the whole shorthand, which spells no path).
     */
    private statementAnchor(stmt: PropertyStmt): Anchor {
        const token = this.anchors.get(stmt)!;
        const end = stmt.shorthand ? stmt.end : Math.max(token.end, stmt.pathStart + stmt.path.length);
        return { line: token.line, column: token.column, start: token.start, end };
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
 * A node's children as the compiler holds them after it lowers `if` / `else`: every branch replaced by its widgets,
 * nested branches included, what a branch held that is not a widget dropped (DUI2018 already said so), and a loop
 * whose header the compiler refused (`refused`) left out. For any
 * rule about the tree the compiler builds -- what an instance's default slot receives, which siblings an id counts
 * among -- this is the list to walk; `children` is the list to SHOW.
 */
export function loweredChildren(node: StructNode): StructNode[] {
    const out: StructNode[] = [];
    for (const child of node.children) {
        if (child.kind === 'branch') {
            collectBranchWidgets(child, out);
        } else if (!child.refused) {
            out.push(child);
        }
    }
    return out;
}

/** A branch's widgets, a nested `if`'s included, as the compiler moves them into the enclosing node. */
function collectBranchWidgets(branch: StructNode, out: StructNode[]): void {
    for (const child of branch.children) {
        if (child.kind === 'node') {
            out.push(child);
        } else if (child.kind === 'branch') {
            collectBranchWidgets(child, out);
        }
    }
}

/**
 * Builds the structural model for one file. Runs the scanner itself so callers hold one result
 * carrying both layers' diagnostics (lexical first, as the compiler emits them) and the token
 * stream, for consumers that need token-level facts -- colours, brace balance, semantic tokens.
 */
export function buildStructure(text: string): StructureResult
    & { lexical: DuiDiagnostic[]; tokens: Token[]; comments: CommentSpan[] } {
    const scanned = scan(text);
    const parser = new Parser(scanned.tokens, text);
    parser.parseFile();
    return { ...parser.result, lexical: scanned.diagnostics, tokens: scanned.tokens, comments: scanned.comments };
}
