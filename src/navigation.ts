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
}
