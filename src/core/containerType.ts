/**
 * `Widget Column { + VerticalBox { Spacing = 8 } … }` said the short way: `VerticalBox Column { Spacing = 8 … }`.
 *
 * Both spellings build the same thing. A bare-word type that names a layout container makes a plain UDreamWidget --
 * the class `Widget` makes, with no visual either way -- and puts that container on it before anything else
 * (DreamUITextBuilder.cpp, ResolveNodeClasses and BuildComponents), and the node's bare lines then reach the container
 * after the widget (BuildProperties). The designer's write-back already prints the short form for a widget it lays
 * out with a container (DreamUITextWriteBack.cpp), so two tools agree on it and the long form only survives in text
 * people wrote by hand.
 *
 * The rewrite is offered only where it provably changes nothing the compiler builds, which is a list of conditions
 * rather than a hope:
 *
 * - The container block is the node's FIRST `+` line and its only container, and no style the node wears adds a `+`
 *   line. The type's container is created first, so with anything ahead of it the creation order -- and with it the
 *   behaviours a panel pulls in, and the localization key of the container's lines -- would move.
 * - Every line in the block is a plain `Name = Value` the dump knows as a property of that container and NOT of the
 *   widget. A bare line goes to the widget first; a container property the widget also has would change owner.
 * - No bare line of the node, or of a style it wears, names a property of that container the widget does not have.
 *   Today such a line reaches a behaviour (or nothing); with the container in the candidates it would reach the
 *   container instead, which comes before the behaviours.
 * - Every style it wears is declared in this file, so all of the above can be checked. An imported style is someone
 *   else's text: no hint rather than a guess.
 * - The block's text can be moved without editing anything inside it: the `+` starts its line, the braces end theirs,
 *   no block comment lives inside (re-indenting one would edit the comment).
 *
 * Without a symbols dump there is no list of what a container or a widget has, and nothing is offered.
 *
 * No vscode import here, ever: src/core/ is the seam a future LSP server or another IDE reuses.
 */

import { scan } from './scanner';
import { PropertyStmt, StructComponent, StructNode, StyleDecl, buildStructure } from './structure';
import { RenameEdit } from './rename';

type Structure = ReturnType<typeof buildStructure>;

/** What the symbols dump says about the names involved, already reduced to sets. */
export interface LayoutFacts {
    /** Container tag -> the names of its properties (the dump's `tags[name].properties`). */
    containers: ReadonlyMap<string, ReadonlySet<string>>;
    /** The widget's own properties (the dump's `widgetProperties`), dotted names kept. */
    widgetProperties: ReadonlySet<string>;
}

interface DumpShape {
    tags: Readonly<Record<string, { kind?: string; properties?: readonly { name: string }[] }>>;
    widgetProperties: readonly { name: string }[];
}

/** Per dump object: the diagnostics refresh on every keystroke, and the dump only changes when it is reloaded. */
const factsByDump = new WeakMap<DumpShape, LayoutFacts | null>();

/** Facts out of a symbols dump, or undefined when it has nothing to judge with. */
export function layoutFactsFrom(symbols: DumpShape | undefined): LayoutFacts | undefined {
    if (!symbols) {
        return undefined;
    }
    const cached = factsByDump.get(symbols);
    if (cached !== undefined) {
        return cached ?? undefined;
    }
    const facts = computeFacts(symbols);
    factsByDump.set(symbols, facts ?? null);
    return facts;
}

function computeFacts(symbols: DumpShape): LayoutFacts | undefined {
    if (symbols.widgetProperties.length === 0) {
        return undefined;
    }
    const containers = new Map<string, ReadonlySet<string>>();
    for (const [name, info] of Object.entries(symbols.tags)) {
        if (info.kind === 'container' && info.properties && info.properties.length > 0) {
            containers.set(name, new Set(info.properties.map((property) => property.name)));
        }
    }
    if (containers.size === 0) {
        return undefined;
    }
    return { containers, widgetProperties: new Set(symbols.widgetProperties.map((property) => property.name)) };
}

export interface ContainerTypeRewrite {
    /** The `Widget` the hint underlines. */
    start: number;
    end: number;
    /** The container the type becomes. */
    container: string;
    /** The node's id, or '' for an unnamed one. */
    id: string;
    edits: RenameEdit[];
}

/** Every node in the file the rewrite applies to, in source order. */
export function containerTypeRewrites(structure: Structure, text: string, facts: LayoutFacts | undefined): ContainerTypeRewrite[] {
    if (!facts) {
        return [];
    }
    const blockComments = scan(text).comments.filter((comment) => text.startsWith('/*', comment.start));
    const out: ContainerTypeRewrite[] = [];
    const visit = (node: StructNode): void => {
        const rewrite = rewriteFor(node, structure, text, facts, blockComments);
        if (rewrite) {
            out.push(rewrite);
        }
        node.children.forEach(visit);
    };
    structure.roots.forEach(visit);
    return out.sort((a, b) => a.start - b.start);
}

