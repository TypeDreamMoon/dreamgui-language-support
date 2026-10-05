/**
 * The shape of `DUI/.dui-symbols.json`, and the one pass that makes every dump -- this plugin's, or one an older
 * plugin wrote and nobody has regenerated -- answer the same questions.
 *
 * The dump grew in a backward-compatible way: an old reader ignores the new fields, and this reader fills them in
 * when they are missing. What a new dump says is taken as it is; what an old one leaves out is supplied from
 * vocabulary.ts, which copies the language reference. The point is that completion for `VerticalBox Column`, for
 * `props { Number … }` and for `Shown <- …` works the moment the extension updates, not the next time someone restarts
 * the Unreal editor on a rebuilt plugin.
 *
 * Pure: the vscode side (symbols.ts) owns finding, watching and reading the file; this owns what it means.
 */

import { ANNOTATIONS, CONTAINER_TYPES, KEYWORDS, PROP_TYPES, RESOURCE_TYPES } from './vocabulary';

export interface PropertyInfo {
    name: string;
    type: string;
    enum?: string;
    literal?: string;
    /** The UPROPERTY tooltip, as the details panel shows it. */
    tooltip?: string;
    /** The class default, spelled the way this language reads it back. */
    default?: string;
}

/**
 * Which of the three kinds of node type a `tags` entry is (DreamUISymbolExport.cpp writes it on every entry now): a
 * visual's tag, a registered widget (`Native.Button`), or a layout container (`VerticalBox`).
 */
export type TagKind = 'visual' | 'widget' | 'container';

export interface ClassInfo {
    kind?: TagKind;
    class?: string;
    tooltip?: string;
    properties?: PropertyInfo[];
    events?: string[];
}

/**
 * One member of a view model class, as the plugin's export (version 2) describes it: what `Player.▌` offers.
 * `type` is pin-like -- `Text`, `Float`, `Object<StatsVM>`, `Array<Object<ItemVM>>` -- which is what lets a path go on
 * through an object member.
 */
export interface ViewModelMember {
    kind: 'property' | 'function';
    type: string;
    /** The member announces its changes: a binding through it updates on a change instead of every frame. */
    fieldNotify?: boolean;
    /** A property `<->` can write back: BlueprintReadWrite, or a BlueprintCallable `Set<Name>` on the class. */
    writable?: boolean;
    tooltip?: string;
    params?: { name: string; type: string }[];
}

/** A class a `viewmodels` entry can name, keyed by its reflected name (or its path, when two share a name). */
export interface ViewModelClass {
    class?: string;
    tooltip?: string;
    abstract?: boolean;
    members: Record<string, ViewModelMember>;
}

export interface SymbolData {
    version: number;
    tags: Record<string, ClassInfo>;
    widgetProperties: PropertyInfo[];
    widgetEvents: string[];
    slotProperties: PropertyInfo[];
    components: Record<string, ClassInfo>;
    enums: Record<string, { values: string[] }>;
    resourceTypes: string[];
    /** Every keyword of the grammar, contextual ones included. Always present after normalizeSymbols. */
    keywords: string[];
    /** `slot`, `fill`, `key`: what may follow an `@` that is not a resource. Always present after normalizeSymbols. */
    annotations: string[];
    /** The types of a `props` line and an `events` parameter. Always present after normalizeSymbols. */
    propTypes: string[];
    /** The classes a `viewmodels` entry can name, and their members. Empty for a dump older than version 2. */
    viewModels: Record<string, ViewModelClass>;
}

/**
 * `Shown`, as the plugin describes it -- for a dump older than EnsureShownListed. It is how a condition binds
 * (`Shown <- HasSave()`), and what an `if` binds on its branches, so completion that cannot offer it cannot offer
 * the commonest binding in the language.
 */
const SHOWN: PropertyInfo = {
    name: 'Shown',
    type: 'bool',
    tooltip: 'Visibility as a yes or no: true is Visible, false is Collapsed. Reading it reads Visibility, writing it '
        + 'writes Visibility.',
};

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const asRecord = <T>(value: unknown): Record<string, T> =>
    (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, T>) : {});

/**
 * The dump as this extension reads it, whatever plugin wrote it. Never throws on a well-formed JSON object; a
 * missing table becomes an empty one, exactly as the old reader's `?? []` guards treated it.
 */
