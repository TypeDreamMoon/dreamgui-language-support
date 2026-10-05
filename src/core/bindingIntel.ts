/**
 * What a binding expression says about the cursor standing in it: which call the cursor is an
 * argument of, which `each` variable is in scope and what it iterates, and which `X.` member run
 * is being spelled. Pure, so the answers are tested against the spellings people actually write
 * rather than against a live editor -- the bridge supplies the NAMES, this file decides which
 * question to ask it.
 *
 * A statement never spans a line (a newline is a `separator` token, exactly as in the compiler),
 * so everything cursor-local here works on the current line's text alone. Everything file-wide --
 * the `each` scopes -- reads the structure layer instead, and the loop's source expression is
 * recovered from the TOKEN stream: the structural parser steps over that expression without
 * recording its span, and re-lexing a line would be a second grammar to keep honest.
 *
 * No vscode import here, ever: src/core/ is the seam a future LSP server or another IDE reuses.
 */

import { Token, scan } from './scanner';
import { StructNode, StructureResult } from './structure';
import { BridgeFunctionInfo } from './bridgeProtocol';

const NAME_HEAD = '[A-Za-z_\\u00A0-\\uFFFF]';
const NAME_TAIL = '[\\w\\u00A0-\\uFFFF]';
const IDENTIFIER = new RegExp('^' + NAME_HEAD + NAME_TAIL + '*$', 'u');

/**
 * How the expression on a line is introduced: one of the three arrows, or `if` -- the condition of an `if` / `else if`
 * header, which the compiler parses as a binding expression and lowers into a `Shown <- …` on every widget of the
 * branch. Everything this file answers about a `<-` right side it answers about a condition the same way.
 */
export type BindingArrow = '<-' | '<->' | '->' | 'if';

export interface BindingTail {
    op: BindingArrow;
    /** Everything after the arrow, up to where the caller cut the line (usually the cursor). */
    tail: string;
    /** Index into the original line where `tail` begins. */
    tailStart: number;
}

/**
 * `if Cond`, `} else if Cond`, `else if Cond` at the start of a line -- the `if` the parser takes as a keyword, which
 * is only one that leads a branch and is followed by something a condition can begin with (CanBeginCondition). A
 * property that happens to be called `if` (`if = 3`) is still a property, and is not matched.
 */
