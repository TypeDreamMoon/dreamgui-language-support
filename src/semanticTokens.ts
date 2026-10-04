/**
 * The vscode face of src/core/semantics.ts: offsets become positions, span types become legend
 * indices. All the judgement lives in core, where it has tests.
 *
 * The workspace index says which `use … as` names are namespaces and which aliases a library
 * re-exports; when it knows nothing about the file yet, core falls back to what the text shows.
 * The tokens are re-asked whenever the index changes, since a library arriving can turn `Row` from
 * an unknown word into a component.
 */
import * as vscode from 'vscode';
import { buildModel } from './docmodel';
import { collectSemanticSpans, SemanticType, SemanticModifier, SemanticContext } from './core/semantics';
import { namespacesVisibleFrom } from './core/componentIntel';
import { WorkspaceIndexHost } from './workspace';

const TYPES: SemanticType[] = ['variable', 'class', 'parameter', 'function', 'event', 'type', 'namespace', 'property'];
const MODIFIERS: SemanticModifier[] = ['declaration', 'readonly'];
const LEGEND = new vscode.SemanticTokensLegend([...TYPES], [...MODIFIERS]);

/** Long enough to coalesce a workspace sweep's burst of updates into one repaint. */
const REFRESH_DEBOUNCE_MS = 300;

export function registerSemanticTokens(context: vscode.ExtensionContext, host?: WorkspaceIndexHost): void {
    const changed = new vscode.EventEmitter<void>();
    context.subscriptions.push(changed);
    if (host) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        context.subscriptions.push(host.onDidChange(() => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => {
                timer = undefined;
                changed.fire();
            }, REFRESH_DEBOUNCE_MS);
        }));
        context.subscriptions.push({ dispose: () => timer !== undefined && clearTimeout(timer) });
    }

    const contextFor = (document: vscode.TextDocument): SemanticContext => {
        const file = document.uri.fsPath;
        if (!host || !host.index.has(file)) {
            return {};
        }
        return {
            namespaces: namespacesVisibleFrom(host.index, file).map((namespace) => namespace.name),
            aliases: host.index.aliasesVisibleFrom(file).map((alias) => alias.name).filter((name) => !name.includes('.')),
        };
    };

    context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider({ language: 'dui' }, {
        onDidChangeSemanticTokens: changed.event,
        provideDocumentSemanticTokens(document) {
            const model = buildModel(document);
            const builder = new vscode.SemanticTokensBuilder(LEGEND);
            for (const span of collectSemanticSpans(model.structure, contextFor(document))) {
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