export function normalizeSymbols(raw: unknown): SymbolData {
    const source = asRecord<unknown>(raw);
    const tags: Record<string, ClassInfo> = {};
    for (const [name, info] of Object.entries(asRecord<ClassInfo>(source.tags))) {
        const entry: ClassInfo = { ...(info ?? {}) };
        if (!entry.kind) {
            // The two tables an old dump had: GetVisualTags (bare names) and the widget registry (`Scope.Name`).
            entry.kind = name.includes('.') ? 'widget' : 'visual';
        }
        tags[name] = entry;
    }
    const components = asRecord<ClassInfo>(source.components);

    // An old dump knows the containers only as `+` components. The node type is the same class under the same
    // short name (ContainerTypeName and ShortComponentName strip the same prefixes), so the entry is lifted across:
    // the properties a container-typed node's own lines set are exactly the component's.
    const hasContainers = Object.values(tags).some((entry) => entry.kind === 'container');
    if (!hasContainers) {
        for (const name of CONTAINER_TYPES) {
            if (tags[name]) {
                continue; // a visual of the same name is asked first by the builder, and keeps the name
            }
            const component = components[name];
            tags[name] = component
                ? { ...component, kind: 'container' }
                : { kind: 'container', properties: [], events: [] };
        }
    }

    const widgetProperties = [...asArray<PropertyInfo>(source.widgetProperties)];
    if (!widgetProperties.some((property) => property.name === 'Shown')) {
        widgetProperties.push(SHOWN);
    }

    const strings = (value: unknown, fallback: readonly string[]): string[] => {
        const list = asArray<unknown>(value).filter((entry): entry is string => typeof entry === 'string');
        return list.length > 0 ? list : [...fallback];
    };

    return {
        version: typeof source.version === 'number' ? source.version : 1,
        tags,
        widgetProperties,
        widgetEvents: asArray<string>(source.widgetEvents),
        slotProperties: asArray<PropertyInfo>(source.slotProperties),
        components,
        enums: asRecord<{ values: string[] }>(source.enums),
        resourceTypes: strings(source.resourceTypes, RESOURCE_TYPES),
        keywords: strings(source.keywords, KEYWORDS),
        annotations: strings(source.annotations, ANNOTATIONS),
        propTypes: strings(source.propTypes, PROP_TYPES),
        viewModels: normalizeViewModels(source.viewModels),
    };
}

function normalizeViewModels(raw: unknown): Record<string, ViewModelClass> {
    const out: Record<string, ViewModelClass> = {};
    for (const [name, info] of Object.entries(asRecord<Partial<ViewModelClass>>(raw))) {
        if (!info || typeof info !== 'object') {
            continue;
        }
        const members: Record<string, ViewModelMember> = {};
        for (const [member, entry] of Object.entries(asRecord<Partial<ViewModelMember>>(info.members))) {
            if (entry && (entry.kind === 'property' || entry.kind === 'function') && typeof entry.type === 'string') {
                members[member] = entry as ViewModelMember;
            }
        }
        out[name] = { class: info.class, tooltip: info.tooltip, abstract: info.abstract, members };
    }
    return out;
}

/** The node types the dump lists, with their kind: what completion offers where a node's type goes. */
export function nodeTypeNames(data: SymbolData | undefined): { name: string; kind: TagKind }[] {
    if (!data) {
        // No dump at all: the containers are still the language's, and offering them costs nothing.
        return CONTAINER_TYPES.map((name) => ({ name, kind: 'container' as const }));
    }
    return Object.entries(data.tags).map(([name, info]) => ({ name, kind: info.kind ?? 'visual' }));
}

/** True when `tag` is a layout container written as a node type. */
export function isContainerType(data: SymbolData | undefined, tag: string): boolean {
    const entry = data?.tags[tag];
    if (entry) {
        return entry.kind === 'container';
    }
    return CONTAINER_TYPES.includes(tag);
}

/**
 * The properties a bare name on a node of this tag can reach, in the order the builder asks: the widget first, then
 * the tag's visual -- or, for a container-typed node, its container (a name both have means the widget's). The first
 * spelling of a name wins, so a hover over a name two classes share describes the one the compiler will write.
 */
export function propertiesForTag(data: SymbolData | undefined, tag: string | undefined): PropertyInfo[] {
    if (!data) {
        return [];
    }
    const seen = new Set<string>();
    const out: PropertyInfo[] = [];
    const add = (list: readonly PropertyInfo[] | undefined): void => {
        for (const property of list ?? []) {
            if (!seen.has(property.name)) {
                seen.add(property.name);
                out.push(property);
            }
        }
    };
    add(data.widgetProperties);
    if (tag) {
        add(data.tags[tag]?.properties);
    }
    return out;
}

/**
 * The part of each dotted name that follows `head.`: what completion offers once `AnchorData.` or `Native.` has been
 * typed. A completion item's text replaces the WORD at the cursor, and a word never holds a dot here, so an item
 * spelled whole would write `AnchorData.AnchorData.SizeDelta`.
 */
export function tailsAfter<T extends { name: string }>(entries: readonly T[], head: string): { tail: string; entry: T }[] {
    const prefix = head.toLowerCase() + '.';
    const out: { tail: string; entry: T }[] = [];
    for (const entry of entries) {
        if (entry.name.toLowerCase().startsWith(prefix) && entry.name.length > prefix.length) {
            out.push({ tail: entry.name.slice(prefix.length), entry });
        }
    }
    return out;
}
