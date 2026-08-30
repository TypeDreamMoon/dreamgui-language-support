/**
 * Rename planning. Styles and resources rename as plain text surgery (declaration plus every
 * use, file-local by language rule). A node id is more than a word: it is the node's identity --
 * guid, member variable, binding key and localization key at once -- and the language has its own
 * migration syntax for changing one. So renaming an id WRITES that syntax:
 *
 *   - no '(was:)' yet        -> the clause is added, naming the old id, so the next compile
 *                               migrates graph references, bindings and animations;
 *   - a '(was: X)' already   -> kept as is: X is the last compiled name, and that is what the
 *                               migration must keep pointing at through any number of edits;
 *   - renaming BACK to X     -> the clause is removed; the migration cancels itself.
 *
 * Localization keys derive from the id and '(was:)' cannot migrate translations -- the caller is
 * told to surface that (the @key advice), it is not this layer's popup to show.
 */

import { StructureResult, StructNode } from './structure';
import { RESERVED_WORDS } from './scanner';

export interface RenameEdit {
    start: number;
    end: number;
    newText: string;
}

export type RenameTargetKind = 'id' | 'style' | 'resource' | 'loopVariable';

export interface RenameTarget {
    kind: RenameTargetKind;
    name: string;
    /** The exact span F2 highlights. */
    start: number;
    end: number;
}

export interface RenamePlan {
    edits: RenameEdit[];
    /** True for id renames: localization keys change with the id, translations orphan. */
    localizationKeysChange: boolean;
}

const fold = (name: string): string => name.toLowerCase();

