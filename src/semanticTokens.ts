/**
 * The vscode face of src/core/semantics.ts: offsets become positions, span types become legend
 * indices. All the judgement lives in core, where it has tests.
 */
import * as vscode from 'vscode';
import { buildModel } from './docmodel';
import { collectSemanticSpans, SemanticType, SemanticModifier } from './core/semantics';

const TYPES: SemanticType[] = ['variable', 'class', 'parameter', 'function', 'event', 'type'];
const MODIFIERS: SemanticModifier[] = ['declaration', 'readonly'];
const LEGEND = new vscode.SemanticTokensLegend([...TYPES], [...MODIFIERS]);

export function registerSemanticTokens(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider({ language: 'dui' }, {
        provideDocumentSemanticTokens(document) {
            const model = buildModel(document);
            const builder = new vscode.SemanticTokensBuilder(LEGEND);
            for (const span of collectSemanticSpans(model.structure)) {
                const start = document.positionAt(span.start);
                const end = document.positionAt(span.start + span.length);
                if (start.line !== end.line) {
                    continue; // spans are single-line by construction; hold the invariant anyway
                }
                builder.push(new vscode.Range(start, end), span.type, span.modifiers);
            }
            return builder.build();
        },
    }, LEGEND));
}
