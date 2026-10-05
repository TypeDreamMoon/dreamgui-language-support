/**
 * Quickfixes for the two diagnostics whose fix is mechanical: an unknown resource, an unknown
 * style. Each has two answers now -- declare it here, or `use` the file that already declares it
 * -- and the second is offered first when the workspace can point at exactly one such file.
 * Importing what exists beats writing a second declaration that will shadow it.
 *
 * An unknown node type (DUI3003) gets one answer, and only when it is unambiguous: `use "…" as Row`
 * naming the one component file whose name is the type (`Row.dui`, or `NieR_Row.dui` in a family
 * that prefixes its files).
 *
 * All plans are pure insertions computed in core; nothing existing moves, and nothing here
 * decides anything the compiler decides.
 */
import * as vscode from 'vscode';
import { buildModel } from './docmodel';
import { planDeclareResource, planCreateStyle, EditPlan } from './core/quickfixes';
import { filesDeclaring, planUseInsertion, planUseSpelling, componentFilesNamed } from './core/useFix';
import { WorkspaceIndexHost } from './workspace';
import { codeText } from './codeLinks';

export function registerQuickfixes(context: vscode.ExtensionContext, host?: WorkspaceIndexHost): void {
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ language: 'dui' }, {
        provideCodeActions(document, _range, actionContext) {
            const actions: vscode.CodeAction[] = [];
            const model = buildModel(document);

            const toAction = (title: string, plan: EditPlan, diagnostic: vscode.Diagnostic,
                preferred: boolean): vscode.CodeAction => {
                const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
                action.diagnostics = [diagnostic];
                action.isPreferred = preferred;
                action.edit = new vscode.WorkspaceEdit();
                action.edit.insert(document.uri, document.positionAt(plan.offset), plan.text);
                return action;
            };

            /**
             * The `use` that would bring `name` into scope, when the workspace holds exactly one
             * file declaring it. Ambiguity gets no fix: the index resolves imports by path suffix
             * and the compiler by DUI root, and the two only provably agree on a unique match --
             * an import that lands on the wrong file is worse than no quickfix at all.
             */
            const useAction = (kind: 'style' | 'resource', name: string,
                diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined => {
                if (!host) {
                    return undefined;
                }
                const declaring = filesDeclaring(host.index, kind, name)
                    .filter((file) => file !== document.uri.fsPath);
                if (declaring.length !== 1) {
                    return undefined;
                }
                const spelling = planUseSpelling({
                    documentFile: document.uri.fsPath,
                    targetFile: declaring[0],
                    existing: model.structure.imports.map((directive) => directive.path),
                    resolve: (candidate) => host.index.resolveImportSpelling(candidate),
                });
                if (!spelling) {
                    return undefined;
                }
                return toAction(`Add use "${spelling}"`,
                    planUseInsertion(model.structure, spelling, document.getText().length),
                    diagnostic, true);
            };

            /** `use "Components/Row.dui" as Row` for a type nothing names, when one component file is the type. */
            const componentAction = (typeName: string, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined => {
                if (!host) {
                    return undefined;
                }
                const candidates = componentFilesNamed(host.index, typeName)
                    .filter((file) => file !== document.uri.fsPath);
                if (candidates.length !== 1) {
                    return undefined;
                }
                const spelling = planUseSpelling({
                    documentFile: document.uri.fsPath,
                    targetFile: candidates[0],
                    // The file's spellings, for its house style -- minus any that already reach the component: a
                    // plain `use` of it names no type, and it is the alias that is missing, not the import.
                    existing: model.structure.imports.map((directive) => directive.path).filter((spelling) =>
                        !host.index.resolveImportSpelling(spelling).includes(candidates[0])),
                    resolve: (candidate) => host.index.resolveImportSpelling(candidate),
                });
                if (!spelling) {
                    return undefined;
                }
                return toAction(`Add use "${spelling}" as ${typeName}`,
                    planUseInsertion(model.structure, spelling, document.getText().length, typeName),
                    diagnostic, true);
            };

            for (const diagnostic of actionContext.diagnostics) {
                const code = codeText(diagnostic.code);
                if (code === 'DUI3003') {
                    // The range covers the type as written (the compiler's may be a bare position: then the word
                    // there). Only a plain name can become an alias; componentFilesNamed refuses anything else.
                    const written = document.getText(diagnostic.range).trim();
                    const word = document.getWordRangeAtPosition(diagnostic.range.start);
                    const typeName = written.length > 0 ? written : word ? document.getText(word) : '';
                    const importer = componentAction(typeName, diagnostic);
                    if (importer) {
                        actions.push(importer);
                    }
                } else if (code === 'DUI4007') {
                    // The range covers '@Name'; the name is the text minus its '@'.
                    const name = document.getText(diagnostic.range).replace(/^@/, '');
                    if (!name) {
                        continue;
                    }
                    const importer = useAction('resource', name, diagnostic);
                    if (importer) {
                        actions.push(importer);
                    }
                    actions.push(toAction(`Declare resource '${name}'`,
                        planDeclareResource(model.structure, name, document.getText().length),
                        diagnostic, importer === undefined));
                } else if (code === 'DUI3004') {
                    // The range covers the style name, at a wearing site or a base clause alike.
                    const name = document.getText(diagnostic.range);
                    if (!/^[^\s{}():=]+$/.test(name)) {
                        continue;
                    }
                    const importer = useAction('style', name, diagnostic);
                    if (importer) {
                        actions.push(importer);
                    }
                    actions.push(toAction(`Create style '${name}'`,
                        planCreateStyle(model.structure, name, document.getText().length),
                        diagnostic, importer === undefined));
                }
            }
            return actions;
        },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
}
