/**
 * The three things a live editor can say about a binding expression that no offline dump can:
 * which parameter of which call the cursor is on, what a name in the expression actually is, and
 * what an `each` item's members are.
 *
 * All three read the SAME cache the `<-`/`<->`/`->` completions fill (bridgeCompletion.ts): one
 * `functions` round trip per class answers signature help, hover and the `each` source alike, so
 * hovering after completing costs nothing. And all three fall silent rather than guess -- a
 * closed editor, a file without a class line, a name the class does not carry: no answer is the
 * answer. The rules being mirrored are the compiler's, and where this file leans on one it says
 * which file in the plugin decides it.
 *
 * The parsing lives in core/bindingIntel.ts, where it is tested without an editor at either end;
 * this file is the vscode shell around it.
 */
import * as vscode from 'vscode';
import { BridgeClient } from './bridge';
import { BridgeCompletionCache } from './bridgeCompletion';
import { WorkspaceIndexHost } from './workspace';
import { buildModel } from './docmodel';
import { BridgeFunctionInfo } from './core/bridgeProtocol';
import {
    bindingTailOf, callContextAt, memberPrefixAt, eachScopesOf, eachScopeNamed, parseEachSource,
    signatureLabelOf, findByName, isIdentifier, EachScope,
} from './core/bindingIntel';

/** Identifiers as the scanner spells them: word characters and everything past Latin-1. */
const WORD = /[\w\u00A0-\uFFFF]+/u;

/**
 * `each` scopes for the document as it stands. Recomputed only when the buffer moves: one
 * document is in front of the cursor at a time, so a single slot is the whole cache this needs.
 */
let scopeMemo: { key: string; version: number; scopes: EachScope[] } | undefined;

function eachScopesFor(document: vscode.TextDocument): EachScope[] {
    const key = document.uri.toString();
    if (scopeMemo && scopeMemo.key === key && scopeMemo.version === document.version) {
        return scopeMemo.scopes;
    }
    const scopes = eachScopesOf(buildModel(document).structure, document.getText());
    scopeMemo = { key, version: document.version, scopes };
    return scopes;
}

function classPathOf(document: vscode.TextDocument): string | undefined {
    return buildModel(document).structure.classPath?.path;
}

/** A markdown rendering of one function, the same shape hover and signature help both want. */
function functionMarkdown(info: BridgeFunctionInfo): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString(`\`${signatureLabelOf(info).label}\``);
    if (info.pure) {
        markdown.appendMarkdown('\n\npure');
    }
    if (info.tooltip) {
        markdown.appendMarkdown(`\n\n${info.tooltip}`);
    }
    return markdown;
}

