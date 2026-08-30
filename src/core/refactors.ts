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

import { buildStructure, StructNode, StyleDecl, PropertyStmt } from './structure';
import { RenameEdit, isValidName } from './rename';
import { planResourceEntryInsertion, planStyleInsertion } from './quickfixes';

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
    for (const node of allNodes(built)) {
        for (const stmt of node.properties) {
            if (stmt.op === 'equals' && stmt.valueStart !== undefined && stmt.valueEnd !== undefined) {
                out.push({ start: stmt.valueStart, end: stmt.valueEnd });
            }
        }
    }
    for (const style of built.styles) {
        for (const stmt of style.properties) {
            if (stmt.op === 'equals' && stmt.valueStart !== undefined && stmt.valueEnd !== undefined) {
                out.push({ start: stmt.valueStart, end: stmt.valueEnd });
            }
        }
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

    // The innermost node whose body contains the selection.
    const owner = allNodes(built)
        .filter((node) => node.bodyStart !== undefined && node.bodyEnd !== undefined
            && node.bodyStart <= selectionStart && selectionEnd <= node.bodyEnd)
        .sort((a, b) => b.bodyStart! - a.bodyStart!)[0];
    if (!owner) {
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

    const clauseAnchor = owner.wasEnd ?? (owner.idStart !== undefined ? owner.idStart + owner.id.length : undefined);
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

export function planInlineStyle(built: Built, source: string, node: StructNode): RefactorPlan {
    if (!node.styleName || node.styleNameStart === undefined) {
        return { error: '这个节点没有穿样式。' };
    }
    if (node.bodyStart === undefined || node.bodyEnd === undefined) {
        return { error: '节点没有块,没地方放内联出来的属性。' };
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
            return { error: `样式 '${link.name}' 的基 '${link.base}' 没有声明,先修 DUI3004。` };
        }
        link = base;
    }
    if (chain.length === 0) {
        return { error: `样式 '${node.styleName}' 没有声明。` };
    }

    // Base first, derived overriding: iterate the chain from its root, later writes win. Then the
    // node's own lines win over all of it -- drop what the node already sets.
    const effective = new Map<string, PropertyStmt>();
    for (let index = chain.length - 1; index >= 0; index--) {
        for (const stmt of chain[index].properties) {
            if (stmt.op === 'equals') {
                effective.set(fold(stmt.path), stmt);
            }
        }
    }
    for (const own of node.properties) {
        if (!own.isSlot && own.op === 'equals') {
            effective.delete(fold(own.path));
        }
    }

    const edits: RenameEdit[] = [];
    if (effective.size > 0) {
        const headerLineStart = source.lastIndexOf('\n', node.start - 1) + 1;
        const headerIndent = /^[ \t]*/.exec(source.slice(headerLineStart, node.start))?.[0] ?? '';
        const indent = headerIndent + '    ';
        const lines = [...effective.values()]
            .map((stmt) => `${indent}${source.slice(stmt.start, stmt.end)}`);

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
