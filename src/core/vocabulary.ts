/**
 * The words of the language that the symbols dump carries -- and the fallback copy of them for a
 * dump written by an older plugin, which carries none.
 *
 * The dump is the authority (DreamUISymbolExport.cpp writes `keywords`, `annotations`, `propTypes`
 * and container entries under `tags` straight from the compiler's tables), so every list here is
 * only ever the SECOND answer: what completion offers while the project's editor has not been
 * restarted on a plugin that knows the words. Each list is copied from Docs/DuiLanguage.md, and a
 * word that appears there and not here is a bug in this file, not a choice.
 *
 * No vscode import here: src/core/ is the seam a future LSP server or another IDE reuses.
 */

/** "Node types", rule 2: the layout containers a node's type may name (`VerticalBox Column { Spacing = 29 }`). */
export const CONTAINER_TYPES: readonly string[] = [
    'VerticalBox', 'HorizontalBox', 'StackBox', 'Overlay', 'CanvasPanel', 'GridPanel', 'UniformGridPanel', 'WrapBox',
    'SizeBox', 'ScaleBox', 'SafeZone', 'ScrollBox', 'WidgetSwitcher', 'Border', 'MenuAnchor',
];

/**
 * "Node types", rule 1: the built-in tags. Here for one judgement only -- an alias may not take one of these names
 * (DUI3018), so a rename that would land on one is refused before the compiler has to say so.
 */
export const BUILTIN_TAGS: readonly string[] = [
    'Widget', 'Text', 'Image', 'RectBlock', 'Sprite', 'Texture', 'Ring', 'Polygon', 'PolygonLine', 'Line2DRaw',
    'Line2DChildren', 'Empty', 'StaticMesh', 'BackgroundBlur', 'BackgroundPixelate', 'PixelSort',
    'PostProcessRenderElement', 'PostProcessRenderElementText', 'CanvasRenderTargetPreviewer', 'UMGWidget',
];

/** The types a `props` line and an `events` parameter take; `Enum` is followed by the enum's path. */
export const PROP_TYPES: readonly string[] = [
    'Text', 'String', 'Number', 'Integer', 'Bool', 'Color', 'Vector2', 'Asset', 'Class', 'Enum',
];

/** What may follow an `@` at the start of a line (besides an Asset resource used as a node type), and `@key`. */
export const ANNOTATIONS: readonly string[] = ['slot', 'fill', 'key'];

/** Every keyword of the grammar, contextual ones included -- the dump's `keywords`, in its order. */
export const KEYWORDS: readonly string[] = [
    'class', 'use', 'as', 'resources', 'style', 'timeline', 'external', 'props', 'events',
    'slot', 'default', 'for', 'each', 'in', 'if', 'else', 'was',
    'emit', 'ease', 'duration', 'loop',
];

/** The statements a file's top level holds, besides its one root node. */
export const TOP_LEVEL_KEYWORDS: readonly string[] = ['class', 'use', 'resources', 'props', 'events', 'style', 'timeline'];

/** The five resource types, for a dump too old to say. */
export const RESOURCE_TYPES: readonly string[] = ['Color', 'Number', 'Vector2', 'String', 'Asset'];

const fold = (name: string): string => name.toLowerCase();

/**
 * True when `name` is a tag or a container -- a name no alias may take (DUI3018). `extraTags` is the dump's own tag
 * list when one is loaded: a plugin's `DECLARE_DREAM_GUI_VISUAL` adds tags this file cannot know.
 */
export function isBuiltInTypeName(name: string, extraTags: readonly string[] = []): boolean {
    const wanted = fold(name);
    return BUILTIN_TAGS.some((tag) => fold(tag) === wanted)
        || CONTAINER_TYPES.some((tag) => fold(tag) === wanted)
        || extraTags.some((tag) => !tag.includes('.') && fold(tag) === wanted);
}
