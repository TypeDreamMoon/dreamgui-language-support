/**
 * The vscode-facing face of src/core/structure.ts: the same skeleton, in the shapes the providers
 * consume, cached per document version so completion, hover, outline and diagnostics reuse one
 * parse per keystroke instead of three.
 *
 * This file went from being the model (a line-regex sketch) to being an adapter over the real
 * token-driven layer. Keep it thin: anything that smells like parsing belongs in src/core/, where
 * it has tests and no vscode import.
 */
import * as vscode from 'vscode';
import { buildStructure, scopeAt as coreScopeAt, StructNode } from './core/structure';

export type Structure = ReturnType<typeof buildStructure>;

export interface NodeScope {
    kind: 'node' | 'component' | 'resources' | 'style' | 'loop';
    /** Node tag ("Text"), component name ("VerticalBox" or "/Script/..."), style name. */
    name: string;
    /** Node id, when the scope is a node. */
    id?: string;
}

export interface ResourceEntry {
    type: string;
    name: string;
    valueText: string;
    /** 0-based, as every vscode API counts them. */
    line: number;
    nameStart: number;
}

export interface StyleEntry {
    name: string;
    base?: string;
    line: number;
    nameStart: number;
}

export interface OutlineNode {
    kind: StructNode['kind'];
    tag: string;
    id: string;
    line: number;
    children: OutlineNode[];
}

export interface DocModel {
    structure: Structure;
    resources: ResourceEntry[];
    styles: StyleEntry[];
    /** '@Name' uses: [0-based line, character of '@', name]. */
    resourceRefs: { line: number; character: number; name: string }[];
    outline: OutlineNode[];
}

const cache = new Map<string, { version: number; model: DocModel }>();

export function buildModel(document: vscode.TextDocument): DocModel {
    const key = document.uri.toString();
    const cached = cache.get(key);
    if (cached && cached.version === document.version) {
        return cached.model;
    }

    const structure = buildStructure(document.getText());
    const toOutline = (node: StructNode): OutlineNode => ({
        kind: node.kind, tag: node.tag, id: node.id, line: node.line - 1,
        children: node.children.map(toOutline),
    });
    const model: DocModel = {
        structure,
        // A resource's line/column already point at its name token; a style's point at the
        // 'style' keyword, so its name column comes from the offset.
        resources: structure.resources.map((entry) => ({
            type: entry.type, name: entry.name, valueText: entry.valueText,
            line: entry.line - 1, nameStart: entry.column - 1,
        })),
        styles: structure.styles.map((style) => ({
            name: style.name, base: style.base, line: style.line - 1,
            nameStart: document.positionAt(style.nameStart).character,
        })),
        resourceRefs: structure.resourceRefs.map((ref) => ({
            line: ref.line - 1, character: ref.column - 1, name: ref.name,
        })),
        outline: structure.roots.map(toOutline),
    };

    cache.set(key, { version: document.version, model });
    if (cache.size > 32) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
            cache.delete(oldest);
        }
    }
    return model;
}

/** The innermost scope at a position, from the structural layer's block spans. */
export function scopeAt(document: vscode.TextDocument, position: vscode.Position): NodeScope | undefined {
    const model = buildModel(document);
    const scope = coreScopeAt(model.structure, document.offsetAt(position));
    if (!scope) {
        return undefined;
    }
    return { kind: scope.kind === 'namedSlot' ? 'node' : scope.kind, name: scope.name, id: scope.id };
}
