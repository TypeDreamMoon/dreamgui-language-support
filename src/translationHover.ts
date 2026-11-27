/**
 * Hover on a .dui string: what every language has for it, from the DreamLoc `.dloc` files beside the project (read only;
 * DreamLoc does not have to be installed for the hover, only its files there). Each language links to its line.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildModel } from './docmodel';
import { dlocPathOf, findEntry, textAt } from './core/translations';

/**
 * The folder that holds the .dui's source folder (the project, or a plugin), and the .dui's path as DreamLoc keys it:
 * `DUI/UI/Settings.dui`. A file under `DreamSource/UI/` is keyed the same way for now -- DreamLoc still spells the source
 * `DUI/...` whatever folder it sits in; the DreamSource layout's Loc step changes that key on both sides together.
 */
export function ownerOf(filePath: string): { owner: string; source: string } | undefined {
    const parts = filePath.split(/[\\/]/);
    const lower = parts.map(part => part.toLowerCase());
    let index = lower.lastIndexOf('dui');
    let ownerEnd = index;
    for (let at = lower.length - 2; at > 0; at--) {
        if (lower[at] === 'ui' && lower[at - 1] === 'dreamsource') {
            if (at > index) {
                index = at;
                ownerEnd = at - 1;
            }
            break;
        }
    }
    if (ownerEnd <= 0 || index === parts.length - 1) {
        return undefined;
    }
    return { owner: parts.slice(0, ownerEnd).join('/'), source: ['DUI', ...parts.slice(index + 1)].join('/') };
}

function escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, match => `\\${match}`).replace(/\n/g, '⏎');
}

export function registerTranslationHover(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.languages.registerHoverProvider({ language: 'dui' }, {
        provideHover(document, position) {
            const where = ownerOf(document.uri.fsPath);
            if (!where) {
                return undefined;
            }
            const dlocRoot = path.join(where.owner, 'DLoc');
            if (!fs.existsSync(dlocRoot)) {
                return undefined;
            }
            const at = textAt(buildModel(document).structure, document.getText(), document.offsetAt(position));
            if (!at) {
                return undefined;
            }
            const cultures = fs.readdirSync(dlocRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
            const rows: string[] = [];
            for (const culture of cultures) {
                const file = path.join(where.owner, dlocPathOf(where.source, culture));
                if (!fs.existsSync(file)) {
                    continue;
                }
                const entry = findEntry(fs.readFileSync(file, 'utf8'), at.key, `${where.source}#${at.nodePath}`);
                if (!entry) {
                    continue;
                }
                const link = vscode.Uri.file(file).with({ fragment: `L${entry.line}` });
                const marks = [entry.stale ? 'stale' : '', entry.state ?? ''].filter(mark => mark).join(', ');
                rows.push(`| [${culture}](${link.toString()}) | ${escapeMarkdown(entry.text)} | ${marks} |`);
            }
            if (rows.length === 0) {
                return undefined;
            }
            const markdown = new vscode.MarkdownString(`**${escapeMarkdown(at.key)}** — ${escapeMarkdown(at.source)}\n\n| | | |\n|---|---|---|\n${rows.join('\n')}\n`);
            markdown.isTrusted = false;
            return new vscode.Hover(markdown);
        },
    }));
}
