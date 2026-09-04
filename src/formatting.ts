/**
 * Format Document and Format Selection for .dui, over src/core/format.ts.
 *
 * Two decisions live here rather than in core.
 *
 * Range formatting formats the WHOLE document. A .dui line's indent is decided by the blocks around
 * it, which a selection by definition does not contain, and the two rules that move lines about --
 * folding blank runs and putting a '}' on its own line -- both reach across the edges of any range
 * an author would select. Formatting the visible part against a guessed depth is how a "format
 * selection" leaves a file worse than it found it.
 *
 * What the range does decide is the EDIT: the result is trimmed to the span that actually changed,
 * so a document already in shape produces no edit at all and one with a single bad line produces
 * one small one. That keeps folded regions, decorations and the undo stack from being rebuilt over
 * a whole file for a two-character change.
 */
import * as vscode from 'vscode';
import { formatDui } from './core/format';

export function registerFormatting(context: vscode.ExtensionContext): void {
    const selector: vscode.DocumentSelector = { language: 'dui' };

    const provider: vscode.DocumentFormattingEditProvider & vscode.DocumentRangeFormattingEditProvider = {
        provideDocumentFormattingEdits(document, options) {
            return edits(document, options);
        },
        provideDocumentRangeFormattingEdits(document, _range, options) {
            return edits(document, options);
        },
    };

    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(selector, provider));
    context.subscriptions.push(
        vscode.languages.registerDocumentRangeFormattingEditProvider(selector, provider));
}

function edits(document: vscode.TextDocument, options: vscode.FormattingOptions): vscode.TextEdit[] {
    const text = document.getText();
    const formatted = formatDui(text, {
        indent: options.insertSpaces ? ' '.repeat(Math.max(1, options.tabSize)) : '\t',
        eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
    });
    // Equal covers both "already formatted" and "the guard rail refused": in either case the
    // honest answer to the editor is that there is nothing to do.
    if (formatted === text) {
        return [];
    }
    return [minimalEdit(document, text, formatted)];
}

/** One replacement, with the unchanged head and tail of the file left out of it. */
function minimalEdit(document: vscode.TextDocument, before: string, after: string): vscode.TextEdit {
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) {
        head++;
    }
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head
        && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
        tail++;
    }
    const range = new vscode.Range(
        document.positionAt(head),
        document.positionAt(before.length - tail));
    return vscode.TextEdit.replace(range, after.slice(head, after.length - tail));
}
