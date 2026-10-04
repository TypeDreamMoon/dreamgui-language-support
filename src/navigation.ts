/**
 * Cross-file navigation over the workspace index: workspace symbols, definitions that cross
 * files, references. Every provider awaits one lazy workspace sweep, then reads the index the
 * host keeps current.
 *
 * Go-to-definition for the names the component grammar added -- aliases, namespaces, imported
 * styles and resources, props, events, `emit` -- is core/componentIntel's definitionAt; the file's
 * own `@Name` and `: Style` are answered by the same function, so one provider owns them all.
 */
import * as vscode from 'vscode';
import { WorkspaceIndexHost } from './workspace';
import { SymbolSite, referencesAt } from './core/workspaceIndex';
import { definitionAt, DefinitionHit } from './core/componentIntel';
import { buildModel } from './docmodel';

function siteLocation(site: SymbolSite): vscode.Location {
    return new vscode.Location(vscode.Uri.file(site.file),
        new vscode.Position(site.line - 1, site.column - 1));
}

/**
 * A definition target as a vscode range. Offsets are exact, so the target document is read to convert them -- the
 * asking one directly, another through openTextDocument (loaded, not shown). A file that cannot be opened falls back
 * to the line and column the index recorded.
 */
async function targetRange(document: vscode.TextDocument, target: DefinitionHit['target']):
    Promise<{ uri: vscode.Uri; range: vscode.Range } | undefined> {
    const uri = target.file === document.uri.fsPath ? document.uri : vscode.Uri.file(target.file);
    try {
        const targetDocument = uri === document.uri ? document : await vscode.workspace.openTextDocument(uri);
        return {
            uri,
            range: new vscode.Range(targetDocument.positionAt(target.start), targetDocument.positionAt(target.end)),
        };
    } catch {
        if (target.line === undefined || target.column === undefined) {
            return undefined;
        }
        const at = new vscode.Position(target.line - 1, target.column - 1);
        return { uri, range: new vscode.Range(at, at) };
    }
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

    // ---- definition through a use: the quoted spelling -> the file it resolves to --------------
    // Resolution proper is the compiler's (it walks the DUI roots); this mirror answers only when
    // exactly one indexed file's path ends with the spelling. A wrong jump is worse than none.
    context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: 'dui' }, {
        async provideDefinition(document, position) {
            const offset = document.offsetAt(position);
            const imported = buildModel(document).structure.imports.find(
                (entry) => offset >= entry.pathStart && offset <= entry.pathEnd);
            if (!imported) {
                return undefined;
            }
            await host.ensureScanned();
            const matches = host.index.resolveImportSpelling(imported.path);
            if (matches.length !== 1) {
                return undefined;
            }
            const top = new vscode.Range(0, 0, 0, 0);
            const link: vscode.LocationLink = {
                originSelectionRange: new vscode.Range(
                    document.positionAt(imported.pathStart), document.positionAt(imported.pathEnd)),
                targetUri: vscode.Uri.file(matches[0]),
                targetRange: top,
                targetSelectionRange: top,
            };
            return [link];
        },
    }));

    // ---- definition: aliases, namespaces, borrowed styles and resources, props, events, emit ------------
    context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: 'dui' }, {
        async provideDefinition(document, position) {
            await host.ensureScannedFor(document.uri.scheme === 'file' ? document.uri.fsPath : undefined);
            const hit = definitionAt(host.index, document.uri.fsPath, buildModel(document).structure,
                document.offsetAt(position));
            if (!hit) {
                return undefined;
            }
            const target = await targetRange(document, hit.target);
            if (!target) {
                return undefined;
            }
            const link: vscode.LocationLink = {
                originSelectionRange: new vscode.Range(
                    document.positionAt(hit.originStart), document.positionAt(hit.originEnd)),
                targetUri: target.uri,
                targetRange: target.range,
                targetSelectionRange: target.range,
            };
            return [link];
        },
    }));

    // ---- definition across files: a nested '/Game/X' tag -> the .dui whose class line is X -----
    // A.dui never names B.dui; it names the CLASS B.dui compiles into. The index bridges that
    // indirection, so F12 on the tag lands on the declaring file's class line.
    context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: 'dui' }, {
        async provideDefinition(document, position) {
            const range = document.getWordRangeAtPosition(position, /\/[\w/.\u00A0-\uFFFF]+/u);
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

    // ---- references: styles and resources in-file (the language scopes them so), class paths
    // across the workspace. Node ids get no answer on purpose -- their references live in
    // Blueprints, where this layer has no business guessing.
    context.subscriptions.push(vscode.languages.registerReferenceProvider({ language: 'dui' }, {
        async provideReferences(document, position, referenceContext) {
            await host.ensureScanned();
            const answer = referencesAt(host.index, document.uri.fsPath, document.offsetAt(position));
            if (!answer) {
                return undefined;
            }
            const sites = [...answer.uses];
            if (referenceContext.includeDeclaration && answer.declaration) {
                sites.unshift(answer.declaration);
            }
            return sites.map(siteLocation);
        },
    }));
}
