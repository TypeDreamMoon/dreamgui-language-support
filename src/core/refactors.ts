/**
 * The three extract/inline refactors, planned as pure edit lists over the structure.
 *
 *   - extract a literal to a resource: the literal becomes `@Name`, the value moves to the
 *     resources block verbatim; optionally every same-kind same-text literal in single-value
 *     position goes with it;
 *   - extract properties to a style: whole `Name = Value` lines leave the node for a new style
 *     the node then wears -- @slot lines, bindings and events stay, they are not style material;
 *   - inline a style: the worn chain (base first, derived overriding) lands back in the node,
 *     minus what the node already sets, and the `: Style` clause goes away. The declaration
 *     stays: other nodes may wear it.
 *
 * Every plan is verified by its tests the only way that matters: apply, re-parse clean, and the
 * built skeleton says the same thing it said before the refactor.
 */

import { buildStructure, StructNode, StyleDecl, PropertyStmt, StructComponent } from './structure';
import { RenameEdit, isValidName } from './rename';
import { planResourceEntryInsertion, planStyleInsertion } from './quickfixes';
import { tagEndOf } from './componentIntel';

export type Built = ReturnType<typeof buildStructure>;
export type RefactorPlan = { edits: RenameEdit[] } | { error: string };

const fold = (name: string): string => name.toLowerCase();

function allNodes(built: Built): StructNode[] {
    const out: StructNode[] = [];
    const visit = (node: StructNode): void => {
        out.push(node);
        node.children.forEach(visit);
    };
    built.roots.forEach(visit);
    return out;
}

// ---- extract literal -> resource ---------------------------------------------------------------

export interface ExtractableLiteral {
    start: number;
    end: number;
    /** The literal as written, '#'/quotes included. */
    text: string;
    resourceType: 'Color' | 'Number' | 'String' | 'Asset';
}

const LITERAL_TYPES: Record<string, ExtractableLiteral['resourceType']> = {
    hexColor: 'Color', number: 'Number', string: 'String', assetPath: 'Asset',
};

/** Every offset span sitting in a single-value position of some property statement. */
function valueSpans(built: Built): { start: number; end: number }[] {
    const out: { start: number; end: number }[] = [];
    // `@fill 2` is no value position: its weight is a number by grammar, and `@fill @Weight` is not a line the
    // parser reads. Every other statement with an '=' is, slot lines included.
    const take = (stmt: PropertyStmt): void => {
        if (stmt.op === 'equals' && stmt.shorthand === undefined
            && stmt.valueStart !== undefined && stmt.valueEnd !== undefined) {
            out.push({ start: stmt.valueStart, end: stmt.valueEnd });
        }
    };
    for (const node of allNodes(built)) {
        node.properties.forEach(take);
    }
    for (const style of built.styles) {
        style.properties.forEach(take);
    }
    return out;
}

/** The literal under the cursor, when it sits alone as a property value. */
export function extractableLiteralAt(built: Built, source: string, offset: number): ExtractableLiteral | undefined {
    const spans = valueSpans(built);
    for (const token of built.tokens) {
        const type = LITERAL_TYPES[token.kind];
        if (!type || offset < token.start || offset > token.end) {
            continue;
        }
        // Alone in its value: the value span is exactly this token. A tuple element or a
        // multi-token value cannot become an @reference today.
        const home = spans.find((span) => span.start === token.start && span.end === token.end);
        if (!home) {
            return undefined;
        }
        return { start: token.start, end: token.end, text: source.slice(token.start, token.end), resourceType: type };
    }
    return undefined;
}

export function countMatchingLiterals(built: Built, source: string, literal: ExtractableLiteral): number {
    return matchingLiterals(built, source, literal).length;
}

function matchingLiterals(built: Built, source: string, literal: ExtractableLiteral): { start: number; end: number }[] {
    const spans = valueSpans(built);
    const out: { start: number; end: number }[] = [];
    for (const token of built.tokens) {
        if (LITERAL_TYPES[token.kind] !== literal.resourceType) {
            continue;
        }
        if (source.slice(token.start, token.end) !== literal.text) {
            continue;
        }
        if (spans.some((span) => span.start === token.start && span.end === token.end)) {
            out.push({ start: token.start, end: token.end });
        }
    }
    return out;
}

