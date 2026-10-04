/**
 * Semantic highlighting spans, assembled from the structural skeleton. This layer colours
 * IDENTITY -- which word is a widget id, a style, a resource, a function -- on top of the
 * TextMate grammar, which colours shape. Pure data out; the vscode provider only translates
 * offsets to positions and types to its legend.
 *
 * The component grammar adds four identities, each coloured as what it becomes in the class:
 *
 *   - an alias (`use … as Row`, and `Row` as a node's type) is a TYPE -- the component's class;
 *   - a namespace (`use … as nier`, and the `nier` of `nier.Row`, `: nier.Label`, `@nier.Ink`) is a NAMESPACE;
 *   - a prop is a PROPERTY of the class, at its declaration and wherever a binding reads it;
 *   - an event is an EVENT, at its declaration and after `emit`.
 *
 * Whether an alias names a component or a namespace depends on the file it names, which one file cannot see. The
 * caller passes what the workspace knows (`namespaces`); on top of that, an alias written with a dot after it
 * somewhere in this file is taken for a namespace -- the only way the text itself tells the two apart.
 */

import { StructureResult, StructNode } from './structure';

export type SemanticType = 'variable' | 'class' | 'parameter' | 'function' | 'event' | 'type' | 'namespace' | 'property';
export type SemanticModifier = 'declaration' | 'readonly';

export interface SemanticSpan {
    start: number;
    length: number;
    type: SemanticType;
    modifiers: SemanticModifier[];
}

export interface SemanticContext {
    /**
     * Names that are namespaces in this file (from the workspace: the `use … as` lines whose file has no root, the
     * file's own and those its plain imports carry). Case-insensitive.
     */
    namespaces?: Iterable<string>;
    /** Component aliases visible in this file beyond its own `use … as` lines (re-exported by a library). */
    aliases?: Iterable<string>;
}

const fold = (name: string): string => name.toLowerCase();