const CONDITION_HEADER = /^(\s*(?:\}\s*)?(?:else\s+)?if)(?=\s*$|\s+[(!@"\-0-9A-Za-z_\u00A0-\uFFFF]|[(!@"\-])/u;

/**
 * The binding expression on this line, or nothing. Arrows inside strings and comments are passed
 * over rather than matched: the corpus documents its own syntax in tooltips
 * (`ToolTipText = "RenderOpacity <- MasterVolume: ..."`), and a quoted arrow that opened
 * completion on a prose sentence would be this feature's most visible mistake.
 *
 * With no arrow, an `if` header's condition is the expression -- up to its `{`: past the brace the cursor stands in
 * the branch, where a widget goes, not in the condition.
 */
export function bindingTailOf(line: string): BindingTail | undefined {
    let found: BindingTail | undefined;
    let inString = false;
    let firstBrace = -1;
    for (let index = 0; index < line.length; index++) {
        const character = line[index];
        if (inString) {
            if (character === '\\') {
                index++;
            } else if (character === '"') {
                inString = false;
            }
            continue;
        }
        if (character === '"') {
            inString = true;
            continue;
        }
        if (character === '/' && line[index + 1] === '/') {
            break; // a line comment: nothing past it is code
        }
        if (character === '{' && firstBrace < 0) {
            firstBrace = index;
        }
        // The three-character arrow is tested first -- it contains both of the others. `+=` routes as `->` does: what
        // follows it is a handler, `emit`, or a member route, and only the event's kind tells the two apart.
        const op: BindingArrow | undefined = line.startsWith('<->', index) ? '<->'
            : line.startsWith('<-', index) ? '<-'
                : line.startsWith('->', index) || line.startsWith('+=', index) ? '->' : undefined;
        if (op) {
            const length = op === '->' && line.startsWith('+=', index) ? 2 : op.length;
            found = { op, tail: line.slice(index + length), tailStart: index + length };
            index += length - 1;
        }
    }
    if (found) {
        return found;
    }
    const header = CONDITION_HEADER.exec(line);
    if (header) {
        const tailStart = header[1].length;
        // A `}` closing the previous branch sits BEFORE the keyword; only a brace after it ends the condition.
        if (firstBrace >= 0 && firstBrace >= tailStart) {
            return undefined;
        }
        return { op: 'if', tail: line.slice(tailStart), tailStart };
    }
    return undefined;
}

export interface CallContext {
    /** The function being called -- or, for `emit Picked(`, the event being raised. */
    name: string;
    /** 0-based index of the argument the cursor stands in. */
    argIndex: number;
    /**
     * `-> emit Picked(Index, ` -- the call is an event this file's `events` block declares, raised with arguments
     * that are binding expressions. Present only when true, so a plain call's context is the same object it was.
     */
    isEmit?: true;
}

/**
 * Which call's argument list the cursor is inside, given the text of the expression up TO the
 * cursor. Parens are what make a call, exactly as in the compiler's grammar, so a `(` with no
 * identifier in front of it is a grouped subexpression: its commas belong to it and not to the
 * call it sits inside, but the cursor is still that call's argument, which is why the search
 * walks outward to the nearest NAMED frame instead of giving up on the innermost one.
 */
export function callContextAt(expressionUpToCursor: string): CallContext | undefined {
    const tokens = scan(expressionUpToCursor).tokens;
    const frames: { name?: string; argIndex: number; isEmit: boolean }[] = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === 'openParen') {
            const previous = index > 0 ? tokens[index - 1] : undefined;
            const beforeName = index > 1 ? tokens[index - 2] : undefined;
            frames.push({
                name: previous?.kind === 'identifier' ? previous.text : undefined,
                argIndex: 0,
                isEmit: previous?.kind === 'identifier' && beforeName?.kind === 'identifier' && beforeName.text === 'emit',
            });
        } else if (token.kind === 'closeParen') {
            frames.pop();
        } else if (token.kind === 'comma' && frames.length > 0) {
            frames[frames.length - 1].argIndex++;
        }
    }
    for (let depth = frames.length - 1; depth >= 0; depth--) {
        const frame = frames[depth];
        if (frame.name) {
            return frame.isEmit
                ? { name: frame.name, argIndex: frame.argIndex, isEmit: true }
                : { name: frame.name, argIndex: frame.argIndex };
        }
    }
    return undefined;
}

export interface MemberPrefix {
    /** The identifier before the dot. */
    base: string;
    /** What has been typed after the dot so far, possibly empty. */
    typed: string;
    /** Index into `text` where `base` starts. */
    baseStart: number;
}

/** `Track.Ti` at the tail of an expression -- the shape `Item.` member completion answers. */
export function memberPrefixAt(text: string): MemberPrefix | undefined {
    const match = new RegExp('(' + NAME_HEAD + NAME_TAIL + '*)\\.(' + NAME_TAIL + '*)$', 'u').exec(text);
    if (!match || match.index === undefined) {
        return undefined;
    }
    // A dotted run longer than one hop (`A.B.`) leaves `B` as the base, which no `each` variable
    // will match -- and offering nothing is the right answer until chained members exist.
    return { base: match[1], typed: match[2], baseStart: match.index };
}

export interface EachScope {
    /** 'each' or 'for'. */
    keyword: string;
    /** The loop variable, as written. */
    variable: string;
    /** The source expression between `in` and `{`, trimmed. Empty when the header is unfinished. */
    sourceText: string;
    sourceStart: number;
    sourceEnd: number;
    bodyStart: number;
    bodyEnd: number;
}

export type EachSource =
    /** `each Entry in GetHistory()` -- the element type comes from the function's return type. */
    | { kind: 'call'; name: string }
    /** `each Track in Tracks` -- the element type comes from the variable's type. */
    | { kind: 'variable'; name: string };

