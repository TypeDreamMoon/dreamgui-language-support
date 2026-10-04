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
 * A node written WITHOUT an id is the exception, and the plugin's write-back sets the rule: its
 * made-up id (`Root__HorizontalBox0`) named a hidden member nothing references, so naming it
 * writes the new id after its type and nothing else -- `(was:)` on an unnamed node is DUI2004.
 *
 * The names the component grammar added rename in-file, declaration and every use:
 *
 *   - an alias (`use "…" as Row`) -> the `as` name, every node typed `Row`, and -- for a namespace --
 *     every `Row.` prefix on a type, a style clause or a resource reference;
 *   - a prop -> its `props` entry and every binding that reads it (a loop variable of the same
 *     name shadows it, and is left alone);
 *   - an event -> its `events` entry and every `emit` of it.
 *
 * Hosts in OTHER files set props and route events by these names; this layer plans one file's
 * edits, and the caller says so.
 *
 * Localization keys derive from the id and '(was:)' cannot migrate translations -- the caller is
 * told to surface that (the @key advice), it is not this layer's popup to show.
 */

import { StructureResult, StructNode } from './structure';
import { RESERVED_WORDS } from './scanner';
import { isBuiltInTypeName } from './vocabulary';
import { propReadBy, bindingHeadSpan, eventNamed, propNamed, tagEndOf } from './componentIntel';

export interface RenameEdit {
    start: number;
    end: number;
    newText: string;
}

export type RenameTargetKind =
    | 'id' | 'style' | 'resource' | 'loopVariable'
    /** A node with no id: naming it writes its first id after the type. */
    | 'anonymousNode'
    /** A `use … as` name: a component alias or a namespace. */
    | 'alias'
    | 'prop'
    | 'event'
    /** A host's `slot X { … }` fill: the name is the component's, and is refused here with the reason. */
    | 'slotFill';

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

/** A node's id as a class member: not a loop variable, not an `if` arm, not a fill naming another class's slot. */
function isMemberId(node: StructNode): boolean {
    return node.kind !== 'loop' && node.kind !== 'branch' && !(node.kind === 'namedSlot' && node.fillsSlot)
        && node.id.length > 0;
}

/** The `use … as` lines of this file: the aliases it declares, the only ones it can rename. */
function localAliases(structure: StructureResult): { name: string; start: number }[] {
    return structure.imports
        .filter((directive) => directive.alias && directive.aliasStart !== undefined)
        .map((directive) => ({ name: directive.alias!, start: directive.aliasStart! }));
}

const within = (offset: number, start: number | undefined, length: number): boolean =>
    start !== undefined && offset >= start && offset <= start + length;

/**
 * A dotted name (`nier.Label`, `nier.Row`) whose head is one of this file's aliases: the head's span when the
 * offset is on it. The tail names something the library declares, which is not this file's to rename.
 */
function aliasHeadAt(structure: StructureResult, written: string, start: number, offset: number): RenameTarget | undefined {
    const dot = written.indexOf('.');
    if (dot <= 0 || offset > start + dot) {
        return undefined;
    }
    const head = written.slice(0, dot);
    const alias = localAliases(structure).find((entry) => fold(entry.name) === fold(head));
    return alias ? { kind: 'alias', name: alias.name, start, end: start + dot } : undefined;
}