export function planExtractResource(built: Built, source: string, literal: ExtractableLiteral,
    name: string, replaceAll: boolean): RefactorPlan {
    const invalid = isValidName(name);
    if (invalid) {
        return { error: invalid };
    }
    if (built.resources.some((entry) => fold(entry.name) === fold(name))) {
        return { error: `资源 '${name}' 已经存在。` };
    }

    const insertion = planResourceEntryInsertion(built,
        `${literal.resourceType} ${name} = ${literal.text}`, source.length);
    const targets = replaceAll ? matchingLiterals(built, source, literal) : [literal];
    const edits: RenameEdit[] = targets.map((span) => ({
        start: span.start, end: span.end, newText: `@${name}`,
    }));
    edits.push({ start: insertion.offset, end: insertion.offset, newText: insertion.text });
    return { edits };
}

// ---- extract properties -> style ---------------------------------------------------------------

export function planExtractStyle(built: Built, source: string, selectionStart: number,
    selectionEnd: number, styleName: string): RefactorPlan {
    const invalid = isValidName(styleName);
    if (invalid) {
        return { error: invalid };
    }
    if (built.styles.some((style) => fold(style.name) === fold(styleName))) {
        return { error: `样式 '${styleName}' 已经存在。` };
    }

    // The innermost block whose body contains the selection -- and it has to be a NODE's: an `if` arm and a loop
    // body hold widgets only, and a slot's block lays out a hole whose clause sits after `default`.
    const owner = allNodes(built)
        .filter((node) => node.bodyStart !== undefined && node.bodyEnd !== undefined
            && node.bodyStart <= selectionStart && selectionEnd <= node.bodyEnd)
        .sort((a, b) => b.bodyStart! - a.bodyStart!)[0];
    if (!owner || owner.kind !== 'node') {
        return { error: '选区不在任何节点体内。' };
    }
    if (owner.styleName) {
        return { error: `节点已经穿着样式 '${owner.styleName}',先内联它或换个节点。` };
    }

    const chosen = owner.properties.filter((stmt) => stmt.start < selectionEnd && stmt.end > selectionStart);
    if (chosen.length === 0) {
        return { error: '选区里没有属性行。' };
    }
    if (chosen.some((stmt) => stmt.isSlot || stmt.op !== 'equals')) {
        return { error: '样式只承载普通的 Name = Value 行 —— @slot、绑定和事件路由不进样式。' };
    }

    const edits: RenameEdit[] = [];
    for (const stmt of chosen) {
        edits.push(deleteStatementLine(source, stmt));
    }

    const body = chosen.map((stmt) => `    ${source.slice(stmt.start, stmt.end)}`).join('\n');
    const insertion = planStyleInsertion(built, `style ${styleName} {\n${body}\n}`, source.length);
    edits.push({ start: insertion.offset, end: insertion.offset, newText: insertion.text });

    // After the id (or its `(was:)`), where a style clause goes. A node with no id takes the clause straight after
    // its type -- `HorizontalBox : Row {` is one of the two shapes an unnamed node may have.
    const clauseAnchor = owner.wasEnd
        ?? (owner.idStart !== undefined ? owner.idStart + owner.id.length
            : owner.anonymous ? tagEndOf(owner) : undefined);
    if (clauseAnchor === undefined) {
        return { error: '节点没有 id,先给它一个名字。' };
    }
    edits.push({ start: clauseAnchor, end: clauseAnchor, newText: ` : ${styleName}` });
    return { edits };
}

