/**
 * Editing geometry: folding and smart selection, both straight off the token stream.
 *
 * Folding pairs braces from tokens rather than trusting the line-shape markers in
 * language-configuration (which cannot see `+ Overlay {}` on one line or a block comment at all),
 * and folds comment runs: a multi-line block comment, or two-plus consecutive `//` lines.
 *
 * Selection grows word -> line -> enclosing blocks -> file, the blocks from the same pairing.
 */
import * as vscode from 'vscode';
import { buildModel } from './docmodel';

interface BracePair {
    openLine: number;
    closeLine: number;
    openOffset: number;
    closeEnd: number;
}

function pairBraces(model: ReturnType<typeof buildModel>): BracePair[] {
    const pairs: BracePair[] = [];
    const stack: { line: number; offset: number }[] = [];
    for (const token of model.structure.tokens) {
        if (token.kind === 'openBrace') {
            stack.push({ line: token.line - 1, offset: token.start });
        } else if (token.kind === 'closeBrace') {
            const open = stack.pop();
            if (open) {
                pairs.push({
                    openLine: open.line, closeLine: token.line - 1,
                    openOffset: open.offset, closeEnd: token.end,
                });
            }
        }
    }
    return pairs;
}

export function registerEditing(context: vscode.ExtensionContext): void {
    const selector: vscode.DocumentSelector = { language: 'dui' };

    context.subscriptions.push(vscode.languages.registerFoldingRangeProvider(selector, {
        provideFoldingRanges(document) {
            const model = buildModel(document);
            const ranges: vscode.FoldingRange[] = [];

            for (const pair of pairBraces(model)) {
                if (pair.closeLine > pair.openLine) {
                    ranges.push(new vscode.FoldingRange(pair.openLine, pair.closeLine - 1));
                }
            }

            let run: { start: number; end: number } | undefined;
            const flushRun = () => {
                if (run && run.end > run.start) {
                    ranges.push(new vscode.FoldingRange(run.start, run.end, vscode.FoldingRangeKind.Comment));
                }
                run = undefined;
            };
            for (const comment of model.structure.comments) {
                if (comment.kind === 'block') {
                    flushRun();
                    if (comment.endLine > comment.line) {
                        ranges.push(new vscode.FoldingRange(comment.line - 1, comment.endLine - 1,
                            vscode.FoldingRangeKind.Comment));
                    }
                } else if (run && comment.line - 1 === run.end + 1) {
                    run.end = comment.line - 1;
                } else {
                    flushRun();
                    run = { start: comment.line - 1, end: comment.line - 1 };
                }
            }
            flushRun();
            return ranges;
        },
    }));

    context.subscriptions.push(vscode.languages.registerSelectionRangeProvider(selector, {
        provideSelectionRanges(document, positions) {
            const model = buildModel(document);
            const pairs = pairBraces(model);

            return positions.map((position) => {
                const offset = document.offsetAt(position);

                // Innermost-out: every brace pair containing the offset, smallest first.
                const enclosing = pairs
                    .filter((pair) => pair.openOffset <= offset && offset <= pair.closeEnd)
                    .sort((a, b) => (a.closeEnd - a.openOffset) - (b.closeEnd - b.openOffset));

                const whole = new vscode.SelectionRange(new vscode.Range(
                    document.positionAt(0), document.lineAt(document.lineCount - 1).range.end));
                let chain = whole;
                for (let index = enclosing.length - 1; index >= 0; index--) {
                    const pair = enclosing[index];
                    // The block with its header line, then its interior.
                    const block = new vscode.SelectionRange(new vscode.Range(
                        new vscode.Position(pair.openLine, 0),
                        document.positionAt(pair.closeEnd)), chain);
                    chain = block;
                    if (pair.closeLine > pair.openLine + 1) {
                        chain = new vscode.SelectionRange(new vscode.Range(
                            new vscode.Position(pair.openLine + 1, 0),
                            document.lineAt(pair.closeLine - 1).range.end), chain);
                    }
                }

                const lineRange = document.lineAt(position.line).range;
                if (chain.range.contains(lineRange) && !chain.range.isEqual(lineRange)) {
                    chain = new vscode.SelectionRange(lineRange, chain);
                }
                const word = document.getWordRangeAtPosition(position, /[@#\w. -￿]+/u);
                if (word && chain.range.contains(word) && !chain.range.isEqual(word)) {
                    chain = new vscode.SelectionRange(word, chain);
                }
                return chain;
            });
        },
    }));
}
