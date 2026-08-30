/**
 * Quickfix planning: where an edit goes and what it says, computed against the structure so the
 * vscode layer only wraps offsets into ranges. Each plan is verified by its tests the only way
 * that matters -- apply it, re-parse, the diagnostic is gone and nothing else changed.
 */

import { StructureResult } from './structure';

export interface EditPlan {
    /** Insert `text` at `offset`. All plans are pure insertions -- nothing existing moves. */
    offset: number;
    text: string;
}

/** After the class line when there is one, else the very top. */
function topInsertionPoint(structure: StructureResult, sourceLength: number): { offset: number; prefix: string; suffix: string } {
    if (structure.classPath) {
        return { offset: Math.min(structure.classPath.end, sourceLength), prefix: '\n\n', suffix: '' };
    }
    return { offset: 0, prefix: '', suffix: '\n\n' };
}

/**
 * Declares `Color <name> = #FFFFFF` -- into the existing resources block when there is one, else
 * as a new block after the class line. Colour is the placeholder type on purpose: it is the most
 * common resource by far, and the author lands on a line they were about to edit anyway.
 */
export function planDeclareResource(structure: StructureResult, name: string, sourceLength: number): EditPlan {
    const entry = `Color ${name} = #FFFFFF`;
    const block = structure.scopes.find((scope) => scope.kind === 'resources');
    if (block) {
        // Before the closing brace, indented like an entry.
        return { offset: block.bodyEnd, text: `    ${entry}\n` };
    }
    const at = topInsertionPoint(structure, sourceLength);
    return { offset: at.offset, text: `${at.prefix}resources {\n    ${entry}\n}${at.suffix}` };
}

/** Creates `style <name> { }` after the last style, else after the class line, else at the top. */
export function planCreateStyle(structure: StructureResult, name: string, sourceLength: number): EditPlan {
    const declaration = `style ${name} {\n    \n}`;
    const lastStyle = structure.styles[structure.styles.length - 1];
    const lastScope = lastStyle
        ? structure.scopes.filter((scope) => scope.kind === 'style').sort((a, b) => b.bodyEnd - a.bodyEnd)[0]
        : undefined;
    if (lastScope) {
        // bodyEnd is the closing brace's offset; land after that line's brace.
        return { offset: lastScope.bodyEnd + 1, text: `\n\n${declaration}` };
    }
    const at = topInsertionPoint(structure, sourceLength);
    return { offset: at.offset, text: `${at.prefix}${declaration}${at.suffix}` };
}

export function applyPlan(source: string, plan: EditPlan): string {
    return source.slice(0, plan.offset) + plan.text + source.slice(plan.offset);
}