/** The whole line when the statement owns it (a trailing comment counts as its), else just the span. */
function deleteStatementLine(source: string, stmt: PropertyStmt): RenameEdit {
    // An '@slot' statement's span starts at the property path; the directive sits before it.
    const lineStart = source.lastIndexOf('\n', stmt.start - 1) + 1;
    const lineBreak = source.indexOf('\n', stmt.end);
    const lineEnd = lineBreak < 0 ? source.length : lineBreak + 1;
    const before = source.slice(lineStart, stmt.start).trim();
    const after = source.slice(stmt.end, lineBreak < 0 ? source.length : lineBreak).trim();
    const ownsLine = before === '' && (after === '' || after.startsWith('//'));
    return ownsLine
        ? { start: lineStart, end: lineEnd, newText: '' }
        : { start: stmt.start, end: stmt.end, newText: '' };
}

// ---- inline a style ----------------------------------------------------------------------------

/** The node whose `: Style` clause covers the offset, or undefined. */
export function wornStyleAt(built: Built, offset: number): StructNode | undefined {
    return allNodes(built).find((node) => node.styleName && node.styleNameStart !== undefined
        && offset >= node.styleNameStart && offset <= node.styleNameStart + node.styleName.length);
}


/**
 * What a style's slot line says, written back as the line it was: `@slot Padding = (0, 8, 0, 0)` -- a line of an
 * `@slot { … }` block becomes one such line each, which means the same -- or the `@fill` shorthand as written.
 */
function slotLineText(source: string, stmt: PropertyStmt): string {
    if (stmt.shorthand === 'fill') {
        const lineStart = source.lastIndexOf('\n', Math.max(0, stmt.start - 1)) + 1;
        const at = source.lastIndexOf('@fill', Math.max(stmt.start, stmt.end));
        if (at >= lineStart) {
            return source.slice(at, Math.max(stmt.end, at + '@fill'.length)).trim();
        }
        return '@fill';
    }
    const text = source.slice(stmt.start, stmt.end);
    // A slot statement's span starts at its property path; the directive sits before it.
    return text.startsWith('@') ? text : `@slot ${text}`;
}

/** `@fill` is `@slot SizeRule = Fill`: one key, so a node's own SizeRule line overrides the style's shorthand. */
const slotKey = (stmt: PropertyStmt): string => (stmt.shorthand === 'fill' ? 'sizerule' : fold(stmt.path));

/** A `+ Component { … }` block of a style, from its '+' to its '}', re-indented to sit in the node's body. */
function componentText(source: string, component: StructComponent, indent: string): string {
    const plus = source.lastIndexOf('+', component.start);
    const start = plus >= 0 ? plus : component.start;
    const end = component.bodyEnd !== undefined ? component.bodyEnd + 1 : component.start + component.name.length;
    const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const ownIndent = /^[ \t]*/.exec(source.slice(lineStart, start))?.[0] ?? '';
    return source.slice(start, end).split('\n')
        .map((line, index) => (index === 0 ? line : indent + (line.startsWith(ownIndent) ? line.slice(ownIndent.length) : line.trimStart())))
        .join('\n');
}

/**
 * Inline the worn chain into the node: base first, derived overriding, the node's own lines winning over all of it.
 * A style carries three kinds of line now, and each lands as the kind it is:
 *
 *   - widget lines (`FontSize = 18`), minus the paths the node sets itself;
 *   - slot lines (`@slot Padding = …`, `@fill`), minus the slot properties the node sets itself -- written as `@slot`
 *     lines, which is what they were; a style line copied without its directive would set the WIDGET's property;
 *   - `+ Component { … }` blocks, verbatim. A component the node (or another style of the chain) also writes is ONE
 *     object to the compiler -- the style's values first, the node's after -- and two blocks in one node would be two
 *     writers of one object; that merge is the author's to make, so it is refused rather than guessed.
 */
