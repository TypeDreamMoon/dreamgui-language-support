/**
 * Each language's translation of a .dui string, read from the DreamLoc `.dloc` files beside the project -- read only;
 * nothing here depends on DreamLoc being installed. A .dui text's entry is the one whose key is the text's key and whose
 * `at` is `<the .dui, relative to its owner>#<node path>`, in `DLoc/<culture>/<the .dui's path without .dui>.dloc`.
 */
import { StructNode, StructureResult } from './structure';

export interface DuiTextAt {
    /** The node's ids from below the root, joined with '/'; the root's own text has the root's id. */
    nodePath: string;
    /** `<id>.<property>`, or the `@key("…")` written after the string. */
    key: string;
    /** The string as written, quotes off. */
    source: string;
}

export interface DlocTranslation {
    culture: string;
    text: string;
    /** 1-based line of the `text` field. */
    line: number;
    /** Made from an older source (it has a `prev`): the game shows the source until it is translated again. */
    stale: boolean;
    state?: string;
}

/**
 * The text whose string value the offset is in, as the compiler keys it: node path and key. Undefined when the offset
 * is not in a string value of a node's own property.
 */
export function textAt(structure: StructureResult, text: string, offset: number): DuiTextAt | undefined {
    for (const root of structure.roots) {
        const found = findIn(root, root.id, true, text, offset);
        if (found) {
            return found;
        }
    }
    return undefined;
}

function findIn(node: StructNode, path: string, isRoot: boolean, text: string, offset: number): DuiTextAt | undefined {
    for (const property of node.properties) {
        if (property.isSlot || property.op !== 'equals' || property.valueStart === undefined || property.valueEnd === undefined) {
            continue;
        }
        if (offset < property.valueStart || offset > property.valueEnd || text[property.valueStart] !== '"') {
            continue;
        }
        // The value's span runs over the annotations after the string; the string is its start.
        const value = text.slice(property.valueStart, Math.max(property.valueEnd, lineEnd(text, property.valueStart)));
        const quoted = /^"(?:[^"\\]|\\.)*"/.exec(value);
        if (!quoted || offset > property.valueStart + quoted[0].length) {
            continue;
        }
        const source = unquote(quoted[0]);
        const rest = value.slice(quoted[0].length);
        const override = /^(?:\s*@\w+(?:\([^)]*\))?)*?\s*@key\(\s*"((?:[^"\\]|\\.)*)"\s*\)/.exec(rest);
        if (/^(?:\s*@\w+(?:\([^)]*\))?)*?\s*@noloc\b/.test(rest)) {
            return undefined;
        }
        return { nodePath: path, key: override ? unquote(`"${override[1]}"`) : `${node.id}.${property.path}`, source };
    }
    for (const child of node.children) {
        // A loop or an `if` arm has no id of its own: what it makes sits where it is.
        const seeThrough = child.kind === 'loop' || child.kind === 'branch' || !child.id;
        const childPath = seeThrough ? path : (isRoot ? child.id : `${path}/${child.id}`);
        const found = findIn(child, childPath, seeThrough ? isRoot : false, text, offset);
        if (found) {
            return found;
        }
    }
    return undefined;
}

function lineEnd(text: string, from: number): number {
    const end = text.indexOf('\n', from);
    return end < 0 ? text.length : end;
}

/** A quoted string's text, the escapes .dui and .dloc share resolved. */
export function unquote(quoted: string): string {
    const body = quoted.startsWith('"') && quoted.endsWith('"') && quoted.length >= 2 ? quoted.slice(1, -1) : quoted;
    return body.replace(/\\(u\{[0-9A-Fa-f]+\}|.)/g, (_, escaped: string) => {
        switch (escaped[0]) {
            case 'n': return '\n';
            case 't': return '\t';
            case 'r': return '\r';
            case 'u': return escaped.length > 1 ? String.fromCodePoint(parseInt(escaped.slice(2, -1), 16)) : '\\u';
            case '"': case '\\': return escaped;
            // Not an escape: .dloc keeps both characters, and so does .dui.
            default: return `\\${escaped}`;
        }
    });
}

/** The .dloc that holds a .dui's translations, relative to the owner: `DLoc/<culture>/DUI/UI/Settings.dloc`. */
export function dlocPathOf(duiSource: string, culture: string): string {
    return `DLoc/${culture}/${duiSource.replace(/\.dui$/i, '')}.dloc`;
}

/** The entry of one .dloc file for this key and `at`, outside its removed blocks. */
export function findEntry(dloc: string, key: string, at: string): Omit<DlocTranslation, 'culture'> | undefined {
    const lines = dloc.split(/\r?\n/);
    let depth = 0;
    let inRemoved = false;
    let current: { key: string; at?: string; text?: string; line: number; stale: boolean; state?: string } | undefined;
    for (let index = 0; index < lines.length; index++) {
        // A comment is a line of its own or follows a `{` / `}`; a `//` inside a quoted text (a URL) is text.
        const line = lines[index].trim();
        if (line === '' || line.startsWith('//')) {
            continue;
        }
        if (depth === 0 && /^removed\s*\{\s*(?:\/\/.*)?$/.test(line)) {
            inRemoved = true;
            depth = 1;
            continue;
        }
        const open = /^(\S+)\s*\{\s*(?:\/\/.*)?$/.exec(line);
        if (open && !current) {
            current = { key: open[1], line: 0, stale: false };
            depth++;
            continue;
        }
        if (/^\}\s*(?:\/\/.*)?$/.test(line)) {
            if (current) {
                if (!inRemoved && current.key === key && current.at === at && current.text !== undefined) {
                    return { text: current.text, line: current.line, stale: current.stale, state: current.state };
                }
                current = undefined;
            }
            depth = Math.max(0, depth - 1);
            if (depth === 0) {
                inRemoved = false;
            }
            continue;
        }
        if (!current) {
            continue;
        }
        const field = /^(at|text|prev|state)\s+(.*)$/.exec(line);
        if (!field) {
            continue;
        }
        if (field[1] === 'at') {
            current.at = field[2].split(/\s+/)[0];
        } else if (field[1] === 'text') {
            const quoted = /^"(?:[^"\\]|\\.)*"/.exec(field[2]);
            current.text = quoted ? unquote(quoted[0]) : '';
            current.line = index + 1;
        } else if (field[1] === 'prev') {
            current.stale = true;
        } else {
            current.state = field[2].split(/\s+/)[0];
        }
    }
    return undefined;
}