/** The rewrite whose `Widget` covers `offset`, if any. */
export function containerTypeRewriteAt(structure: Structure, text: string, facts: LayoutFacts | undefined,
    offset: number): ContainerTypeRewrite | undefined {
    return containerTypeRewrites(structure, text, facts).find((rewrite) => offset >= rewrite.start && offset <= rewrite.end);
}

/** `Spacing` for `Spacing`, `Padding` for `Padding.Left`: the name a candidate is chosen by. */
const head = (path: string): string => path.split('.')[0];

/** A name the widget answers to, dotted or by its first segment (`AnchorData.SizeDelta` and `AnchorData`). */
function widgetHas(facts: LayoutFacts, path: string): boolean {
    if (facts.widgetProperties.has(path) || facts.widgetProperties.has(head(path))) {
        return true;
    }
    const prefix = `${head(path)}.`;
    for (const name of facts.widgetProperties) {
        if (name.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}

function rewriteFor(node: StructNode, structure: Structure, text: string, facts: LayoutFacts,
    blockComments: readonly { start: number; end: number }[]): ContainerTypeRewrite | undefined {
    if (node.kind !== 'node' || node.tag !== 'Widget' || node.rowKey !== undefined || node.bodyStart === undefined
        || node.bodyEnd === undefined || node.components.length === 0) {
        return undefined;
    }
    const first = node.components[0];
    const containerProps = facts.containers.get(first.name);
    if (!containerProps || node.components.some((component, index) => index > 0 && facts.containers.has(component.name))) {
        return undefined;
    }

    // The block's own lines: plain values of that container, nothing the widget would take instead.
    for (const property of first.properties ?? []) {
        if (!plainValue(property) || !containerProps.has(head(property.path)) || widgetHas(facts, property.path)) {
            return undefined;
        }
    }

    // The styles it wears, all of them local, none adding a `+` line.
    const chain = localStyleChain(node, structure);
    if (!chain || chain.some((style) => style.components.length > 0)) {
        return undefined;
    }

    // Nothing bare that would change owner once the container is a candidate.
    const bare = [...node.properties, ...chain.flatMap((style) => style.properties)]
        .filter((property) => !property.isSlot && !property.isRowCell);
    if (bare.some((property) => containerProps.has(head(property.path)) && !widgetHas(facts, property.path))) {
        return undefined;
    }

    const typeEnd = node.tagEnd ?? node.start + node.tag.length;
    if (text.slice(node.start, typeEnd) !== 'Widget') {
        return undefined;
    }
    const moved = moveBlockOut(first, node, text, blockComments);
    if (!moved) {
        return undefined;
    }
    return {
        start: node.start,
        end: typeEnd,
        container: first.name,
        id: node.anonymous ? '' : node.id,
        edits: [{ start: node.start, end: typeEnd, newText: first.name }, moved],
    };
}

function plainValue(property: PropertyStmt): boolean {
    return property.op === 'equals' && !property.isSlot && property.routeOperator === undefined
        && property.shorthand === undefined && !property.isRowCell;
}

/** The node's styles, bases first, when every one of them is declared in this file; undefined otherwise. */
function localStyleChain(node: StructNode, structure: Structure): StyleDecl[] | undefined {
    const byName = new Map(structure.styles.map((style) => [style.name, style]));
    const out: StyleDecl[] = [];
    const seen = new Set<string>();
    const walk = (name: string): boolean => {
        if (seen.has(name)) {
            return true;
        }
        seen.add(name);
        const style = byName.get(name);
        if (!style) {
            return false;
        }
        if (!style.bases.every((base) => walk(base.name))) {
            return false;
        }
        out.push(style);
        return true;
    };
    for (const ref of node.styles ?? []) {
        if (!walk(ref.name)) {
            return undefined;
        }
    }
    return out;
}

/** Start of the line holding `offset`. */
function lineStartOf(text: string, offset: number): number {
    let at = offset;
    while (at > 0 && text[at - 1] !== '\n' && text[at - 1] !== '\r') {
        at--;
    }
    return at;
}

/** One past the line break that ends the line holding `offset` (or the end of the text). */
function nextLineStart(text: string, offset: number): number {
    let at = offset;
    while (at < text.length && text[at] !== '\n' && text[at] !== '\r') {
        at++;
    }
    if (text.startsWith('\r\n', at)) {
        return at + 2;
    }
    return at < text.length ? at + 1 : at;
}

const isBlank = (line: string): boolean => /^[ \t]*$/.test(line);

/** The line's text without its break. */
function lineText(text: string, start: number): string {
    const end = nextLineStart(text, start);
    return text.slice(start, end).replace(/\r?\n$|\r$/, '');
}

/**
 * The edit that takes `+ Container { … }` out and leaves its lines where it stood, one level less indented -- or,
 * for an empty block, takes the line out together with a blank line it would leave doubled.
 */
function moveBlockOut(component: StructComponent, node: StructNode, text: string,
    blockComments: readonly { start: number; end: number }[]): RenameEdit | undefined {
    // The '+' before the name, alone at the start of its line.
    let plus = component.start - 1;
    while (plus >= 0 && (text[plus] === ' ' || text[plus] === '\t')) {
        plus--;
    }
    if (plus < 0 || text[plus] !== '+') {
        return undefined;
    }
    const lineStart = lineStartOf(text, plus);
    const indent = text.slice(lineStart, plus);
    if (!isBlank(indent)) {
        return undefined;
    }
    // The braces: the '{' after the name, the '}' at bodyEnd.
    let open = component.start + component.name.length;
    while (open < text.length && (text[open] === ' ' || text[open] === '\t')) {
        open++;
    }
    const close = component.bodyEnd;
    if (text[open] !== '{' || close === undefined || text[close] !== '}') {
        return undefined;
    }
    if (blockComments.some((comment) => comment.start < close && comment.end > open)) {
        return undefined;
    }
    const afterClose = nextLineStart(text, close);
    if (!isBlank(text.slice(close + 1, afterClose).replace(/\r?\n$|\r$/, ''))) {
        return undefined;
    }

    const inner = text.slice(open + 1, close);
    if (isBlank(inner)) {
        return removeLine(text, node, lineStart, afterClose);
    }

    if (lineStartOf(text, close) === lineStart) {
        // `+ VerticalBox { Spacing = 8 }`: the statement takes the '+'s place on the line.
        const lineBreak = text.slice(close + 1, afterClose).match(/\r?\n|\r/)?.[0] ?? '';
        return { start: lineStart, end: afterClose, newText: `${indent}${inner.trim()}${lineBreak}` };
    }

    // A block over several lines: '{' ends its line, '}' starts its own, the lines between move out.
    const restOfOpenLine = text.slice(open + 1, nextLineStart(text, open));
    if (!isBlank(restOfOpenLine.replace(/\r?\n$|\r$/, '')) || !isBlank(text.slice(lineStartOf(text, close), close))) {
        return undefined;
    }
    const bodyFrom = nextLineStart(text, open);
    const bodyTo = lineStartOf(text, close);
    const lines = text.slice(bodyFrom, bodyTo).match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)!.filter((line) => line.length > 0);
    const firstReal = lines.find((line) => !isBlank(line.replace(/\r?\n$|\r$/, '')));
    if (!firstReal) {
        return removeLine(text, node, lineStart, afterClose);
    }
    const bodyIndent = firstReal.match(/^[ \t]*/)![0];
    if (!bodyIndent.startsWith(indent) || bodyIndent.length === indent.length) {
        return undefined;
    }
    const unit = bodyIndent.slice(indent.length);
    const dedented: string[] = [];
    for (const line of lines) {
        const content = line.replace(/\r?\n$|\r$/, '');
        if (isBlank(content)) {
            dedented.push(line.slice(content.length));
        } else if (line.startsWith(indent + unit)) {
            dedented.push(indent + line.slice(indent.length + unit.length));
        } else {
            return undefined;
        }
    }
    return { start: lineStart, end: afterClose, newText: dedented.join('') };
}

/**
 * Takes [from, to) -- whole lines -- out, and with them one blank line that would otherwise be doubled, or left
 * hanging just inside the node's braces.
 */
function removeLine(text: string, node: StructNode, from: number, to: number): RenameEdit {
    let start = from;
    let end = to;
    // The line before: step back over its whole break, which is two characters in a CRLF file.
    let previousEnd = from - 1;
    if (previousEnd > 0 && text[previousEnd] === '\n' && text[previousEnd - 1] === '\r') {
        previousEnd--;
    }
    const previousStart = from > 0 ? lineStartOf(text, previousEnd) : -1;
    const previousBlank = previousStart >= 0 && isBlank(lineText(text, previousStart));
    const nextBlank = to < text.length && isBlank(lineText(text, to));
    const previousOpens = previousStart >= 0 && /\{[ \t]*$/.test(lineText(text, previousStart));
    const nextCloses = to < text.length && node.bodyEnd !== undefined && lineStartOf(text, node.bodyEnd) === to;
    if (previousBlank && (nextBlank || nextCloses)) {
        start = previousStart;
    } else if (nextBlank && previousOpens) {
        end = nextLineStart(text, to);
    }
    return { start, end, newText: '' };
}