export function planInlineStyle(built: Built, source: string, node: StructNode): RefactorPlan {
    if (!node.styleName || node.styleNameStart === undefined) {
        return { error: '这个节点没有穿样式。' };
    }
    if (node.bodyStart === undefined || node.bodyEnd === undefined) {
        return { error: '节点没有块,没地方放内联出来的属性。' };
    }
    if (node.styleName.includes('.')) {
        return { error: `样式 '${node.styleName}' 来自命名空间库,只能内联本文件声明的样式。` };
    }

    // Walk the chain, worn style first. Refuse what the builder refuses.
    const chain: StyleDecl[] = [];
    const visited = new Set<StyleDecl>();
    let link = built.styles.find((style) => fold(style.name) === fold(node.styleName!));
    while (link) {
        if (visited.has(link)) {
            return { error: `样式 '${node.styleName}' 的继承成环,先修 DUI3015。` };
        }
        visited.add(link);
        chain.push(link);
        if (!link.base) {
            break;
        }
        const base: StyleDecl | undefined = built.styles.find((style) => fold(style.name) === fold(link!.base!));
        if (!base) {
            return { error: `样式 '${link.name}' 的基 '${link.base}' 本文件没有声明(DUI3004,或由 use 带进来),无法内联整条链。` };
        }
        link = base;
    }
    if (chain.length === 0) {
        return { error: `样式 '${node.styleName}' 不在本文件里声明(可能由 use 带进来),只能内联本文件声明的样式。` };
    }

    // Components first, as the builder applies them; one per class across the chain and the node.
    const components: StructComponent[] = [];
    const componentNames = new Set(node.components.map((component) => fold(component.name)));
    for (let index = chain.length - 1; index >= 0; index--) {
        for (const component of chain[index].components ?? []) {
            if (componentNames.has(fold(component.name))) {
                return { error: `样式里的 + ${component.name} 和节点(或链上另一个样式)的 + ${component.name} 是同一个对象,`
                    + '内联会把它拆成两个块 —— 先手动合并。' };
            }
            componentNames.add(fold(component.name));
            components.push(component);
        }
    }

    const effective = new Map<string, PropertyStmt>();
    const slotLines = new Map<string, PropertyStmt>();
    for (let index = chain.length - 1; index >= 0; index--) {
        for (const stmt of chain[index].properties) {
            if (stmt.op !== 'equals') {
                continue;
            }
            if (stmt.isSlot) {
                slotLines.set(slotKey(stmt), stmt);
            } else {
                effective.set(fold(stmt.path), stmt);
            }
        }
    }
    for (const own of node.properties) {
        if (own.op !== 'equals') {
            continue;
        }
        if (own.isSlot) {
            slotLines.delete(slotKey(own));
        } else {
            effective.delete(fold(own.path));
        }
    }

    const edits: RenameEdit[] = [];
    if (components.length + effective.size + slotLines.size > 0) {
        const headerLineStart = source.lastIndexOf('\n', node.start - 1) + 1;
        const headerIndent = /^[ \t]*/.exec(source.slice(headerLineStart, node.start))?.[0] ?? '';
        const indent = headerIndent + '    ';
        const lines = [
            ...components.map((component) => `${indent}${componentText(source, component, indent)}`),
            ...[...effective.values()].map((stmt) => `${indent}${source.slice(stmt.start, stmt.end)}`),
            ...[...slotLines.values()].map((stmt) => `${indent}${slotLineText(source, stmt)}`),
        ];

        const bodyLineStart = source.lastIndexOf('\n', node.bodyStart - 1) + 1;
        const singleLineBlock = bodyLineStart <= headerLineStart;
        if (singleLineBlock) {
            // `Text B : label {}` -- open the block up around the inlined lines.
            edits.push({
                start: node.bodyStart, end: node.bodyStart,
                newText: `\n${lines.join('\n')}\n${headerIndent}`,
            });
        } else {
            edits.push({ start: bodyLineStart, end: bodyLineStart, newText: `${lines.join('\n')}\n` });
        }
    }

    // Drop ` : Style` -- from the colon (and the space before it) to the name's end.
    const colon = source.lastIndexOf(':', node.styleNameStart);
    let clauseStart = colon;
    while (clauseStart > 0 && (source[clauseStart - 1] === ' ' || source[clauseStart - 1] === '\t')) {
        clauseStart--;
    }
    edits.push({ start: clauseStart, end: node.styleNameStart + node.styleName.length, newText: '' });
    return { edits };
}