/** Why `name` cannot be a .dui name, or undefined when it can. Shared with the refactors. */
export function isValidName(name: string): string | undefined {
    if (name.length === 0) {
        return '名字不能为空。';
    }
    if (RESERVED_WORDS.has(name)) {
        return `'${name}' 是关键字,不能用作名字。`;
    }
    const first = name.charCodeAt(0);
    if (first >= 0x30 && first <= 0x39) {
        return '名字不能以数字开头 —— 生成的成员变量会被加前缀,绑定就找不到它了。';
    }
    for (let index = 0; index < name.length; index++) {
        const code = name.charCodeAt(index);
        const ok = (code >= 0x30 && code <= 0x39) || code === 0x5f
            || (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || code > 0x7f;
        if (!ok) {
            return `'${name[index]}' 不能出现在名字里。`;
        }
    }
    return undefined;
}

function allNodes(structure: StructureResult): StructNode[] {
    const out: StructNode[] = [];
    const visit = (node: StructNode): void => {
        out.push(node);
        node.children.forEach(visit);
    };
    structure.roots.forEach(visit);
    return out;
}

/** The renameable thing at an offset, or undefined where F2 has nothing to grab. */
export function renameTargetAt(structure: StructureResult, offset: number): RenameTarget | undefined {
    for (const node of allNodes(structure)) {
        if (node.idStart !== undefined && node.id
            && offset >= node.idStart && offset <= node.idStart + node.id.length) {
            return {
                kind: node.kind === 'loop' ? 'loopVariable' : 'id',
                name: node.id, start: node.idStart, end: node.idStart + node.id.length,
            };
        }
    }
    for (const style of structure.styles) {
        if (offset >= style.nameStart && offset <= style.nameStart + style.name.length) {
            return { kind: 'style', name: style.name, start: style.nameStart, end: style.nameStart + style.name.length };
        }
        if (style.base && style.baseStart !== undefined
            && offset >= style.baseStart && offset <= style.baseStart + style.base.length) {
            return { kind: 'style', name: style.base, start: style.baseStart, end: style.baseStart + style.base.length };
        }
    }
    for (const node of allNodes(structure)) {
        if (node.styleName && node.styleNameStart !== undefined
            && offset >= node.styleNameStart && offset <= node.styleNameStart + node.styleName.length) {
            return {
                kind: 'style', name: node.styleName,
                start: node.styleNameStart, end: node.styleNameStart + node.styleName.length,
            };
        }
    }
    for (const resource of structure.resources) {
        if (offset >= resource.nameStart && offset <= resource.nameStart + resource.name.length) {
            return {
                kind: 'resource', name: resource.name,
                start: resource.nameStart, end: resource.nameStart + resource.name.length,
            };
        }
    }
    for (const ref of structure.resourceRefs) {
        // start is the '@'; the name begins one past it.
        if (offset >= ref.start && offset <= ref.start + 1 + ref.name.length) {
            return { kind: 'resource', name: ref.name, start: ref.start + 1, end: ref.start + 1 + ref.name.length };
        }
    }
    return undefined;
}

export function planRename(structure: StructureResult, target: RenameTarget, newName: string):
    RenamePlan | { error: string } {
    const invalid = isValidName(newName);
    if (invalid) {
        return { error: invalid };
    }
    if (newName === target.name) {
        return { error: '新名字和旧名字相同。' };
    }
    if (fold(newName) === fold(target.name)) {
        // Case-only "renames" are refused for names: FName does not distinguish case, so nothing
        // downstream would change -- but the (was:) machinery would still fire. Not worth it.
        return { error: '名字按 FName 语义比较,只改大小写等于没改。' };
    }

    const nodes = allNodes(structure);

    if (target.kind === 'id' || target.kind === 'loopVariable') {
        const node = nodes.find((candidate) => candidate.idStart === target.start);
        if (!node) {
            return { error: '找不到要改名的节点。' };
        }
        if (target.kind === 'id') {
            const clash = nodes.find((other) => other !== node && other.kind !== 'loop'
                && fold(other.id) === fold(newName));
            if (clash) {
                return { error: `'${newName}' 已经是第 ${clash.line} 行节点的 id(名字不区分大小写)。` };
            }
        }

        const edits: RenameEdit[] = [{ start: target.start, end: target.end, newText: newName }];
        if (target.kind === 'id') {
            if (node.wasId !== undefined && node.wasStart !== undefined && node.wasEnd !== undefined) {
                if (fold(node.wasId) === fold(newName)) {
                    // Renaming back: the migration cancels itself. Eat one leading space so the
                    // header does not keep a double gap.
                    const eatSpace = node.wasStart > 0 ? 1 : 0;
                    edits.push({ start: node.wasStart - eatSpace, end: node.wasEnd, newText: '' });
                }
                // Otherwise the clause stays: it names the last COMPILED id, which is what the
                // migration must keep pointing at through any number of edits.
            } else {
                edits.push({ start: target.end, end: target.end, newText: ` (was: ${target.name})` });
            }
        }
        return { edits, localizationKeysChange: target.kind === 'id' };
    }

    if (target.kind === 'style') {
        const clash = structure.styles.find((style) => fold(style.name) === fold(newName));
        if (clash) {
            return { error: `样式 '${newName}' 已经存在(名字不区分大小写)。` };
        }
        const wanted = fold(target.name);
        const edits: RenameEdit[] = [];
        for (const style of structure.styles) {
            if (fold(style.name) === wanted) {
                edits.push({ start: style.nameStart, end: style.nameStart + style.name.length, newText: newName });
            }
            if (style.base && style.baseStart !== undefined && fold(style.base) === wanted) {
                edits.push({ start: style.baseStart, end: style.baseStart + style.base.length, newText: newName });
            }
        }
        for (const node of nodes) {
            if (node.styleName && node.styleNameStart !== undefined && fold(node.styleName) === wanted) {
                edits.push({
                    start: node.styleNameStart, end: node.styleNameStart + node.styleName.length, newText: newName,
                });
            }
        }
        return { edits, localizationKeysChange: false };
    }

    // resource
    const clash = structure.resources.find((entry) => fold(entry.name) === fold(newName));
    if (clash) {
        return { error: `资源 '${newName}' 已经存在(名字不区分大小写)。` };
    }
    const wanted = fold(target.name);
    const edits: RenameEdit[] = [];
    for (const resource of structure.resources) {
        if (fold(resource.name) === wanted) {
            edits.push({ start: resource.nameStart, end: resource.nameStart + resource.name.length, newText: newName });
        }
    }
    for (const ref of structure.resourceRefs) {
        if (fold(ref.name) === wanted) {
            edits.push({ start: ref.start + 1, end: ref.start + 1 + ref.name.length, newText: newName });
        }
    }
    return { edits, localizationKeysChange: false };
}

export function applyRenameEdits(source: string, edits: RenameEdit[]): string {
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    let out = source;
    for (const edit of sorted) {
        out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
    }
    return out;
}
