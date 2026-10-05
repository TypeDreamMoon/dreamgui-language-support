/**
 * What a member path through a view model reaches -- `Player.▌`, `Player.Stats.▌`, `Item.▌` in a loop over
 * `Player.Items` -- answered from this file's `viewmodels` block and the plugin's symbol export (version 2).
 *
 * Pure, like everything under core/: the provider hands in the structure, the symbols and the text before the cursor.
 * It reports less than the compiler, never differently: a path it cannot follow (an old export, a class it does not
 * list, a member typed as something other than an object) gets no completion rather than a guess.
 */

import { StructNode, StructureResult, ViewModelDecl } from './structure';
import { SymbolData, ViewModelClass, ViewModelMember } from './symbolFacts';

const WORD = '[A-Za-z_\\u00A0-\\uFFFF][\\w\\u00A0-\\uFFFF]*';
const MEMBER_RUN = new RegExp(`(${WORD}(?:\\.${WORD})*)\\.([\\w\\u00A0-\\uFFFF]*)$`, 'u');

/** `Player.Stats.Ti` before the cursor: the complete segments, and the part being typed. */
export function memberRunAt(line: string): { segments: string[]; partial: string } | undefined {
    const match = MEMBER_RUN.exec(line);
    if (!match) {
        return undefined;
    }
    // A run glued to a word character before it is part of something longer (`a.b` inside `xa.b`) -- the regex
    // already anchors on a word start, so only an '@' (a resource) has to be turned away here.
    const before = line.slice(0, match.index);
    if (before.endsWith('@')) {
        return undefined;
    }
    return { segments: match[1].split('.'), partial: match[2] };
}

/** `Object<StatsVM>` → `StatsVM`; `Array<Object<ItemVM>>` → `ItemVM` with `array`; anything else → undefined. */
export function classOfMemberType(type: string): { name: string; array: boolean } | undefined {
    const array = /^Array<Object<(.+)>>$/u.exec(type);
    if (array) {
        return { name: array[1], array: true };
    }
    const single = /^Object<(.+)>$/u.exec(type);
    return single ? { name: single[1], array: false } : undefined;
}

const fold = (name: string): string => name.toLowerCase();

/**
 * The class a `viewmodels` type names, as the compiler resolves it: a key of the export (a reflected name), a path
 * (`/Script/Game.PlayerVM`, `/Game/UI/BP_VM` and its `_C`), or a `use … as` name for one.
 */
export function resolveViewModelType(
    symbols: SymbolData | undefined, structure: StructureResult, typeName: string,
): { name: string; info: ViewModelClass } | undefined {
    const table = symbols?.viewModels ?? {};
    const direct = table[typeName];
    if (direct) {
        return { name: typeName, info: direct };
    }
    let path = typeName.startsWith('/') ? typeName : undefined;
    if (!path) {
        const alias = structure.imports.find((use) => !use.refused && use.alias === typeName && use.target === 'class');
        path = alias?.path;
    }
    if (path) {
        const wanted = fold(path);
        for (const [name, info] of Object.entries(table)) {
            const classPath = fold(info.class ?? '');
            if (classPath === wanted || classPath.startsWith(`${wanted}.`) || `${classPath}_c` === wanted) {
                return { name, info };
            }
        }
        return undefined;
    }
    // A C++ `UPlayerVM` is reflected as `PlayerVM`; a type written with its prefix still finds it.
    const stripped = /^U[A-Z]/u.test(typeName) ? typeName.slice(1) : undefined;
    if (stripped && table[stripped]) {
        return { name: stripped, info: table[stripped] };
    }
    return undefined;
}

/** The entry of this file's `viewmodels` block the name is -- variable names fold like FName. */
export function viewModelNamed(structure: StructureResult, name: string): ViewModelDecl | undefined {
    return (structure.viewModels ?? []).find((decl) => fold(decl.name) === fold(name));
}

/** The loop whose variable is `name` and whose body holds `offset`, innermost first. */
function enclosingLoop(nodes: StructNode[], name: string, offset: number): StructNode | undefined {
    for (const node of nodes) {
        const inner = enclosingLoop(node.children, name, offset);
        if (inner) {
            return inner;
        }
        if (node.kind === 'loop' && node.id === name && node.bodyStart !== undefined && node.bodyEnd !== undefined
            && offset >= node.bodyStart && offset <= node.bodyEnd) {
            return node;
        }
    }
    return undefined;
}

/** Follow `segments` from a class, member by member, through object-typed members. */
function walk(symbols: SymbolData, start: ViewModelClass, segments: string[]): ViewModelClass | undefined {
    let current: ViewModelClass | undefined = start;
    for (const segment of segments) {
        const member: ViewModelMember | undefined = current?.members[segment];
        const next: { name: string; array: boolean } | undefined = member ? classOfMemberType(member.type) : undefined;
        if (!next || next.array) {
            return undefined;
        }
        current = symbols.viewModels[next.name];
    }
    return current;
}

/**
 * The class `segments` reach: from a `viewmodels` entry (`Player.Stats`), or from a loop variable whose loop draws
 * from a view model's object array (`Item` in `for Item in Player.Items`). `offset` is where the path is written,
 * which decides which loop variable is in scope.
 */
export function classAtPath(
    symbols: SymbolData | undefined, structure: StructureResult, segments: string[], offset: number,
): ViewModelClass | undefined {
    if (!symbols || segments.length === 0) {
        return undefined;
    }
    const [head, ...rest] = segments;
    const loop = enclosingLoop(structure.roots, head, offset);
    if (loop?.loopSource) {
        const sourceSegments = loop.loopSource.split('.');
        const owner = sourceSegments.length > 1
            ? classAtPath(symbols, structure, sourceSegments.slice(0, -1), loop.start)
            : undefined;
        const source = owner?.members[sourceSegments[sourceSegments.length - 1]];
        const element = source ? classOfMemberType(source.type) : undefined;
        const item = element?.array ? symbols.viewModels[element.name] : undefined;
        return item ? walk(symbols, item, rest) : undefined;
    }
    const decl = viewModelNamed(structure, head);
    if (!decl) {
        return undefined;
    }
    const resolved = resolveViewModelType(symbols, structure, decl.type);
    return resolved ? walk(symbols, resolved.info, rest) : undefined;
}

/** What `Player.Stats.▌` offers: the members of the class the complete segments reach. */
export function viewModelMembersAt(
    symbols: SymbolData | undefined, structure: StructureResult, line: string, offset: number,
): { members: [string, ViewModelMember][]; partial: string } | undefined {
    const run = memberRunAt(line);
    if (!run) {
        return undefined;
    }
    const info = classAtPath(symbols, structure, run.segments, offset);
    if (!info) {
        return undefined;
    }
    return { members: Object.entries(info.members).sort(([a], [b]) => a.localeCompare(b)), partial: run.partial };
}

/** The view model classes a `viewmodels` line's type can name, for completion there. */
export function viewModelClassNames(symbols: SymbolData | undefined): { name: string; info: ViewModelClass }[] {
    return Object.entries(symbols?.viewModels ?? {})
        .map(([name, info]) => ({ name, info }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
