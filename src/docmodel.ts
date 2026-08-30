/**
 * A line-oriented sketch of one .dui: enough structure for completion context, the outline, and the
 * cheap diagnostics -- deliberately NOT the real parser. The compiler owns the grammar; this only
 * has to answer "what block am I standing in" fast enough to run on every keystroke, and to be
 * wrong in no way worse than offering a completion the compiler then refuses with a real message.
 */
import * as vscode from 'vscode';

export interface NodeScope {
    kind: 'node' | 'component' | 'resources' | 'style' | 'loop';
    /** Node tag ("Text"), component name ("VerticalBox" or "/Script/..."), style name. */
    name: string;
    /** Node id, when the scope is a node. */
    id?: string;
    line: number;
}

export interface ResourceEntry {
    type: string;
    name: string;
    valueText: string;
    line: number;
    nameStart: number;
}

export interface StyleEntry {
    name: string;
    base?: string;
    line: number;
    nameStart: number;
}

export interface DocModel {
    resources: ResourceEntry[];
    styles: StyleEntry[];
    /** '@Name' uses: [line, character of '@', name]. */
    resourceRefs: { line: number; character: number; name: string }[];
    /** Root nodes for the outline, children nested. */
    outline: OutlineNode[];
    braceBalance: number;
    firstUnmatchedClose?: vscode.Position;
}

export interface OutlineNode {
    tag: string;
    id: string;
    line: number;
    children: OutlineNode[];
}

const NODE_HEADER = /^\s*([A-Za-z_/][\w/.]*)\s+([A-Za-z_ -￿][\w -￿]*)\s*(?:\(|:|\{|$)/u;
const COMPONENT = /^\s*\+\s*([A-Za-z_/][\w/.]*)/;
const RESOURCE_ENTRY = /^\s*(Color|Number|Vector2|String|Asset)\s+([A-Za-z_ -￿][\w -￿]*)\s*=\s*(.*?)\s*$/u;
const STYLE_DECL = /^\s*style\s+([A-Za-z_ -￿][\w -￿]*)(?:\s*:\s*([A-Za-z_ -￿][\w -￿]*))?/u;
const RESOURCE_REF = /@([A-Za-z_ -￿][\w -￿]*)/gu;
const KEYWORDS = new Set(['class', 'style', 'resources', 'slot', 'for', 'each', 'in', 'was']);

function stripComment(line: string): string {
    // Good enough: '//' inside a string is rare in UI copy, and being wrong only mutes one line's
    // model. Block comments are handled by the caller's in-comment flag.
    const index = line.indexOf('//');
    return index >= 0 ? line.slice(0, index) : line;
}

export function buildModel(document: vscode.TextDocument): DocModel {
    const model: DocModel = { resources: [], styles: [], resourceRefs: [], outline: [], braceBalance: 0 };
    const scopeStack: (OutlineNode | null)[] = [];
    let inResources = false;
    let inBlockComment = false;
    let depth = 0;
    let resourcesDepth = -1;

    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
        let text = document.lineAt(lineIndex).text;
        if (inBlockComment) {
            const end = text.indexOf('*/');
            if (end < 0) {
                continue;
            }
            text = text.slice(end + 2);
            inBlockComment = false;
        }
        const blockStart = text.indexOf('/*');
        if (blockStart >= 0 && text.indexOf('*/', blockStart) < 0) {
            text = text.slice(0, blockStart);
            inBlockComment = true;
        }
        text = stripComment(text);

        // Refs anywhere on the line, but not the '@slot'/'@key' directives.
        for (const match of text.matchAll(RESOURCE_REF)) {
            const name = match[1];
            if (name !== 'slot' && name !== 'key') {
                model.resourceRefs.push({ line: lineIndex, character: match.index ?? 0, name });
            }
        }

        if (inResources) {
            const entry = RESOURCE_ENTRY.exec(text);
            if (entry) {
                model.resources.push({
                    type: entry[1],
                    name: entry[2],
                    valueText: entry[3],
                    line: lineIndex,
                    nameStart: text.indexOf(entry[2], text.indexOf(entry[1]) + entry[1].length),
                });
            }
        } else {
            const style = STYLE_DECL.exec(text);
            if (style) {
                model.styles.push({
                    name: style[1],
                    base: style[2],
                    line: lineIndex,
                    nameStart: text.indexOf(style[1]),
                });
            } else if (/^\s*resources\b/.test(text)) {
                inResources = true;
                resourcesDepth = depth;
            } else {
                const header = NODE_HEADER.exec(text);
                if (header && !KEYWORDS.has(header[1]) && !COMPONENT.test(text) && text.includes('{')) {
                    const node: OutlineNode = { tag: header[1], id: header[2], line: lineIndex, children: [] };
                    const parent = [...scopeStack].reverse().find((entry) => entry !== null);
                    (parent ? parent.children : model.outline).push(node);
                    scopeStack.push(node);
                    // The '{' this header carries is accounted below with everyone else's; the stack
                    // entry pairs with it because a header without '{' did not match.
                    depth += countBraces(text);
                    model.braceBalance += countBraces(text);
                    continue;
                }
            }
        }

        for (const char of text) {
            if (char === '{') {
                depth++;
                model.braceBalance++;
                scopeStack.push(null);
            } else if (char === '}') {
                depth--;
                model.braceBalance--;
                scopeStack.pop();
                if (inResources && depth <= resourcesDepth) {
                    inResources = false;
                }
                if (model.braceBalance < 0 && !model.firstUnmatchedClose) {
                    model.firstUnmatchedClose = new vscode.Position(lineIndex, Math.max(0, text.indexOf('}')));
                }
            }
        }
    }
    return model;
}

function countBraces(text: string): number {
    let count = 0;
    for (const char of text) {
        if (char === '{') count++;
        else if (char === '}') count--;
    }
    return count;
}

/**
 * The innermost scope at a position, answered by scanning upward: the nearest unclosed header.
 * Line-based and approximate, which is the right trade for completion context.
 */
export function scopeAt(document: vscode.TextDocument, position: vscode.Position): NodeScope | undefined {
    let depth = 0;
    for (let lineIndex = position.line; lineIndex >= 0; lineIndex--) {
        const raw = stripComment(document.lineAt(lineIndex).text);
        const text = lineIndex === position.line ? raw.slice(0, position.character) : raw;
        for (let i = text.length - 1; i >= 0; i--) {
            if (text[i] === '}') depth++;
            else if (text[i] === '{') {
                if (depth > 0) {
                    depth--;
                    continue;
                }
                // This '{' opens the block the position stands in; classify its header.
                const header = text.slice(0, i);
                if (/^\s*resources\b/.test(header)) {
                    return { kind: 'resources', name: 'resources', line: lineIndex };
                }
                const style = /^\s*style\s+([\w -￿]+)/u.exec(header);
                if (style) {
                    return { kind: 'style', name: style[1], line: lineIndex };
                }
                const component = COMPONENT.exec(header);
                if (component) {
                    return { kind: 'component', name: component[1], line: lineIndex };
                }
                const loop = /^\s*(for|each)\b/.exec(header);
                if (loop) {
                    return { kind: 'loop', name: loop[1], line: lineIndex };
                }
                const node = NODE_HEADER.exec(header);
                if (node && !KEYWORDS.has(node[1])) {
                    return { kind: 'node', name: node[1], id: node[2], line: lineIndex };
                }
                // An anonymous '{' (should not happen in this grammar): keep walking up.
            }
        }
    }
    return undefined;
}
