/**
 * "DreamUI: New .dui File" -- the empty-state door. From the explorer context menu the file lands
 * in the clicked folder; from the palette it lands in the workspace's DUI/ directory when there
 * is one. Refuses to overwrite: a create that can silently replace someone's interface is not
 * worth the click it saves.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { duiStarter } from './core/templates';

function defaultDirectory(): string | undefined {
    const active = vscode.window.activeTextEditor?.document;
    if (active && active.uri.scheme === 'file' && active.fileName.toLowerCase().endsWith('.dui')) {
        return path.dirname(active.fileName);
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const dui = path.join(folder.uri.fsPath, 'DUI');
        if (fs.existsSync(dui)) {
            return dui;
        }
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function registerNewFile(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand('dreamui.newFile', async (clicked?: vscode.Uri) => {
        const directory = clicked?.fsPath ?? defaultDirectory();
        if (!directory) {
            vscode.window.showErrorMessage('DreamUI: open a folder first -- a .dui needs somewhere to live.');
            return;
        }

        const name = await vscode.window.showInputBox({
            prompt: `New .dui in ${directory}`,
            value: 'NewPanel',
            validateInput: (value) => {
                if (!value.trim()) {
                    return 'A file needs a name.';
                }
                if (/[\\/:*?"<>|]/.test(value)) {
                    return 'Just the name -- no path separators.';
                }
                return undefined;
            },
        });
        if (!name) {
            return;
        }

        const base = name.endsWith('.dui') ? name.slice(0, -'.dui'.length) : name;
        const filePath = path.join(directory, `${base}.dui`);
        if (fs.existsSync(filePath)) {
            vscode.window.showErrorMessage(`DreamUI: '${path.basename(filePath)}' already exists here.`);
            return;
        }

        fs.writeFileSync(filePath, duiStarter(`${base}.dui`, `/Game/UI/WBP_${base}`, base), 'utf8');
        const document = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(document);
    }));
}
