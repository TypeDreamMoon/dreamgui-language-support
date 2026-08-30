/**
 * Completion, hover, outline and go-to-definition, all reading the same two sources: the plugin's
 * symbols file for what the LANGUAGE knows, the document model for what THIS FILE declares.
 */
import * as vscode from 'vscode';
import { SymbolStore, PropertyInfo } from './symbols';
import { buildModel, scopeAt } from './docmodel';

const TAG_ONLY_KEYWORDS = ['style', 'resources', 'slot', 'for', 'each'];

function propertyItem(info: PropertyInfo): vscode.CompletionItem {
    const item = new vscode.CompletionItem(info.name, vscode.CompletionItemKind.Property);
    item.detail = info.enum ?? info.type;
    item.insertText = `${info.name} = `;
    item.command = { command: 'editor.action.triggerSuggest', title: 'suggest' };
    return item;
}

export function registerFeatures(context: vscode.ExtensionContext, store: SymbolStore): void {
    const selector: vscode.DocumentSelector = { language: 'dui' };

    // ---- completion ----------------------------------------------------------------------------
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
        provideCompletionItems(document, position) {
            store.ensureLoadedFor(document.uri.fsPath);
            const line = document.lineAt(position.line).text.slice(0, position.character);
            const model = buildModel(document);
            const scope = scopeAt(document, position);
            const items: vscode.CompletionItem[] = [];

            // `@` in value position: this file's resources. ('@slot'/'@key' keep working: they are
            // offered too, and the author picking a resource name was the whole point.)
            if (/@[\w -￿]*$/u.test(line)) {
                for (const entry of model.resources) {
                    const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Constant);
                    item.detail = `${entry.type} = ${entry.valueText}`;
                    items.push(item);
                }
                if (scope?.kind === 'node' || scope?.kind === 'component') {
                    const slot = new vscode.CompletionItem('slot', vscode.CompletionItemKind.Keyword);
                    slot.insertText = 'slot ';
                    items.push(slot);
                }
                return items;
            }

            // After '=': the value. Enum values when the property names an enum; booleans; resources.
            const assignment = /([\w. -￿]+)\s*=\s*[\w -￿]*$/u.exec(line);
            if (assignment) {
                const propertyName = assignment[1].trim();
                const list = scope?.kind === 'component'
                    ? store.componentInfo(scope.name)?.properties ?? []
                    : /@slot\s/.test(line)
                        ? store.symbols?.slotProperties ?? []
                        : store.propertiesForTag(scope?.kind === 'node' ? scope.name : undefined);
                const info = store.findProperty(list, propertyName);
                for (const value of store.enumValues(info?.enum)) {
                    items.push(new vscode.CompletionItem(value, vscode.CompletionItemKind.EnumMember));
                }
                if (info?.type === 'bool') {
                    items.push(new vscode.CompletionItem('true', vscode.CompletionItemKind.Value));
                    items.push(new vscode.CompletionItem('false', vscode.CompletionItemKind.Value));
                }
                for (const entry of model.resources) {
                    const item = new vscode.CompletionItem(`@${entry.name}`, vscode.CompletionItemKind.Constant);
                    item.detail = `${entry.type} = ${entry.valueText}`;
                    items.push(item);
                }
                return items;
            }

            // After '+': components, from the compiler's own resolvable set.
            if (/^\s*\+\s*[\w/ -￿]*$/u.test(line)) {
                for (const [name, info] of Object.entries(store.symbols?.components ?? {})) {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
                    item.detail = info.class;
                    item.insertText = new vscode.SnippetString(`${name} {\n\t$0\n}`);
                    items.push(item);
                }
                return items;
            }

            // After '@slot ': the panel slot's properties.
            if (/@slot\s+[\w. -￿]*$/u.test(line)) {
                for (const info of store.symbols?.slotProperties ?? []) {
                    items.push(propertyItem(info));
                }
                return items;
            }

            // After ':' on a node header or style header: this file's styles.
            if (/:\s*[\w -￿]*$/u.test(line) && !/=\s/.test(line)) {
                for (const style of model.styles) {
                    items.push(new vscode.CompletionItem(style.name, vscode.CompletionItemKind.Color));
                }
                return items;
            }

            // Inside a resources block: the five type keywords lead every entry.
            if (scope?.kind === 'resources') {
                for (const type of store.symbols?.resourceTypes ?? ['Color', 'Number', 'Vector2', 'String', 'Asset']) {
                    const item = new vscode.CompletionItem(type, vscode.CompletionItemKind.TypeParameter);
                    item.insertText = `${type} `;
                    items.push(item);
                }
                return items;
            }

            // Line start inside a component block: that class's properties and events.
            if (scope?.kind === 'component') {
                const info = store.componentInfo(scope.name);
                for (const property of info?.properties ?? []) {
                    items.push(propertyItem(property));
                }
                for (const event of info?.events ?? []) {
                    const item = new vscode.CompletionItem(event, vscode.CompletionItemKind.Event);
                    item.insertText = `${event} -> `;
                    items.push(item);
                }
                return items;
            }

            // Line start inside a node: its properties, its events, child tags, and the directives.
            if (scope?.kind === 'node') {
                for (const property of store.propertiesForTag(scope.name)) {
                    items.push(propertyItem(property));
                }
                for (const event of store.eventsForTag(scope.name)) {
                    const item = new vscode.CompletionItem(event, vscode.CompletionItemKind.Event);
                    item.insertText = `${event} -> `;
                    items.push(item);
                }
                for (const tag of Object.keys(store.symbols?.tags ?? {})) {
                    const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Struct);
                    item.insertText = new vscode.SnippetString(`${tag} \${1:Id} {\n\t$0\n}`);
                    item.sortText = `z${tag}`; // properties first, structure second
                    items.push(item);
                }
                const slot = new vscode.CompletionItem('@slot', vscode.CompletionItemKind.Keyword);
                slot.insertText = '@slot ';
                items.push(slot);
                const plus = new vscode.CompletionItem('+', vscode.CompletionItemKind.Operator);
                plus.insertText = '+ ';
                plus.detail = 'attach a behaviour or layout';
                items.push(plus);
                return items;
            }

            // Top level: tags and the top-level keywords.
            for (const tag of Object.keys(store.symbols?.tags ?? {})) {
                const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Struct);
                item.insertText = new vscode.SnippetString(`${tag} \${1:Id} {\n\t$0\n}`);
                items.push(item);
            }
            for (const keyword of TAG_ONLY_KEYWORDS) {
                items.push(new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword));
            }
            return items;
        },
    }, '@', '+', '=', ':', ' '));

    // ---- hover ---------------------------------------------------------------------------------
    context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
        provideHover(document, position) {
            store.ensureLoadedFor(document.uri.fsPath);
            const range = document.getWordRangeAtPosition(position, /[@\w. -￿]+/u);
            if (!range) {
                return undefined;
            }
            const word = document.getText(range);
            const model = buildModel(document);

            if (word.startsWith('@')) {
                const entry = model.resources.find((r) => r.name === word.slice(1));
                if (entry) {
                    return new vscode.Hover(new vscode.MarkdownString(
                        `\`${entry.type} ${entry.name} = ${entry.valueText}\` — resources block, line ${entry.line + 1}`));
                }
                return undefined;
            }

            const scope = scopeAt(document, position);
            const symbols = store.symbols;
            if (symbols?.tags[word]) {
                const info = symbols.tags[word];
                return new vscode.Hover(new vscode.MarkdownString(
                    info.class ? `**${word}** — visual class \`${info.class}\`` : `**${word}** — a plain widget, no visual`));
            }
            const component = store.componentInfo(word);
            if (component && /^\s*\+/.test(document.lineAt(position.line).text)) {
                return new vscode.Hover(new vscode.MarkdownString(`**${word}** — \`${component.class}\``));
            }
            const list = scope?.kind === 'component'
                ? store.componentInfo(scope.name)?.properties ?? []
                : store.propertiesForTag(scope?.kind === 'node' ? scope.name : undefined);
            const property = store.findProperty(
                [...list, ...(symbols?.slotProperties ?? [])], word);
            if (property) {
                const md = new vscode.MarkdownString(`\`${property.type}\` **${property.name}**`);
                const values = store.enumValues(property.enum);
                if (values.length > 0) {
                    md.appendMarkdown(`\n\n${values.map((v) => `\`${v}\``).join(' · ')}`);
                }
                return new vscode.Hover(md);
            }
            return undefined;
        },
    }));

    // ---- outline -------------------------------------------------------------------------------
    context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(selector, {
        provideDocumentSymbols(document) {
            const model = buildModel(document);
            const toSymbol = (node: { tag: string; id: string; line: number; children: any[] }): vscode.DocumentSymbol => {
                const range = document.lineAt(node.line).range;
                const symbol = new vscode.DocumentSymbol(
                    node.id, node.tag, vscode.SymbolKind.Field, range, range);
                symbol.children = node.children.map(toSymbol);
                return symbol;
            };
            const out = model.outline.map(toSymbol);
            for (const style of model.styles) {
                const range = document.lineAt(style.line).range;
                out.push(new vscode.DocumentSymbol(style.name, style.base ? `style : ${style.base}` : 'style',
                    vscode.SymbolKind.Class, range, range));
            }
            if (model.resources.length > 0) {
                const first = document.lineAt(model.resources[0].line).range;
                const resources = new vscode.DocumentSymbol('resources', '', vscode.SymbolKind.Namespace, first, first);
                for (const entry of model.resources) {
                    const range = document.lineAt(entry.line).range;
                    resources.children.push(new vscode.DocumentSymbol(entry.name, entry.type,
                        vscode.SymbolKind.Constant, range, range));
                }
                out.push(resources);
            }
            return out;
        },
    }));

    // ---- definition: @Name -> its entry; a style use -> its declaration ------------------------
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
        provideDefinition(document, position) {
            const range = document.getWordRangeAtPosition(position, /[@\w -￿]+/u);
            if (!range) {
                return undefined;
            }
            const word = document.getText(range);
            const model = buildModel(document);
            if (word.startsWith('@')) {
                const entry = model.resources.find((r) => r.name === word.slice(1));
                if (entry) {
                    return new vscode.Location(document.uri,
                        new vscode.Position(entry.line, entry.nameStart));
                }
                return undefined;
            }
            const before = document.lineAt(position.line).text.slice(0, range.start.character);
            if (/:\s*$/.test(before)) {
                const style = model.styles.find((s) => s.name === word);
                if (style) {
                    return new vscode.Location(document.uri,
                        new vscode.Position(style.line, style.nameStart));
                }
            }
            return undefined;
        },
    }));
}
