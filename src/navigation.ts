/**
 * Cross-file navigation over the workspace index: workspace symbols, definitions that cross
 * files, references. Every provider awaits one lazy workspace sweep, then reads the index the
 * host keeps current.
 */
import * as vscode from 'vscode';
import { WorkspaceIndexHost } from './workspace';
import { SymbolSite } from './core/workspaceIndex';

function siteLocation(site: SymbolSite): vscode.Location {
    return new vscode.Location(vscode.Uri.file(site.file),
        new vscode.Position(site.line - 1, site.column - 1));
}

export function registerNavigation(context: vscode.ExtensionContext, host: WorkspaceIndexHost): void {
    // ---- workspace symbols: every id, style and resource in every .dui --------------------------
    context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider({
        async provideWorkspaceSymbols(query) {
            await host.ensureScanned();
            const kindOf = (kind: string): vscode.SymbolKind =>
                kind === 'style' ? vscode.SymbolKind.Class
                    : kind === 'resource' ? vscode.SymbolKind.Constant
                        : vscode.SymbolKind.Field;
            return host.index.findSymbols(query).map((hit) => new vscode.SymbolInformation(
                hit.name, kindOf(hit.kind), hit.detail, siteLocation(hit.site)));
        },
    }));

    // ---- definition across files: a nested '/Game/X' tag -> the .dui whose class line is X -----
    // A.dui never names B.dui; it names the CLASS B.dui compiles into. The index bridges that
    // indirection, so F12 on the tag lands on the declaring file's class line.
    context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: 'dui' }, {
        async provideDefinition(document, position) {
            const range = document.getWordRangeAtPosition(position, /\/[\w/. -￿]+/u);
            if (!range) {
                return undefined;
            }
            const assetPath = document.getText(range);
            await host.ensureScanned();
            const declaring = host.index.fileForClass(assetPath);
            if (!declaring || declaring.file === document.uri.fsPath) {
                return undefined;
            }
            const target = declaring.classPath!;
            const targetSelection = new vscode.Range(
                target.line - 1, target.column - 1,
                target.line - 1, target.column - 1 + target.name.length);
            const link: vscode.LocationLink = {
                originSelectionRange: range,
                targetUri: vscode.Uri.file(declaring.file),
                targetRange: targetSelection,
                targetSelectionRange: targetSelection,
            };
            return [link];
        },
    }));
}
