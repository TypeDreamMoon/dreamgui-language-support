/**
 * Colour chips and the picker, over the core's colour spans. Every hex literal gets a chip --
 * node properties, style bodies, resources entries alike. `@Name` references get none: a picker
 * edit REPLACES its range, and silently turning a reference into a literal is the one edit this
 * feature must never make.
 */
import * as vscode from 'vscode';
import { buildModel } from './docmodel';
import { collectColors, formatHex } from './core/colors';

export function registerColors(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.languages.registerColorProvider({ language: 'dui' }, {
        provideDocumentColors(document) {
            const model = buildModel(document);
            return collectColors(model.structure.tokens).map((span) => new vscode.ColorInformation(
                new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)),
                new vscode.Color(span.red, span.green, span.blue, span.alpha)));
        },
        provideColorPresentations(color, colorContext) {
            const original = colorContext.document.getText(colorContext.range);
            const previousDigits = Math.max(0, original.length - 1); // minus the '#'
            const label = formatHex(color.red, color.green, color.blue, color.alpha, previousDigits);
            return [new vscode.ColorPresentation(label)];
        },
    }));
}
