/**
 * Diagnostics, on every edit: wait for what the judging needs, ask src/core/diagnose.ts, translate.
 *
 * Everything this file used to decide now lives in core, where it has tests and no editor. What is
 * left here is the three things only a running vscode can do -- know when to re-judge, know what
 * the workspace and the symbols dump currently hold, and turn offsets into ranges -- and the shell
 * is deliberately thin so that "what does the extension report" is a question with exactly one
 * answer, in one file, reachable from a test.
 */
import * as vscode from 'vscode';
import { SymbolStore } from './symbols';
import { buildModel } from './docmodel';
import { CoreDiagnostic, judgeDocument } from './core/diagnose';
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
        // The import exemptions read the workspace index, and the index is filled by a lazy sweep
        // that only navigation and completion used to ask for. Judging a file before that sweep is
        // what reported DUI3004 on every imported style in a freshly restored window: the `use`
        // resolved to nothing, so nothing was exempt -- and nothing re-judged the file once the
        // library it names was indexed. Wait for the sweep; a document that changed underneath the
        // wait belongs to the refresh that change triggered.
        //
        // ensureScannedFor, not ensureScanned: a file opened on its own, outside every workspace
        // folder, is indexed from a root this host has to go and find, and that search is what the
        // `For` half is.
        if (host) {
            const version = document.version;
            // Only a real file has a root to look for: an untitled buffer's fsPath is a name, and
            // walking up from one lands on the drive root.
            await host.ensureScannedFor(document.uri.scheme === 'file' ? document.uri.fsPath : undefined);
            if (document.isClosed || document.version !== version) {
                return;
            }
        }
        store.ensureLoadedFor(document.uri.fsPath);
        const model = buildModel(document);
        const symbols = store.symbols;
        const judged = judgeDocument({
            file: document.uri.fsPath,
            text: document.getText(),
            // The parse the other providers are already using this keystroke: judging is not worth
            // a second one.
            structure: model.structure,
            index: host?.index,
            tags: symbols ? Object.keys(symbols.tags) : undefined,
        });

        collection.set(document.uri, judged.map((source) => toVscode(document, source)));
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

const SEVERITIES: Record<CoreDiagnostic['severity'], vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
};

function toVscode(document: vscode.TextDocument, source: CoreDiagnostic): vscode.Diagnostic {
    // A zero-width span underlines nothing at all, so an empty one is widened by a character --
    // the end-of-file anchor DUI2006 uses is the one that reaches this.
    const range = new vscode.Range(
        document.positionAt(source.start),
        document.positionAt(Math.max(source.end, source.start + 1)));
    const code = source.code === undefined ? undefined : formatCode(source.code);
    const diagnostic = new vscode.Diagnostic(range,
        code === undefined ? source.message : `${code}: ${source.message}`,
        SEVERITIES[source.severity]);
    diagnostic.code = code;
    diagnostic.source = 'dui';
    return diagnostic;
}
