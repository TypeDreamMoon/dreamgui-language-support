/**
 * The commands that treat the Unreal editor as this language's preview surface: reveal (open the
 * designer on this class, selecting the node under the cursor), compile-now (verdicts arrive
 * through the diagnostics mailbox, so the Problems panel is the answer), and reveal-asset (sync
 * the content browser to a package path, which is what the document links in documentLinks.ts
 * are pointed at). Slint previews in a widget; .dui previews in the real designer -- the bridge
 * just takes you there.
 */
import * as vscode from 'vscode';
import { BridgeClient } from './bridge';
import { buildModel } from './docmodel';
import { StructNode, StructureResult } from './core/structure';

/** The innermost node whose header-or-body span covers the offset. */
function nodeIdAt(structure: StructureResult, offset: number): string | undefined {
    let best: StructNode | undefined;
    const visit = (node: StructNode): void => {
        const end = node.bodyEnd ?? node.start + node.tag.length + 1 + node.id.length;
        if (node.start <= offset && offset <= end && (!best || node.start >= best.start)) {
            if (node.kind !== 'loop' && node.id) {
                best = node;
            }
        }
        node.children.forEach(visit);
    };
    structure.roots.forEach(visit);
    return best?.id;
}

export function registerBridgeCommands(context: vscode.ExtensionContext, bridge: BridgeClient): void {
    const currentClassPath = (editor: vscode.TextEditor): string | undefined => {
        const model = buildModel(editor.document);
        const classPath = model.structure.classPath?.path;
        if (!classPath) {
            void vscode.window.showErrorMessage(
                'DreamUI: this file has no class line — add `class /Game/...` so the bridge knows which Blueprint it is.');
        }
        return classPath;
    };

    const requireEditorSide = (documentPath: string): boolean => {
        if (bridge.livenessFor(documentPath) === 'closed') {
            void vscode.window.showErrorMessage(
                'DreamUI: no Unreal editor is listening — open the project in Unreal first.');
            return false;
        }
        return true;
    };

    context.subscriptions.push(vscode.commands.registerTextEditorCommand('dreamui.revealInDesigner',
        async (editor) => {
            const classPath = currentClassPath(editor);
            if (!classPath || !requireEditorSide(editor.document.uri.fsPath)) {
                return;
            }
            const model = buildModel(editor.document);
            const widgetId = nodeIdAt(model.structure, editor.document.offsetAt(editor.selection.active));
            const response = await bridge.send(editor.document.uri.fsPath, 'reveal',
                { classPath, widgetId }, 15000);
            if (!response) {
                void vscode.window.showErrorMessage('DreamUI: the editor did not answer in time.');
            } else if (!response.ok) {
                void vscode.window.showErrorMessage(`DreamUI: ${response.message}`);
            } else if (response.message.includes('no widget named')) {
                void vscode.window.showInformationMessage(`DreamUI: ${response.message}`);
            }
        }));

    // Not a text-editor command: it is invoked from a document link, and the argument is the
    // path the link carried. The document only supplies the project to ask -- which .dui is in
    // front decides which editor holds the asset registry.
    context.subscriptions.push(vscode.commands.registerCommand('dreamui.revealAsset',
        async (assetPath?: string) => {
            if (typeof assetPath !== 'string' || assetPath.length === 0) {
                return;
            }
            const documentPath = vscode.window.activeTextEditor?.document.uri.fsPath;
            if (!documentPath || !requireEditorSide(documentPath)) {
                return;
            }
            const response = await bridge.send(documentPath, 'revealAsset', { assetPath }, 15000);
            if (!response) {
                void vscode.window.showErrorMessage('DreamUI: the editor did not answer in time.');
            } else if (!response.ok) {
                void vscode.window.showErrorMessage(`DreamUI: ${response.message}`);
            }
        }));

    context.subscriptions.push(vscode.commands.registerTextEditorCommand('dreamui.compileFile',
        async (editor) => {
            const classPath = currentClassPath(editor);
            if (!classPath || !requireEditorSide(editor.document.uri.fsPath)) {
                return;
            }
            if (editor.document.isDirty) {
                await editor.document.save(); // the compiler reads the file, not this buffer
            }
            const response = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'DreamUI: compiling…' },
                () => bridge.send(editor.document.uri.fsPath, 'compile', { classPath }, 60000));
            if (!response) {
                void vscode.window.showErrorMessage('DreamUI: the editor did not answer in time.');
            } else if (!response.ok) {
                void vscode.window.showErrorMessage(`DreamUI: ${response.message}`);
            } else {
                void vscode.window.setStatusBarMessage(
                    `DreamUI: compiled — diagnostics are in the Problems panel`, 5000);
            }
        }));
}