/** The renameable thing at an offset, or undefined where F2 has nothing to grab. */
export function renameTargetAt(structure: StructureResult, offset: number): RenameTarget | undefined {
    const nodes = allNodes(structure);
    for (const node of nodes) {
        if (node.idStart !== undefined && node.id && within(offset, node.idStart, node.id.length)) {
            const kind: RenameTargetKind = node.kind === 'loop' ? 'loopVariable'
                : node.kind === 'namedSlot' && node.fillsSlot ? 'slotFill' : 'id';
            return { kind, name: node.id, start: node.idStart, end: node.idStart + node.id.length };
        }
    }

    for (const alias of localAliases(structure)) {
        if (within(offset, alias.start, alias.name.length)) {
            return { kind: 'alias', name: alias.name, start: alias.start, end: alias.start + alias.name.length };
        }
    }

    // A node's type: the alias it names when it names one of this file's, else -- on a node with no id -- the node
    // itself, which F2 then names. An alias wins the token: the type is what the token spells.
    for (const node of nodes) {
        if (node.kind !== 'node' || !within(offset, node.start, tagEndOf(node) - node.start)) {
            continue;
        }
        const head = aliasHeadAt(structure, node.tag, node.start, offset);
        if (head) {
            return head;
        }
        const alias = localAliases(structure).find((entry) => fold(entry.name) === fold(node.tag));
        if (alias) {
            return { kind: 'alias', name: alias.name, start: node.start, end: tagEndOf(node) };
        }
        if (node.anonymous) {
            return { kind: 'anonymousNode', name: node.id, start: node.start, end: tagEndOf(node) };
        }
    }

    for (const style of structure.styles) {
        if (within(offset, style.nameStart, style.name.length)) {
            return { kind: 'style', name: style.name, start: style.nameStart, end: style.nameStart + style.name.length };
        }
        if (style.base && style.baseStart !== undefined && within(offset, style.baseStart, style.base.length)) {
            if (style.base.includes('.')) {
                return aliasHeadAt(structure, style.base, style.baseStart, offset);
            }
            return { kind: 'style', name: style.base, start: style.baseStart, end: style.baseStart + style.base.length };
        }
    }
    for (const node of nodes) {
        if (node.styleName && node.styleNameStart !== undefined
            && within(offset, node.styleNameStart, node.styleName.length)) {
            if (node.styleName.includes('.')) {
                return aliasHeadAt(structure, node.styleName, node.styleNameStart, offset);
            }
            return {
                kind: 'style', name: node.styleName,
                start: node.styleNameStart, end: node.styleNameStart + node.styleName.length,
            };
        }
    }
    for (const resource of structure.resources) {
        if (within(offset, resource.nameStart, resource.name.length)) {
            return {
                kind: 'resource', name: resource.name,
                start: resource.nameStart, end: resource.nameStart + resource.name.length,
            };
        }
    }
    for (const ref of structure.resourceRefs) {
        // start is the '@'; the name begins one past it.
        if (offset >= ref.start && offset <= ref.start + 1 + ref.name.length) {
            if (ref.name.includes('.')) {
                return aliasHeadAt(structure, ref.name, ref.start + 1, Math.max(offset, ref.start + 1));
            }
            return { kind: 'resource', name: ref.name, start: ref.start + 1, end: ref.start + 1 + ref.name.length };
        }
    }

    for (const prop of structure.props ?? []) {
        if (within(offset, prop.nameStart, prop.name.length)) {
            return { kind: 'prop', name: prop.name, start: prop.nameStart, end: prop.nameStart + prop.name.length };
        }
    }
    for (const event of structure.events ?? []) {
        if (within(offset, event.nameStart, event.name.length)) {
            return { kind: 'event', name: event.name, start: event.nameStart, end: event.nameStart + event.name.length };
        }
    }
    for (const binding of structure.bindings) {
        if (binding.isEmit && within(offset, binding.nameStart, binding.name.length)) {
            const event = eventNamed(structure, binding.name);
            return event ? {
                kind: 'event', name: event.name, start: binding.nameStart, end: binding.nameStart + binding.name.length,
            } : undefined;
        }
        const head = bindingHeadSpan(binding);
        if (binding.isVariable && offset >= head.start && offset <= head.end) {
            const prop = propReadBy(structure, binding);
            return prop ? { kind: 'prop', name: prop.name, start: head.start, end: head.end } : undefined;
        }
    }
    return undefined;
}

/** The names the class's members are made of -- ids, props, events -- minus the one being renamed. */
function memberClash(structure: StructureResult, newName: string, except: { kind: RenameTargetKind; name: string }):
    string | undefined {
    const wanted = fold(newName);
    for (const node of allNodes(structure)) {
        if (isMemberId(node) && fold(node.id) === wanted && !(except.kind === 'id' && fold(except.name) === wanted)) {
            return `'${newName}' 已经是第 ${node.line} 行节点的 id(名字不区分大小写)。`;
        }
    }
    if ((structure.props ?? []).some((prop) => fold(prop.name) === wanted)) {
        return `'${newName}' 已经是一个 prop 的名字(名字不区分大小写)。`;
    }
    if ((structure.events ?? []).some((event) => fold(event.name) === wanted)) {
        return `'${newName}' 已经是一个 event 的名字(名字不区分大小写)。`;
    }
    return undefined;
}