/** What an `each` header iterates. Only the two shapes the compiler's own parser accepts. */
export function parseEachSource(sourceText: string): EachSource | undefined {
    const match = new RegExp('^(' + NAME_HEAD + NAME_TAIL + '*)\\s*(\\()?', 'u').exec(sourceText.trim());
    if (!match) {
        return undefined;
    }
    return { kind: match[2] ? 'call' : 'variable', name: match[1] };
}

/**
 * Every `each`/`for` in the file, with the source expression the structural layer walks past.
 * Recovered from tokens rather than re-lexed: `in` is the pivot, the loop's `{` is the end.
 */
export function eachScopesOf(structure: StructureResult & { tokens: Token[] }, source: string): EachScope[] {
    const indexByStart = new Map<number, number>();
    structure.tokens.forEach((token, index) => indexByStart.set(token.start, index));

    const out: EachScope[] = [];
    const visit = (node: StructNode): void => {
        if (node.kind === 'loop' && node.idStart !== undefined
            && node.bodyStart !== undefined && node.bodyEnd !== undefined) {
            const idIndex = indexByStart.get(node.idStart);
            const scope: EachScope = {
                keyword: node.tag, variable: node.id, sourceText: '',
                sourceStart: node.idStart, sourceEnd: node.idStart,
                bodyStart: node.bodyStart, bodyEnd: node.bodyEnd,
            };
            if (idIndex !== undefined) {
                const after = structure.tokens[idIndex + 1];
                if (after && after.kind === 'identifier' && after.text === 'in') {
                    let cursor = idIndex + 2;
                    const start = structure.tokens[cursor]?.start ?? after.end;
                    while (cursor < structure.tokens.length
                        && structure.tokens[cursor].kind !== 'openBrace'
                        && structure.tokens[cursor].kind !== 'end') {
                        cursor++;
                    }
                    const end = structure.tokens[cursor]?.start ?? start;
                    if (end >= start) {
                        scope.sourceStart = start;
                        scope.sourceEnd = end;
                        scope.sourceText = source.slice(start, end).trim();
                    }
                }
            }
            out.push(scope);
        }
        node.children.forEach(visit);
    };
    structure.roots.forEach(visit);
    return out;
}

/** The `each` scopes covering an offset, outermost first -- a nested loop shadows an outer one. */
export function enclosingEachScopes(scopes: EachScope[], offset: number): EachScope[] {
    return scopes.filter((scope) => scope.bodyStart <= offset && offset <= scope.bodyEnd);
}

/**
 * The innermost `each` whose variable is spelled `name`. Case sensitive, following the compiler:
 * DUI3008 compares loop variables that way, so two loops differing only in case really are two
 * different variables here.
 */
export function eachScopeNamed(scopes: EachScope[], offset: number, name: string): EachScope | undefined {
    const covering = enclosingEachScopes(scopes, offset).filter((scope) => scope.variable === name);
    return covering[covering.length - 1];
}

export interface SignatureLabel {
    label: string;
    /** Offsets into `label`, one per parameter, in declaration order. */
    parameters: [number, number][];
}

/**
 * `Format(Value: float, Digits: int32) : FText`. An editor too old to send `params` still says
 * how many there are, and a row of `…` placeholders is enough for the one thing signature help
 * is really for: which argument the cursor is on, out of how many.
 */
export function signatureLabelOf(info: BridgeFunctionInfo): SignatureLabel {
    const parts = info.params ?? Array.from({ length: Math.max(0, info.paramCount) }, () => undefined);
    const parameters: [number, number][] = [];
    let label = `${info.name}(`;
    parts.forEach((param, index) => {
        if (index > 0) {
            label += ', ';
        }
        const text = param ? `${param.name}: ${param.type}` : '…';
        parameters.push([label.length, label.length + text.length]);
        label += text;
    });
    label += ')';
    if (info.returnType) {
        label += ` : ${info.returnType}`;
    }
    return { label, parameters };
}

/** Case-insensitive, as every name in this language becomes an FName downstream. */
export function findByName<T extends { name: string }>(list: readonly T[], name: string): T | undefined {
    const wanted = name.toLowerCase();
    return list.find((entry) => entry.name.toLowerCase() === wanted);
}

/** Guards the places that would otherwise send the bridge a question about punctuation. */
export function isIdentifier(text: string): boolean {
    return IDENTIFIER.test(text);
}