export function registerBindingIntel(
    context: vscode.ExtensionContext,
    bridge: BridgeClient,
    cache: BridgeCompletionCache,
    // Accepted so the wiring in extension.ts stays uniform with the other registrars, and
    // because the moment hover follows a nested class's binding it is the index that says which
    // file to ask about. Nothing here crosses a file yet.
    _workspaceHost?: WorkspaceIndexHost,
): void {
    const selector: vscode.DocumentSelector = { language: 'dui' };

    /** One stat instead of one timeout: a closed editor answers nothing, so do not ask. */
    const editorIsUp = (document: vscode.TextDocument): boolean =>
        bridge.livenessFor(document.uri.fsPath) !== 'closed';

    /**
     * The type an `each` item has, as the reflection layer spells it. A call source resolves
     * through the function's return type, a variable source through the variable's -- the two
     * shapes the compiler's own loop header accepts, and nothing else.
     */
    const itemTypeOf = async (document: vscode.TextDocument, scope: EachScope): Promise<string | undefined> => {
        const classPath = classPathOf(document);
        const source = parseEachSource(scope.sourceText);
        if (!classPath || !source) {
            return undefined;
        }
        if (source.kind === 'call') {
            const callable = await cache.callableFor(document.uri.fsPath, classPath);
            return callable && findByName(callable, source.name)?.returnType;
        }
        const variables = await cache.variablesFor(document.uri.fsPath, classPath);
        return variables && findByName(variables, source.name)?.type;
    };

    // ---- signature help: which argument of which call -------------------------------------------
    // Only `<-` can hold a call at all (`<->` takes a bare variable, `->` a bare handler), but
    // the gate is the arrow rather than which one: a half-typed line is exactly when this helps,
    // and refusing on the arrow the author has not finished changing would be its own defect.
    context.subscriptions.push(vscode.languages.registerSignatureHelpProvider(selector, {
        async provideSignatureHelp(document, position) {
            if (!editorIsUp(document)) {
                return undefined;
            }
            const line = document.lineAt(position.line).text.slice(0, position.character);
            const binding = bindingTailOf(line);
            const call = binding && callContextAt(binding.tail);
            const classPath = classPathOf(document);
            if (!call || !classPath) {
                return undefined;
            }
            const callable = await cache.callableFor(document.uri.fsPath, classPath);
            const info = callable && findByName(callable, call.name);
            if (!info) {
                return undefined;
            }

            const rendered = signatureLabelOf(info);
            const signature = new vscode.SignatureInformation(rendered.label);
            signature.parameters = rendered.parameters.map(
                (span) => new vscode.ParameterInformation(span));
            if (info.tooltip) {
                signature.documentation = new vscode.MarkdownString(info.tooltip);
            }
            const help = new vscode.SignatureHelp();
            help.signatures = [signature];
            help.activeSignature = 0;
            // Past the last parameter the highlight stays on it: the author is typing an argument
            // this function does not take, and blanking the popup hides the very fact that says so.
            help.activeParameter = Math.min(call.argIndex, Math.max(0, signature.parameters.length - 1));
            return help;
        },
    }, { triggerCharacters: ['(', ','], retriggerCharacters: [',', ')'] }));

    // ---- hover: what a name in a binding expression IS ------------------------------------------
    context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
        async provideHover(document, position) {
            if (!editorIsUp(document)) {
                return undefined;
            }
            const range = document.getWordRangeAtPosition(position, WORD);
            const classPath = classPathOf(document);
            if (!range || !classPath) {
                return undefined;
            }
            const word = document.getText(range);
            const lineText = document.lineAt(position.line).text;
            const before = lineText.slice(0, range.start.character);
            // The arrow has to come BEFORE the word: a property name on the left of `<-` is the
            // widget's, and features.ts already hovers those against the symbols dump.
            if (!isIdentifier(word) || !bindingTailOf(before)) {
                return undefined;
            }
            const documentPath = document.uri.fsPath;
            const after = lineText.slice(range.end.character);
            const isCall = /^\s*\(/.test(after);

            if (isCall) {
                const functions = await cache.functionsFor(documentPath, classPath);
                const info = functions && (findByName(functions.callable, word)
                    ?? findByName(functions.bindable, word) ?? findByName(functions.handlers, word));
                return info ? new vscode.Hover(functionMarkdown(info), range) : undefined;
            }

            // `Track.Title`: the dot decides. The base has to be an `each` variable in scope --
            // nothing else in this language owns a member run on the right of an arrow.
            const dotted = /(^|[^\w.\u00A0-\uFFFF])([A-Za-z_\u00A0-\uFFFF][\w\u00A0-\uFFFF]*)\.$/u.exec(before);
            if (dotted) {
                const scope = eachScopeNamed(eachScopesFor(document), document.offsetAt(position), dotted[2]);
                const typePath = scope && await itemTypeOf(document, scope);
                const members = typePath ? await cache.membersFor(documentPath, typePath) : undefined;
                const member = members && findByName(members.list, word);
                if (!member) {
                    return undefined;
                }
                const markdown = new vscode.MarkdownString(`\`${member.type} ${member.name}\``);
                markdown.appendMarkdown(`\n\nmember of \`${members?.elementType ?? typePath}\``);
                if (member.tooltip) {
                    markdown.appendMarkdown(`\n\n${member.tooltip}`);
                }
                return new vscode.Hover(markdown, range);
            }

            const scope = eachScopeNamed(eachScopesFor(document), document.offsetAt(position), word);
            if (scope) {
                const typePath = await itemTypeOf(document, scope);
                const members = typePath ? await cache.membersFor(documentPath, typePath) : undefined;
                const element = members?.elementType ?? typePath;
                const markdown = new vscode.MarkdownString(
                    `\`${word}\` — one item of \`${scope.sourceText}\``);
                if (element) {
                    markdown.appendMarkdown(`\n\n\`${element}\``);
                }
                return new vscode.Hover(markdown, range);
            }

            // A bare name on the right of `->` is a handler, on the right of anything else a
            // variable. Both lists are asked either way: the arrow can be mid-edit, and a name
            // that exists is worth describing whichever list it turned up in.
            const variables = await cache.variablesFor(documentPath, classPath);
            const variable = variables && findByName(variables, word);
            if (variable) {
                const markdown = new vscode.MarkdownString(`\`${variable.type} ${variable.name}\``);
                markdown.appendMarkdown(variable.fieldNotify
                    ? '\n\n**FieldNotify** — changes broadcast; `<->` pushes back through it.'
                    : '\n\nno FieldNotify entry — re-read on the per-frame poll.');
                if (variable.tooltip) {
                    markdown.appendMarkdown(`\n\n${variable.tooltip}`);
                }
                return new vscode.Hover(markdown, range);
            }
            const functions = await cache.functionsFor(documentPath, classPath);
            const handler = functions && (findByName(functions.handlers, word)
                ?? findByName(functions.callable, word));
            return handler ? new vscode.Hover(functionMarkdown(handler), range) : undefined;
        },
    }));

    // ---- `Item.` members inside an `each` body ---------------------------------------------------
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
        async provideCompletionItems(document, position) {
            if (!editorIsUp(document)) {
                return undefined;
            }
            const line = document.lineAt(position.line).text.slice(0, position.character);
            const binding = bindingTailOf(line);
            // `->` routes to a bare handler name; a dot there is not a member run.
            if (!binding || binding.op === '->') {
                return undefined;
            }
            const prefix = memberPrefixAt(binding.tail);
            if (!prefix) {
                return undefined;
            }
            const scope = eachScopeNamed(eachScopesFor(document), document.offsetAt(position), prefix.base);
            const typePath = scope && await itemTypeOf(document, scope);
            if (!typePath) {
                return undefined;
            }
            const members = await cache.membersFor(document.uri.fsPath, typePath);
            return members?.list.map((member) => {
                const item = new vscode.CompletionItem(member.name, vscode.CompletionItemKind.Field);
                item.detail = member.type;
                if (member.tooltip) {
                    item.documentation = new vscode.MarkdownString(member.tooltip);
                }
                return item;
            });
        },
    }, '.'));
}
