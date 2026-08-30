/**
 * Semantic highlighting spans, assembled from the structural skeleton. This layer colours
 * IDENTITY -- which word is a widget id, a style, a resource, a function -- on top of the
 * TextMate grammar, which colours shape. Pure data out; the vscode provider only translates
 * offsets to positions and types to its legend.
 */

import { StructureResult, StructNode } from './structure';

export type SemanticType = 'variable' | 'class' | 'parameter' | 'function' | 'event' | 'type';
export type SemanticModifier = 'declaration' | 'readonly';

export interface SemanticSpan {
    start: number;
    length: number;
    type: SemanticType;
    modifiers: SemanticModifier[];
}

export function collectSemanticSpans(structure: StructureResult): SemanticSpan[] {
    const spans: SemanticSpan[] = [];
    const push = (start: number | undefined, length: number, type: SemanticType, modifiers: SemanticModifier[] = []): void => {
        if (start !== undefined && length > 0) {
            spans.push({ start, length, type, modifiers });
        }
    };

    const visit = (node: StructNode): void => {
        if (node.kind === 'loop') {
            // The loop variable is a parameter: it exists to be repeated over, not bound to.
            push(node.idStart, node.id.length, 'parameter', ['declaration']);
        } else {
            // A node id IS the generated class's member variable; colouring it as a variable
            // declaration is literal, not metaphor.
            push(node.idStart, node.id.length, 'variable', ['declaration']);
        }
        if (node.styleName) {
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
        if (style.base) {
            push(style.baseStart, style.base.length, 'class');
        }
    }
    for (const resource of structure.resources) {
        // Resources are the file's named constants: variables, but readonly ones.
        push(resource.nameStart, resource.name.length, 'variable', ['declaration', 'readonly']);
    }
    for (const ref of structure.resourceRefs) {
        push(ref.start + 1, ref.name.length, 'variable', ['readonly']);
    }
    const loopScopes = structure.scopes.filter((scope) => scope.kind === 'loop');
    for (const binding of structure.bindings) {
        if (binding.isEvent) {
            push(binding.pathStart, binding.pathEnd - binding.pathStart, 'event');
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
        } else {
            push(binding.nameStart, binding.name.length, 'variable');
        }
    }

    spans.sort((a, b) => a.start - b.start);
    return spans;
}
