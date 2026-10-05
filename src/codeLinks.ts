/**
 * A diagnostic's code as VS Code shows it: `DUI3001`, linked to the docs site's entry for it (Problems
 * and the hover make the code clickable). A linked code is an object, no longer equal to 'DUI3001', so
 * everything that reads a code back goes through codeText.
 */
import * as vscode from 'vscode';
import { codeDocUrl } from './core/codes';
import { formatCode } from './core/scanner';

export function linkedCode(code: number): vscode.Diagnostic['code'] {
    return { value: formatCode(code), target: vscode.Uri.parse(codeDocUrl(code, vscode.env.language)) };
}

/** 'DUI3001' for a code however it is carried, plain or linked; '' for none. */
export function codeText(code: vscode.Diagnostic['code']): string {
    return typeof code === 'object' ? String(code.value) : String(code ?? '');
}
