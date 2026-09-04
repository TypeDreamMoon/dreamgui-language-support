/**
 * Diagnostics, on every edit, from three places with three levels of certainty:
 *
 *   - the core scanner and structure layer: codes whose verdict one file's characters fully
 *     determine, at the severity the compiler itself uses (a mirror that says MORE than the
 *     compiler is the failure mode this extension is not allowed to have);
 *   - the symbols dump: checks that depend on what the plugin exported, warnings at most;
 *   - the tag sweep: information only -- a tag can also be an asset path, and the compiler's own
 *     message is the real verdict.
 */
import * as vscode from 'vscode';
import { SymbolStore } from './symbols';
import { buildModel, OutlineNode } from './docmodel';
import { DuiDiagnostic } from './core/structure';
import { formatCode } from './core/scanner';
import { WorkspaceIndexHost } from './workspace';

export function registerDiagnostics(context: vscode.ExtensionContext, store: SymbolStore,
    host?: WorkspaceIndexHost): void {
    const collection = vscode.languages.createDiagnosticCollection('dui');
    context.subscriptions.push(collection);

    const refresh = async (document: vscode.TextDocument): Promise<void> => {
        if (document.languageId !== 'dui') {
            return;
        }
        // The import exemptions below read the workspace index, and the index is filled by a lazy
        // sweep that only navigation and completion used to ask for. Judging a file before that
        // sweep is what reported DUI3004 on every imported style in a freshly restored window: the
        // `use` resolved to nothing, so nothing was exempt -- and nothing re-judged the file once
        // the library it names was indexed. Wait for the sweep; a document that changed underneath
        // the wait belongs to the refresh that change triggered.
        if (host) {
            const version = document.version;
            await host.ensureScanned();
            if (document.isClosed || document.version !== version) {
                return;
            }
        }
        const index = host?.index;
        store.ensureLoadedFor(document.uri.fsPath);
        const model = buildModel(document);
        const diagnostics: vscode.Diagnostic[] = [];

        // What `use` imports bring into scope. The structure layer judges one file's characters;
        // styles and resources arriving through imports are workspace knowledge, so the refusals
        // that would be wrong for them are withheld HERE rather than taught to the parser. A
        // spelling that resolves to nothing (or ambiguously) imports nothing -- reporting less
        // than the compiler is allowed, reporting differently is not, so only a UNIQUE resolution
        // is trusted.
        const importedStyles = new Set<string>();
        const importedResources = new Set<string>();
        if (index) {
            for (const directive of model.structure.imports) {
                const matches = index.resolveImportSpelling(directive.path);
                if (matches.length !== 1) {
                    continue;
                }
                const summary = index.summaryOf(matches[0]);
                if (!summary) {
                    continue;
                }
                for (const style of summary.styles) {
                    importedStyles.add(style.name.toLowerCase());
                }
                for (const resource of summary.resources) {
                    importedResources.add(resource.name.toLowerCase());
                }
            }
        }
        const importCoversStyle = (message: string): boolean => {
            const named = /^'([^']+)' names a style this file does not declare/.exec(message);
            return named !== null && importedStyles.has(named[1].toLowerCase());
        };
        // A style-and-resource library legitimately declares no root: the compiler only demands a
        // root of a file it compiles AS a class, and an imported file is read for its declarations.
        const isDeclarationLibrary = model.structure.roots.length === 0
            && (model.structure.styles.length > 0 || model.resources.length > 0);

        const fromCore = (source: DuiDiagnostic): vscode.Diagnostic => {
            const range = new vscode.Range(
                document.positionAt(source.start),
                document.positionAt(Math.max(source.end, source.start + 1)));
            const diagnostic = new vscode.Diagnostic(range,
                `${formatCode(source.code)}: ${source.message}`,
                source.severity === 'error'
                    ? vscode.DiagnosticSeverity.Error
                    : vscode.DiagnosticSeverity.Warning);
            diagnostic.code = formatCode(source.code);
            diagnostic.source = 'dui';
            return diagnostic;
        };
        for (const lexical of model.structure.lexical) {
            diagnostics.push(fromCore(lexical));
        }
        for (const structural of model.structure.diagnostics) {
            if (structural.code === 3004 && importCoversStyle(structural.message)) {
                continue;
            }
            if (structural.code === 2006 && isDeclarationLibrary) {
                continue;
            }
            diagnostics.push(fromCore(structural));
        }

        // A stray '}' at the top level: the structure layer steps over it (the compiler words that
        // refusal), but leaving it entirely unmarked reads as "fine". No code on purpose.
        let depth = 0;
        for (const token of model.structure.tokens) {
            if (token.kind === 'openBrace') {
                depth++;
            } else if (token.kind === 'closeBrace') {
                depth--;
                if (depth < 0) {
                    diagnostics.push(new vscode.Diagnostic(
                        new vscode.Range(document.positionAt(token.start), document.positionAt(token.end)),
                        "'}' closes nothing", vscode.DiagnosticSeverity.Error));
                    depth = 0;
                }
            }
        }

        // '@Name' against this file's own resources block, case insensitively as FindResource
        // compares them. DUI4007 is the compiler's code for the same refusal.
        const declared = new Set(model.resources.map((entry) => entry.name.toLowerCase()));
        for (const ref of model.resourceRefs) {
            if (!declared.has(ref.name.toLowerCase()) && !importedResources.has(ref.name.toLowerCase())) {
                const range = new vscode.Range(ref.line, ref.character, ref.line, ref.character + ref.name.length + 1);
                const diagnostic = new vscode.Diagnostic(range,
                    `DUI4007: '@${ref.name}' names no entry in a resources block`,
                    vscode.DiagnosticSeverity.Warning);
                diagnostic.code = 'DUI4007';
                diagnostic.source = 'dui';
                diagnostics.push(diagnostic);
            }
        }

        // Unknown tags, only when symbols are loaded and only as information: a tag can also be an
        // asset path, and the compiler's own message is the real verdict.
        const symbols = store.symbols;
        if (symbols) {
            const visit = (node: OutlineNode): void => {
                if (node.kind === 'node' && !symbols.tags[node.tag] && !node.tag.startsWith('/')) {
                    const text = document.lineAt(node.line).text;
                    const at = Math.max(0, text.indexOf(node.tag));
                    diagnostics.push(new vscode.Diagnostic(
                        new vscode.Range(node.line, at, node.line, at + node.tag.length),
                        `'${node.tag}' is not a built-in tag (the compiler also accepts /asset paths)`,
                        vscode.DiagnosticSeverity.Information));
                }
                node.children.forEach(visit);
            };
            model.outline.forEach(visit);
        }

        collection.set(document.uri, diagnostics);
    };

    const refreshVisible = (): void => {
        for (const editor of vscode.window.visibleTextEditors) {
            void refresh(editor.document);
        }
    };

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => void refresh(document)));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => void refresh(event.document)));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => collection.delete(document.uri)));
    context.subscriptions.push(store.onDidChange(refreshVisible));
    if (host) {
        // A library arrived, changed or left: any visible file may import it. Coalesced, because the
        // sweep announces one file at a time and every keystroke announces the file being typed in.
        let pending: ReturnType<typeof setTimeout> | undefined;
        context.subscriptions.push(host.onDidChange(() => {
            if (pending !== undefined) {
                clearTimeout(pending);
            }
            pending = setTimeout(() => {
                pending = undefined;
                refreshVisible();
            }, 100);
        }));
        context.subscriptions.push({ dispose: () => { if (pending !== undefined) { clearTimeout(pending); } } });
    }
    refreshVisible();
}