export function collectSemanticSpans(structure: StructureResult, context: SemanticContext = {}): SemanticSpan[] {
    const spans: SemanticSpan[] = [];
    const push = (start: number | undefined, length: number, type: SemanticType, modifiers: SemanticModifier[] = []): void => {
        if (start !== undefined && length > 0) {
            spans.push({ start, length, type, modifiers });
        }
    };

    // ---- what the file's aliases are -------------------------------------------------------------------------
    const ownAliases = structure.imports.filter((directive) => directive.alias && directive.aliasStart !== undefined);
    const dottedHeads = new Set<string>();
    const noteHead = (written: string | undefined): void => {
        const dot = written ? written.indexOf('.') : -1;
        if (written && dot > 0) {
            dottedHeads.add(fold(written.slice(0, dot)));
        }
    };
    const everyNode: StructNode[] = [];
    const gather = (node: StructNode): void => {
        everyNode.push(node);
        node.children.forEach(gather);
    };
    structure.roots.forEach(gather);
    for (const node of everyNode) {
        if (node.kind === 'node') {
            noteHead(node.tag);
        }
        noteHead(node.styleName);
    }
    structure.styles.forEach((style) => noteHead(style.base));
    structure.resourceRefs.forEach((ref) => noteHead(ref.name));

    // What the workspace knows, and what the text shows: a component alias is never written `Row.X`, so an own alias
    // with a dot after it is a namespace even when its library is out of the index's reach.
    const namespaces = new Set<string>();
    for (const name of context.namespaces ?? []) {
        namespaces.add(fold(name));
    }
    for (const directive of ownAliases) {
        if (dottedHeads.has(fold(directive.alias!))) {
            namespaces.add(fold(directive.alias!));
        }
    }
    const aliases = new Set<string>(ownAliases
        .filter((directive) => !namespaces.has(fold(directive.alias!)))
        .map((directive) => fold(directive.alias!)));
    for (const name of context.aliases ?? []) {
        aliases.add(fold(name));
    }

    /** `nier.Label`: the head is a namespace, the tail is `tailType`. Undefined when the head is not one. */
    const pushQualified = (written: string, start: number | undefined, tailType: SemanticType,
        tailModifiers: SemanticModifier[] = []): boolean => {
        const dot = written.indexOf('.');
        if (start === undefined || dot <= 0 || !namespaces.has(fold(written.slice(0, dot)))) {
            return false;
        }
        push(start, dot, 'namespace');
        push(start + dot + 1, written.length - dot - 1, tailType, tailModifiers);
        return true;
    };

    for (const directive of ownAliases) {
        push(directive.aliasStart, directive.alias!.length,
            namespaces.has(fold(directive.alias!)) ? 'namespace' : 'type', ['declaration']);
    }

    const visit = (node: StructNode): void => {
        if (node.kind === 'loop') {
            // The loop variable is a parameter: it exists to be repeated over, not bound to.
            push(node.idStart, node.id.length, 'parameter', ['declaration']);
        } else if (node.kind === 'namedSlot' && node.fillsSlot) {
            // A fill names the component's slot: a use of someone else's name, not a declaration of this file's.
            push(node.idStart, node.id.length, 'variable');
        } else {
            // A node id IS the generated class's member variable; colouring it as a variable
            // declaration is literal, not metaphor. (An unnamed node has no id token, and no span.)
            push(node.idStart, node.id.length, 'variable', ['declaration']);
        }
        if (node.kind === 'node') {
            // A type is up to three tokens (`nier.Row`); the parser says where it ends, so the tail is measured back
            // from there rather than forward from a dot that may have spaces around it.
            const end = node.tagEnd ?? node.start + node.tag.length;
            const dot = node.tag.indexOf('.');
            if (dot > 0 && namespaces.has(fold(node.tag.slice(0, dot)))) {
                const tail = node.tag.length - dot - 1;
                push(node.start, dot, 'namespace');
                push(end - tail, tail, 'type');
            } else if (aliases.has(fold(node.tag))) {
                push(node.start, end - node.start, 'type');
            }
        }
        if (node.styleName && !pushQualified(node.styleName, node.styleNameStart, 'class')) {
            push(node.styleNameStart, node.styleName.length, 'class');
        }
        for (const component of node.components) {
            push(component.start, component.name.length, 'type');
        }
        for (const child of node.children) {
            visit(child);
        }
    };
    for (const root of structure.roots) {
        visit(root);
    }

    for (const style of structure.styles) {
        push(style.nameStart, style.name.length, 'class', ['declaration']);
        if (style.base && !pushQualified(style.base, style.baseStart, 'class')) {
            push(style.baseStart, style.base.length, 'class');
        }
        for (const component of style.components ?? []) {
            push(component.start, component.name.length, 'type');
        }
    }
    for (const resource of structure.resources) {
        // Resources are the file's named constants: variables, but readonly ones.
        push(resource.nameStart, resource.name.length, 'variable', ['declaration', 'readonly']);
    }
    for (const ref of structure.resourceRefs) {
        if (!pushQualified(ref.name, ref.start + 1, 'variable', ['readonly'])) {
            push(ref.start + 1, ref.name.length, 'variable', ['readonly']);
        }
    }

    // A prop is a property of the class (a Blueprint variable hosts set); an event is a dispatcher it raises.
    const props = new Set((structure.props ?? []).map((prop) => fold(prop.name)));
    for (const prop of structure.props ?? []) {
        push(prop.nameStart, prop.name.length, 'property', ['declaration']);
    }
    for (const event of structure.events ?? []) {
        push(event.nameStart, event.name.length, 'event', ['declaration']);
    }

    const loopScopes = structure.scopes.filter((scope) => scope.kind === 'loop');
    for (const binding of structure.bindings) {
        if (binding.isEvent && binding.pathEnd > binding.pathStart) {
            push(binding.pathStart, binding.pathEnd - binding.pathStart, 'event');
        }
        if (binding.isEmit) {
            // `emit Picked`: the event this file declares, raised -- not a handler on the class.
            push(binding.nameStart, binding.name.length, 'event');
            continue;
        }
        if (!binding.isVariable) {
            push(binding.nameStart, binding.name.length, 'function');
            continue;
        }
        // A variable ref: a `<->` right side, or a bare identifier in a binding expression. When
        // its first segment IS an enclosing loop's variable (`Item.Title` inside `each Item in`),
        // that segment is the parameter it declares -- same colour as the declaration, case
        // sensitive like the compiler's loop-variable rules.
        const dot = binding.name.indexOf('.');
        const head = dot < 0 ? binding.name : binding.name.slice(0, dot);
        const insideOwningLoop = loopScopes.some((scope) => scope.id === head
            && binding.nameStart >= scope.bodyStart && binding.nameStart <= scope.bodyEnd);
        if (insideOwningLoop) {
            push(binding.nameStart, head.length, 'parameter');
            if (dot >= 0) {
                push(binding.nameStart + dot + 1, binding.name.length - dot - 1, 'variable');
            }
        } else if (props.has(fold(head))) {
            push(binding.nameStart, head.length, 'property');
            if (dot >= 0) {
                push(binding.nameStart + dot + 1, binding.name.length - dot - 1, 'variable');
            }
        } else {
            push(binding.nameStart, binding.name.length, 'variable');
        }
    }

    spans.sort((a, b) => a.start - b.start);
    return spans;
}
