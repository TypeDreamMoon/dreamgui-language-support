/**
 * The cheap checks, on every edit: what can be told from one file and a symbols dump, at severities
 * that respect what this extension cannot know. The COMPILER is the authority; nothing here may
 * claim an error the compiler would accept, so anything that depends on classes this file cannot
 * see is a warning at most, and most things are quieter than that.
 */
import * as vscode from 'vscode';
import { SymbolStore } from './symbols';
import { buildModel } from './docmodel';

export function registerDiagnostics(context: vscode.ExtensionContext, store: SymbolStore): void {
    const collection = vscode.languages.createDiagnosticCollection('dui');
    context.subscriptions.push(collection);

    const refresh = (document: vscode.TextDocument) => {
        if (document.languageId !== 'dui') {
            return;
        }
        store.ensureLoadedFor(document.uri.fsPath);
        const model = buildModel(document);
        const diagnostics: vscode.Diagnostic[] = [];

        // Brace balance: the one thing that is an error from any distance.
        if (model.firstUnmatchedClose) {
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(model.firstUnmatchedClose, model.firstUnmatchedClose.translate(0, 1)),
                "'}' closes nothing", vscode.DiagnosticSeverity.Error));
        } else if (model.braceBalance > 0) {
            const last = document.lineAt(Math.max(0, document.lineCount - 1)).range;
            diagnostics.push(new vscode.Diagnostic(last,
                `${model.braceBalance} block(s) never closed`, vscode.DiagnosticSeverity.Error));
        }

        // '@Name' against this file's own resources block. DUI4007 is the compiler's code for the
        // same refusal; using it here means the squiggle and the compile error read as one fact.
        const declared = new Set(model.resources.map((entry) => entry.name));
        for (const ref of model.resourceRefs) {
            if (!declared.has(ref.name)) {
                const range = new vscode.Range(ref.line, ref.character, ref.line, ref.character + ref.name.length + 1);
                const diagnostic = new vscode.Diagnostic(range,
                    `DUI4007: '@${ref.name}' names no entry in a resources block`,
                    vscode.DiagnosticSeverity.Warning);
                diagnostic.code = 'DUI4007';
                diagnostics.push(diagnostic);
            }
        }

        // Duplicate resource names -- the compiler's DUI3014, told a compile earlier.
        const seen = new Map<string, number>();
        for (const entry of model.resources) {
            const first = seen.get(entry.name);
            if (first !== undefined) {
                const start = entry.nameStart >= 0 ? entry.nameStart : 0;
                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(entry.line, start, entry.line, start + entry.name.length),
                    `DUI3014: resource '${entry.name}' is declared twice (first on line ${first + 1})`,
                    vscode.DiagnosticSeverity.Warning);
                diagnostic.code = 'DUI3014';
                diagnostics.push(diagnostic);
            } else {
                seen.set(entry.name, entry.line);
            }
        }

        // Unknown style bases, same one-file logic.
        const styleNames = new Set(model.styles.map((style) => style.name));
        for (const style of model.styles) {
            if (style.base && !styleNames.has(style.base)) {
                const text = document.lineAt(style.line).text;
                const at = Math.max(0, text.indexOf(style.base));
                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(style.line, at, style.line, at + style.base.length),
                    `DUI3004: style '${style.name}' inherits '${style.base}', which this file does not declare`,
                    vscode.DiagnosticSeverity.Warning);
                diagnostic.code = 'DUI3004';
                diagnostics.push(diagnostic);
            }
        }

        // Unknown tags, only when symbols are loaded and only as information: a tag can also be an
        // asset path, and the compiler's own message is the real verdict.
        const symbols = store.symbols;
        if (symbols) {
            for (const line of walkOutline(model.outline)) {
                if (!symbols.tags[line.tag] && !line.tag.startsWith('/')) {
                    const text = document.lineAt(line.line).text;
                    const at = Math.max(0, text.indexOf(line.tag));
                    const diagnostic = new vscode.Diagnostic(
                        new vscode.Range(line.line, at, line.line, at + line.tag.length),
                        `'${line.tag}' is not a built-in tag (the compiler also accepts /asset paths)`,
                        vscode.DiagnosticSeverity.Information);
                    diagnostics.push(diagnostic);
                }
            }
        }

        collection.set(document.uri, diagnostics);
    };

    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(refresh));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document)));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => collection.delete(document.uri)));
    context.subscriptions.push(store.onDidChange(() => {
        for (const editor of vscode.window.visibleTextEditors) {
            refresh(editor.document);
        }
    }));
    for (const editor of vscode.window.visibleTextEditors) {
        refresh(editor.document);
    }
}

function* walkOutline(nodes: { tag: string; line: number; children: any[] }[]): Generator<{ tag: string; line: number }> {
    for (const node of nodes) {
        yield node;
        yield* walkOutline(node.children);
    }
}
