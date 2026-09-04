/**
 * Ctrl+click on `/Game/UI/Tex` and the Unreal content browser jumps to it. The link's target is
 * a command URI rather than a file URI on purpose: a package path is not a path on disk (the
 * `.uasset` behind it is named differently and lives somewhere the .dui never says), so the only
 * thing that can resolve it is the editor holding the asset registry -- which is what
 * `dreamui.revealAsset` asks, through the bridge.
 *
 * One position is deliberately NOT linked: a nested tag whose class the workspace can trace back
 * to the .dui declaring it. `navigation.ts` already answers there with a definition, and
 * Ctrl+click prefers a link to a definition -- so linking it would have quietly swapped "jump to
 * the file that declares this widget" for "open the asset". The judgement is `fileForClass`, the
 * same one the definition provider uses, so the two can never disagree about who owns the click.
 *
 * Links are offered whether or not the editor is up: a link that reports "no editor is
 * listening" when clicked is honest, whereas underlining that appears and disappears as the
 * editor starts and stops would read as the extension losing track of the file.
 */
import * as vscode from 'vscode';
import { buildModel } from './docmodel';
import { WorkspaceIndexHost } from './workspace';
import { packageLinkSpans, linksToOffer } from './core/packageLinks';

export function registerDocumentLinks(context: vscode.ExtensionContext, host?: WorkspaceIndexHost): void {
    context.subscriptions.push(vscode.languages.registerDocumentLinkProvider({ language: 'dui' }, {
        async provideDocumentLinks(document) {
            // The index answers nothing before its lazy sweep, and a tag judged too early would
            // be linked exactly when the definition it shadows was about to become available.
            await host?.ensureScanned();
            const model = buildModel(document);
            const spans = packageLinkSpans(model.structure.tokens, document.getText());
            const offered = linksToOffer(spans, (assetPath) => {
                const declaring = host?.index.fileForClass(assetPath);
                // A class line pointing at this very file declares nothing to go TO; that tag
                // keeps its link, matching the definition provider's own self-reference guard.
                return declaring !== undefined && declaring.file !== document.uri.fsPath;
            });
            return offered.map((span) => {
                const link = new vscode.DocumentLink(new vscode.Range(
                    document.positionAt(span.start), document.positionAt(span.end)));
                link.target = vscode.Uri.parse(
                    `command:dreamui.revealAsset?${encodeURIComponent(JSON.stringify([span.path]))}`);
                link.tooltip = 'Reveal in the Unreal content browser';
                return link;
            });
        },
    }));
}