export function planRename(structure: StructureResult, target: RenameTarget, newName: string):
    RenamePlan | { error: string } {
    if (target.kind === 'slotFill') {
        return { error: `'${target.name}' 是组件声明的槽名,填充只能照着它写 —— 要改名,去组件文件里改 slot 声明(用 (was:))。` };
    }
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

    if (target.kind === 'anonymousNode') {
        const node = nodes.find((candidate) => candidate.kind === 'node' && candidate.anonymous
            && candidate.start === target.start);
        if (!node) {
            return { error: '找不到要命名的节点。' };
        }
        // Against every id, the made-up ones included: a written id equal to another unnamed node's made one would
        // take that name from it on the next parse, and quietly repoint whatever the designer had selected.
        const clash = nodes.find((other) => other !== node && isMemberId(other) && fold(other.id) === fold(newName));
        if (clash) {
            return { error: `'${newName}' 已经是第 ${clash.line} 行节点的 id(名字不区分大小写)。` };
        }
        // Written after the type, before any style clause, and nothing else: the write-back's own spelling.
        return { edits: [{ start: target.end, end: target.end, newText: ` ${newName}` }], localizationKeysChange: true };
    }

    if (target.kind === 'id' || target.kind === 'loopVariable') {
        const node = nodes.find((candidate) => candidate.idStart === target.start);
        if (!node) {
            return { error: '找不到要改名的节点。' };
        }
        if (target.kind === 'id') {
            const clash = nodes.find((other) => other !== node && isMemberId(other) && fold(other.id) === fold(newName));
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

    if (target.kind === 'alias') {
        return planAliasRename(structure, nodes, target, newName);
    }

    if (target.kind === 'prop' || target.kind === 'event') {
        const clash = memberClash(structure, newName, target);
        if (clash) {
            return { error: clash };
        }
        const wanted = fold(target.name);
        const edits: RenameEdit[] = [];
        if (target.kind === 'prop') {
            const prop = propNamed(structure, target.name)!;
            edits.push({ start: prop.nameStart, end: prop.nameStart + prop.name.length, newText: newName });
            for (const binding of structure.bindings) {
                const read = propReadBy(structure, binding);
                if (read && fold(read.name) === wanted) {
                    const head = bindingHeadSpan(binding);
                    edits.push({ start: head.start, end: head.end, newText: newName });
                }
            }
        } else {
            const event = eventNamed(structure, target.name)!;
            edits.push({ start: event.nameStart, end: event.nameStart + event.name.length, newText: newName });
            for (const binding of structure.bindings) {
                if (binding.isEmit && fold(binding.name) === wanted) {
                    edits.push({ start: binding.nameStart, end: binding.nameStart + binding.name.length, newText: newName });
                }
            }
        }
        return { edits, localizationKeysChange: false };
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

/**
 * An alias and everything in this file that spells it: the `as` name, each node typed by it, and -- since one word
 * is a component or a namespace depending on the file it names -- each `Alias.` prefix on a type, a style clause, a
 * style's base and a resource reference. Both shapes are rewritten whichever this alias is; a file uses only the one.
 */
function planAliasRename(structure: StructureResult, nodes: StructNode[], target: RenameTarget, newName: string):
    RenamePlan | { error: string } {
    const aliases = localAliases(structure);
    if (aliases.some((alias) => fold(alias.name) === fold(newName))) {
        return { error: `'${newName}' 已经是本文件的另一个 use … as 名字(DUI3017)。` };
    }
    if (isBuiltInTypeName(newName)) {
        return { error: `'${newName}' 是内置标签或布局容器的名字,别名不能用它(DUI3018)。` };
    }
    const wanted = fold(target.name);
    const edits: RenameEdit[] = [];
    for (const alias of aliases) {
        if (fold(alias.name) === wanted) {
            edits.push({ start: alias.start, end: alias.start + alias.name.length, newText: newName });
        }
    }
    const renameHead = (written: string | undefined, start: number | undefined): void => {
        if (!written || start === undefined) {
            return;
        }
        const dot = written.indexOf('.');
        if (dot > 0 && fold(written.slice(0, dot)) === wanted) {
            edits.push({ start, end: start + dot, newText: newName });
        }
    };
    for (const node of nodes) {
        if (node.kind === 'node') {
            if (fold(node.tag) === wanted) {
                edits.push({ start: node.start, end: tagEndOf(node), newText: newName });
            } else {
                renameHead(node.tag, node.start);
            }
        }
        renameHead(node.styleName, node.styleNameStart);
    }
    for (const style of structure.styles) {
        renameHead(style.base, style.baseStart);
    }
    for (const ref of structure.resourceRefs) {
        renameHead(ref.name, ref.start + 1);
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
