/**
 * Completion, hover and outline, all reading the same three sources: the plugin's symbols file for
 * what the LANGUAGE knows, the document model for what THIS FILE declares, and the workspace index
 * for what the file borrows -- the component aliases, namespaces, styles and resources its `use`
 * lines bring in. Go-to-definition lives in navigation.ts, over the same core answers.
 *
 * Every judgement is in core (completionContext, componentIntel, symbolFacts); this file maps the
 * answers onto vscode's item kinds and snippets.
 */
import * as vscode from 'vscode';
import { SymbolStore, PropertyInfo } from './symbols';
import { buildModel, scopeAt, NodeScope, OutlineNode } from './docmodel';
import { analyzeLine } from './core/completionContext';
import { WorkspaceIndexHost } from './workspace';
import { WorkspaceIndex } from './core/workspaceIndex';
import {
    borrowableNames, namespacesVisibleFrom, namespaceMembers, componentFacts, ComponentFacts, hoverAt,
    anonymousNodeAt, propSignature, eventSignature, baseName,
} from './core/componentIntel';
import { tailsAfter, ViewModelMember } from './core/symbolFacts';
import { memberRunAt, viewModelClassNames, viewModelMembersAt } from './core/viewModelIntel';
import { PROP_TYPES, RESOURCE_TYPES, TOP_LEVEL_KEYWORDS } from './core/vocabulary';

/** Re-opens the suggest widget after an item that leaves the cursor where another choice is due (`emit `, `nier.`). */
const RETRIGGER: vscode.Command = { command: 'editor.action.triggerSuggest', title: 'suggest' };

function propertyItem(info: PropertyInfo, label = info.name): vscode.CompletionItem {
    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Property);
    item.detail = info.enum ?? info.type;
    item.insertText = `${label} = `;
    item.command = RETRIGGER;
    const documentation = new vscode.MarkdownString();
    if (info.tooltip) {
        documentation.appendMarkdown(info.tooltip);
    }
    if (info.default !== undefined) {
        documentation.appendMarkdown(`${info.tooltip ? '\n\n' : ''}default \`${info.default}\``);
    }
    if (documentation.value) {
        item.documentation = documentation;
    }
    return item;
}

function keywordItem(word: string, insert?: string | vscode.SnippetString, detail?: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Keyword);
    if (insert !== undefined) {
        item.insertText = insert;
    }
    if (detail) {
        item.detail = detail;
    }
    return item;
}

/** A node of this type, with an id to fill in -- or to delete: a node with a block may leave its id out. */
function nodeSnippet(name: string): vscode.SnippetString {
    return new vscode.SnippetString(`${name} \${1:Id} {\n\t$0\n}`);
}

export function registerFeatures(context: vscode.ExtensionContext, store: SymbolStore, host?: WorkspaceIndexHost): void {
    const selector: vscode.DocumentSelector = { language: 'dui' };

    /** The index, once the workspace sweep (and this file's own root) has been read. */
    const indexFor = async (document: vscode.TextDocument): Promise<WorkspaceIndex | undefined> => {
        if (!host) {
            return undefined;
        }
        await host.ensureScannedFor(document.uri.scheme === 'file' ? document.uri.fsPath : undefined);
        return host.index;
    };

    // ---- completion ----------------------------------------------------------------------------
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
        async provideCompletionItems(document, position) {
            store.ensureLoadedFor(document.uri.fsPath);
            const line = document.lineAt(position.line).text.slice(0, position.character);
            const model = buildModel(document);
            const scope = scopeAt(document, position);
            const file = document.uri.fsPath;
            const items: vscode.CompletionItem[] = [];
            const lineContext = analyzeLine(line);
            const index = await indexFor(document);
            const symbols = store.symbols;
            const structure = model.structure;

            // `Player.▌`, `Player.Stats.▌`, `Item.▌` over a view model's list: the members of the class the path
            // reaches, from the plugin's export. What is offered follows what the path is for: a route calls a
            // function, `<->` writes a property back, a loop draws from an array, an expression reads anything.
            const viewModelRun = viewModelMembersAt(symbols, structure, line, document.offsetAt(position));
            if (viewModelRun) {
                const run = memberRunAt(line)!;
                const before = line.slice(0, line.length - run.segments.join('.').length - run.partial.length - 1);
                const purpose = /(?:->|\+=|=)\s*$/u.test(before) && !/(?:<-|<->|==|!=|<=|>=)\s*$/u.test(before) ? 'route'
                    : /<->\s*$/u.test(before) ? 'twoWay'
                        : /\bin\s+$/u.test(before) ? 'source' : 'read';
                const fits = (member: ViewModelMember): boolean => {
                    switch (purpose) {
                        case 'route': return member.kind === 'function';
                        case 'twoWay': return member.kind === 'property' && member.writable === true;
                        case 'source': return /^Array<|^Object</u.test(member.type);
                        default: return member.kind === 'property' || member.type !== 'Void';
                    }
                };
                for (const [name, member] of viewModelRun.members) {
                    if (!fits(member)) {
                        continue;
                    }
                    const item = new vscode.CompletionItem(name,
                        member.kind === 'function' ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Field);
                    const params = (member.params ?? []).map((param) => `${param.type} ${param.name}`).join(', ');
                    item.detail = member.kind === 'function'
                        ? `${name}(${params}) → ${member.type}${member.fieldNotify ? ' · FieldNotify' : ''}`
                        : `${member.type}${member.fieldNotify ? ' · FieldNotify' : ' · read every frame'}${member.writable ? ' · writable' : ''}`;
                    if (member.tooltip) {
                        item.documentation = member.tooltip;
                    }
                    if (member.kind === 'function' && purpose === 'read') {
                        item.insertText = new vscode.SnippetString(
                            (member.params ?? []).length === 0 ? `${name}()` : `${name}(\${1:${params}})`);
                    }
                    if (/^Object</u.test(member.type) && purpose !== 'route') {
                        item.command = RETRIGGER;
                    }
                    items.push(item);
                }
                return items;
            }

            const instance = (): ComponentFacts | undefined =>
                index && scope?.kind === 'node' ? componentFacts(index, file, scope.name) : undefined;

            const namespaceItems = (): vscode.CompletionItem[] => (index ? namespacesVisibleFrom(index, file) : [])
                .map((namespace) => {
                    const item = new vscode.CompletionItem(namespace.name, vscode.CompletionItemKind.Module);
                    item.detail = `namespace — ${baseName(namespace.file)}`;
                    item.insertText = `${namespace.name}.`;
                    item.command = RETRIGGER;
                    return item;
                });

            /** Resources by bare name: the file's own (with their values), then what plain imports bring. */
            const resourceItems = (prefix: string): vscode.CompletionItem[] => {
                const out: vscode.CompletionItem[] = [];
                const seen = new Set<string>();
                for (const entry of model.resources) {
                    seen.add(entry.name.toLowerCase());
                    const item = new vscode.CompletionItem(`${prefix}${entry.name}`, vscode.CompletionItemKind.Constant);
                    item.detail = `${entry.type} = ${entry.valueText}`;
                    out.push(item);
                }
                for (const entry of index ? borrowableNames(index, file, 'resource') : []) {
                    if (seen.has(entry.name.toLowerCase())) {
                        continue;
                    }
                    const item = new vscode.CompletionItem(`${prefix}${entry.name}`, vscode.CompletionItemKind.Constant);
                    item.detail = `${entry.type ?? 'resource'} — ${baseName(entry.file)}`;
                    out.push(item);
                }
                return out;
            };

            /** Every node type this file can write: tags, containers, registry widgets, aliases, namespaces. */
            const nodeTypeItems = (sortPrefix = ''): vscode.CompletionItem[] => {
                const out: vscode.CompletionItem[] = [];
                for (const type of store.nodeTypes()) {
                    const item = new vscode.CompletionItem(type.name,
                        type.kind === 'container' ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.Struct);
                    item.detail = type.kind;
                    item.insertText = nodeSnippet(type.name);
                    item.sortText = `${sortPrefix}${type.name}`;
                    out.push(item);
                }
                for (const alias of index ? index.aliasesVisibleFrom(file) : []) {
                    const item = new vscode.CompletionItem(alias.name, vscode.CompletionItemKind.Class);
                    item.detail = `component — ${alias.target}`;
                    item.insertText = nodeSnippet(alias.name);
                    item.sortText = `${sortPrefix}${alias.name}`;
                    out.push(item);
                }
                for (const item of namespaceItems()) {
                    item.sortText = `${sortPrefix}${item.label as string}`;
                    out.push(item);
                }
                return out;
            };

            /** The property face a statement in this scope can name. */
            const propertyFace = (target: NodeScope | undefined): PropertyInfo[] => {
                if (target?.kind === 'component') {
                    return store.componentInfo(target.name)?.properties ?? [];
                }
                if (target?.kind === 'style') {
                    return store.propertiesForStyle();
                }
                if (target?.kind === 'slotLines') {
                    return symbols?.slotProperties ?? [];
                }
                return store.propertiesForTag(target?.kind === 'node' ? target.name : undefined);
            };

            switch (lineContext.kind) {
                case 'resourceRef': {
                    // `@nier.▌`: the library's resources, by the part after the dot.
                    if (lineContext.namespace !== undefined) {
                        for (const entry of index ? namespaceMembers(index, file, lineContext.namespace, 'resource') : []) {
                            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Constant);
                            item.detail = `${entry.type ?? 'resource'} — ${lineContext.namespace} (${baseName(entry.file)})`;
                            items.push(item);
                        }
                        return items;
                    }
                    items.push(...resourceItems(''), ...namespaceItems());
                    // `Text = "OK" @key("Dialog.Confirm")`: the key a string is localized under.
                    if (/"\s*@[\w -￿]*$/u.test(line)) {
                        items.push(keywordItem('key', new vscode.SnippetString('key("${1:Key}")'),
                            'the localization key of this string'));
                    }
                    return items;
                }

                case 'annotation': {
                    if (scope?.kind === 'node' || scope?.kind === 'style' || scope?.kind === 'branch') {
                        if (scope.kind !== 'branch') {
                            items.push(keywordItem('slot', 'slot ', 'a panel-slot line: @slot Name = Value'));
                            items.push(keywordItem('fill', 'fill', '@slot SizeRule = Fill (@fill 2: and FillWeight = 2)'));
                        }
                    }
                    // `@Row Audio { … }`: an Asset resource naming a widget class is a node type too.
                    if (scope?.kind !== 'style' && scope?.kind !== 'component' && scope?.kind !== 'slotLines') {
                        for (const entry of model.resources.filter((resource) => resource.type === 'Asset')) {
                            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Class);
                            item.detail = `Asset = ${entry.valueText}`;
                            item.insertText = nodeSnippet(entry.name);
                            items.push(item);
                        }
                    }
                    return items;
                }

                case 'value': {
                    // After '=': the value. Enum values when the property names an enum; booleans; resources.
                    // A decimal point mid-number is no place for a list.
                    if (/\d\.$/u.test(line)) {
                        return items;
                    }
                    const isSlot = lineContext.isSlot || scope?.kind === 'slotLines';
                    const list = isSlot ? symbols?.slotProperties ?? [] : propertyFace(scope);
                    const info = store.findProperty(list, lineContext.property);
                    for (const value of store.enumValues(info?.enum)) {
                        items.push(new vscode.CompletionItem(value, vscode.CompletionItemKind.EnumMember));
                    }
                    const prop = instance()?.summary?.props.find(
                        (entry) => entry.name.toLowerCase() === lineContext.property.toLowerCase());
                    if (info?.type === 'bool' || prop?.type === 'Bool') {
                        items.push(new vscode.CompletionItem('true', vscode.CompletionItemKind.Value));
                        items.push(new vscode.CompletionItem('false', vscode.CompletionItemKind.Value));
                    }
                    items.push(...resourceItems('@'));
                    return items;
                }

                case 'componentName': {
                    // After '+': components, from the compiler's own resolvable set.
                    for (const [name, info] of Object.entries(symbols?.components ?? {})) {
                        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
                        item.detail = info.class;
                        item.insertText = new vscode.SnippetString(`${name} {\n\t$0\n}`);
                        items.push(item);
                    }
                    return items;
                }

                case 'slotPropertyName': {
                    for (const info of symbols?.slotProperties ?? []) {
                        items.push(propertyItem(info));
                    }
                    return items;
                }

                case 'styleRef': {
                    if (lineContext.namespace !== undefined) {
                        for (const entry of index ? namespaceMembers(index, file, lineContext.namespace, 'style') : []) {
                            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Color);
                            item.detail = `style — ${lineContext.namespace} (${baseName(entry.file)})`;
                            items.push(item);
                        }
                        return items;
                    }
                    const seen = new Set<string>();
                    for (const style of model.styles) {
                        seen.add(style.name.toLowerCase());
                        items.push(new vscode.CompletionItem(style.name, vscode.CompletionItemKind.Color));
                    }
                    for (const style of index ? borrowableNames(index, file, 'style') : []) {
                        if (!seen.has(style.name.toLowerCase())) {
                            const item = new vscode.CompletionItem(style.name, vscode.CompletionItemKind.Color);
                            item.detail = `style — ${baseName(style.file)}`;
                            items.push(item);
                        }
                    }
                    items.push(...namespaceItems());
                    return items;
                }

                case 'expression': {
                    // `Item.▌` is a member run, and bindingIntel answers it from the loop's item type.
                    if (/[\w -￿]\.[\w -￿]*$/u.test(line)) {
                        return items;
                    }
                    // The file's props are variables of its class: a binding reads them like any other (`<-`), a
                    // condition and a loop source too. A prop has no setter, so `<->` cannot mirror one.
                    if (lineContext.op !== '<->') {
                        for (const prop of structure.props ?? []) {
                            const item = new vscode.CompletionItem(prop.name, vscode.CompletionItemKind.Variable);
                            item.detail = `prop — ${propSignature(prop)}`;
                            items.push(item);
                        }
                    }
                    if (lineContext.op !== '<->' && lineContext.op !== 'in') {
                        items.push(...resourceItems('@'));
                        items.push(new vscode.CompletionItem('true', vscode.CompletionItemKind.Value));
                        items.push(new vscode.CompletionItem('false', vscode.CompletionItemKind.Value));
                    }
                    return items;
                }

                case 'route': {
                    // The handlers are the class's, and bridgeCompletion asks the editor for them; `emit` is the
                    // language's own answer, and needs nothing but this file's `events`.
                    const emit = keywordItem('emit', 'emit ', 'raise an event this file declares');
                    emit.command = RETRIGGER;
                    items.push(emit);
                    return items;
                }

                case 'emitTarget': {
                    for (const event of structure.events ?? []) {
                        const item = new vscode.CompletionItem(event.name, vscode.CompletionItemKind.Event);
                        item.detail = eventSignature(event);
                        item.insertText = event.params.length === 0 ? event.name : new vscode.SnippetString(
                            `${event.name}(${event.params.map((param, at) => `\${${at + 1}:${param.name}}`).join(', ')})`);
                        items.push(item);
                    }
                    return items;
                }

                case 'keyword':
                    return lineContext.words.map((word) => keywordItem(word, `${word} `));

                case 'slotName': {
                    // Inside an instance, the slots its component declares, to fill; elsewhere a new slot's name.
                    for (const slot of instance()?.summary?.slots ?? []) {
                        const item = new vscode.CompletionItem(slot.name, vscode.CompletionItemKind.Field);
                        item.detail = slot.isDefault ? 'slot (default — nesting fills it too)' : 'slot';
                        item.insertText = new vscode.SnippetString(`${slot.name} {\n\t$0\n}`);
                        items.push(item);
                    }
                    return items;
                }

                case 'eventParam': {
                    if (scope?.kind === 'events' && lineContext.position === 'type') {
                        for (const type of symbols?.propTypes ?? PROP_TYPES) {
                            items.push(keywordItem(type, `${type} `, 'parameter type'));
                        }
                    }
                    return items;
                }

                case 'dotted': {
                    const head = lineContext.head;
                    // `nier.▌`: the library's components; `Native.▌`: the registry's widgets; `AnchorData.▌`: the
                    // rest of a property path. Each offered by the part after the dot.
                    for (const alias of index ? namespaceMembers(index, file, head, 'alias') : []) {
                        const item = new vscode.CompletionItem(alias.name, vscode.CompletionItemKind.Class);
                        item.detail = `component — ${head}.${alias.name}`;
                        item.insertText = nodeSnippet(alias.name);
                        items.push(item);
                    }
                    if (scope?.kind !== 'props' && scope?.kind !== 'events' && scope?.kind !== 'resources') {
                        for (const { tail, entry } of tailsAfter(store.nodeTypes(), head)) {
                            const item = new vscode.CompletionItem(tail, vscode.CompletionItemKind.Struct);
                            item.detail = entry.kind;
                            item.insertText = nodeSnippet(tail);
                            items.push(item);
                        }
                    }
                    const face = scope?.kind === 'node' || scope?.kind === 'style' || scope?.kind === 'component'
                        || scope?.kind === 'slotLines' ? propertyFace(scope) : [];
                    for (const { tail, entry } of tailsAfter(face, head)) {
                        items.push(propertyItem(entry, tail));
                    }
                    return items;
                }

                case 'nodeId':
                    // A name being chosen: nothing that exists can complete it.
                    return items;

                case 'statement':
                    break;
            }

            // ---- statement position: what the scope may hold -------------------------------------------------
            switch (scope?.kind) {
                case 'style': {
                    // The union property face -- any tag may wear this style, so any tag's properties are honest
                    // offers -- and the slot lines and components a style may carry.
                    for (const property of store.propertiesForStyle()) {
                        items.push(propertyItem(property));
                    }
                    items.push(keywordItem('@slot', '@slot '), keywordItem('@fill', '@fill'));
                    const plus = new vscode.CompletionItem('+', vscode.CompletionItemKind.Operator);
                    plus.insertText = '+ ';
                    plus.detail = 'attach a behaviour or layout';
                    items.push(plus);
                    return items;
                }
                case 'resources': {
                    // The five type keywords lead every entry.
                    for (const type of symbols?.resourceTypes ?? RESOURCE_TYPES) {
                        const item = keywordItem(type, `${type} `, 'resource type');
                        item.kind = vscode.CompletionItemKind.TypeParameter;
                        items.push(item);
                    }
                    return items;
                }
                case 'props': {
                    // `Type Name` or `Type Name = default`, one per line; `Enum` is followed by the enum's path.
                    if (!line.includes('=')) {
                        for (const type of symbols?.propTypes ?? PROP_TYPES) {
                            const item = keywordItem(type, `${type} `, 'prop type');
                            item.kind = vscode.CompletionItemKind.TypeParameter;
                            items.push(item);
                        }
                    }
                    return items;
                }
                case 'events':
                    // An event's name is new by definition; its parameters' types complete inside the parentheses.
                    return items;
                case 'viewmodels': {
                    // `Type Name`, then `= new | global | parent`. The types are the classes the plugin's export
                    // lists; after the name and its '=', the three sources.
                    if (/=\s*\w*$/u.test(line)) {
                        items.push(keywordItem('new', 'new', 'this widget makes one'));
                        items.push(keywordItem('global', 'global', 'from UDreamViewModelSubsystem, by class'));
                        items.push(keywordItem('global "…"', new vscode.SnippetString('global "${1:Name}"'),
                            'from UDreamViewModelSubsystem, by class and name'));
                        items.push(keywordItem('parent', 'parent', "the nearest enclosing widget's view model of this class"));
                        return items;
                    }
                    if (/^\s*[\w/.\u00A0-\uFFFF]*$/u.test(line)) {
                        for (const { name, info } of viewModelClassNames(symbols)) {
                            if (info.abstract) {
                                continue;
                            }
                            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
                            item.detail = info.class ?? 'view model';
                            if (info.tooltip) {
                                item.documentation = info.tooltip;
                            }
                            item.insertText = `${name} `;
                            items.push(item);
                        }
                    }
                    return items;
                }
                case 'slotLines': {
                    for (const info of symbols?.slotProperties ?? []) {
                        items.push(propertyItem(info));
                    }
                    return items;
                }
                case 'component': {
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
                case 'branch':
                case 'loop':
                    // An `if` arm holds widgets only; a loop body is its one template widget.
                    return nodeTypeItems();
                case 'node': {
                    const facts = instance();
                    // An instance's lines set its component's props and route its events.
                    for (const prop of facts?.summary?.props ?? []) {
                        const item = new vscode.CompletionItem(prop.name, vscode.CompletionItemKind.Property);
                        item.detail = `prop — ${propSignature(prop)}`;
                        item.insertText = `${prop.name} = `;
                        item.command = RETRIGGER;
                        item.sortText = `0${prop.name}`;
                        items.push(item);
                    }
                    for (const event of facts?.summary?.events ?? []) {
                        const item = new vscode.CompletionItem(event.name, vscode.CompletionItemKind.Event);
                        item.detail = event.params ? `event — ${event.name}(${event.params})` : 'event';
                        item.insertText = `${event.name} -> `;
                        item.sortText = `0${event.name}`;
                        items.push(item);
                    }
                    for (const slot of facts?.summary?.slots ?? []) {
                        const item = new vscode.CompletionItem(`slot ${slot.name}`, vscode.CompletionItemKind.Field);
                        item.detail = slot.isDefault ? 'fill the default slot (nesting fills it too)' : 'fill this slot';
                        item.insertText = new vscode.SnippetString(`slot ${slot.name} {\n\t$0\n}`);
                        items.push(item);
                    }
                    // Its properties (a container-typed node's include its container's), its events, child
                    // types, and the statements a node body takes.
                    for (const property of store.propertiesForTag(scope.name)) {
                        items.push(propertyItem(property));
                    }
                    for (const event of store.eventsForTag(scope.name)) {
                        const item = new vscode.CompletionItem(event, vscode.CompletionItemKind.Event);
                        item.insertText = `${event} -> `;
                        items.push(item);
                    }
                    items.push(...nodeTypeItems('z')); // properties first, structure second
                    items.push(keywordItem('@slot', '@slot '), keywordItem('@fill', '@fill'));
                    const plus = new vscode.CompletionItem('+', vscode.CompletionItemKind.Operator);
                    plus.insertText = '+ ';
                    plus.detail = 'attach a behaviour or layout';
                    items.push(plus);
                    items.push(keywordItem('if', new vscode.SnippetString('if ${1:Condition} {\n\t$0\n}'),
                        'widgets shown while the condition holds'));
                    items.push(keywordItem('for', new vscode.SnippetString('for ${1:Item} in ${2:Source} {\n\t$0\n}'),
                        'one copy of a widget per item, in this panel'));
                    items.push(keywordItem('each', new vscode.SnippetString('each ${1:Item} in ${2:Source} {\n\t$0\n}'),
                        'a list view\'s cells'));
                    items.push(keywordItem('slot', 'slot ', 'declare a slot a host fills'));
                    return items;
                }
                default: {
                    // Top level: the root's type and the file-scope statements.
                    items.push(...nodeTypeItems());
                    for (const keyword of TOP_LEVEL_KEYWORDS) {
                        items.push(keywordItem(keyword, `${keyword} `));
                    }
                    return items;
                }
            }
        },
    }, '@', '+', '=', ':', ' ', '.'));

    // ---- hover ---------------------------------------------------------------------------------
    context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
        async provideHover(document, position) {
            store.ensureLoadedFor(document.uri.fsPath);
            const model = buildModel(document);
            const offset = document.offsetAt(position);

            // What the file borrows and declares for its hosts: aliases, namespaces, imported styles and
            // resources, props, events, `emit`. Asked first: it knows when a word is one of those.
            const index = await indexFor(document);
            const fact = hoverAt(index, document.uri.fsPath, model.structure, offset);
            if (fact) {
                return new vscode.Hover(new vscode.MarkdownString(fact.markdown),
                    new vscode.Range(document.positionAt(fact.start), document.positionAt(fact.end)));
            }

            const range = document.getWordRangeAtPosition(position, /[@\w. -￿]+/u);
            if (!range) {
                return undefined;
            }
            const word = document.getText(range);

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
            const withTooltip = (md: vscode.MarkdownString, tooltip?: string): vscode.MarkdownString => {
                if (tooltip) {
                    md.appendMarkdown(`\n\n${tooltip}`);
                }
                return md;
            };
            if (symbols?.tags[word]) {
                const info = symbols.tags[word];
                const what = info.kind === 'container' ? `layout container \`${info.class ?? word}\``
                    : info.kind === 'widget' ? `registered widget \`${info.class ?? word}\``
                        : info.class ? `visual class \`${info.class}\`` : 'a plain widget, no visual';
                const md = withTooltip(new vscode.MarkdownString(`**${word}** — ${what}`), info.tooltip);
                // A node written without an id still compiles to one; nothing in the text spells it.
                const unnamed = anonymousNodeAt(model.structure, offset);
                if (unnamed) {
                    md.appendMarkdown(`\n\nunnamed — compiles as \`${unnamed.id}\` (hidden from Blueprint graphs)`);
                }
                return new vscode.Hover(md);
            }
            const component = store.componentInfo(word);
            if (component && /^\s*\+/.test(document.lineAt(position.line).text)) {
                return new vscode.Hover(withTooltip(
                    new vscode.MarkdownString(`**${word}** — \`${component.class}\``), component.tooltip));
            }
            const list = scope?.kind === 'component'
                ? store.componentInfo(scope.name)?.properties ?? []
                : scope?.kind === 'style'
                    ? store.propertiesForStyle()
                    : scope?.kind === 'slotLines'
                        ? symbols?.slotProperties ?? []
                        : store.propertiesForTag(scope?.kind === 'node' ? scope.name : undefined);
            const property = store.findProperty(
                [...list, ...(symbols?.slotProperties ?? [])], word);
            if (property) {
                const md = new vscode.MarkdownString(`\`${property.type}\` **${property.name}**`);
                if (property.default !== undefined) {
                    md.appendMarkdown(` — default \`${property.default}\``);
                }
                withTooltip(md, property.tooltip);
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
            const span = (start: number, end: number): vscode.Range =>
                new vscode.Range(document.positionAt(start), document.positionAt(end));
            const toSymbol = (node: OutlineNode): vscode.DocumentSymbol => {
                let name = node.id || node.tag;
                let detail = node.tag;
                let kind = vscode.SymbolKind.Field;
                if (node.kind === 'branch') {
                    // `if HasSave()` / `else if IsLoading()` / `else`: the arm, its widgets under it.
                    name = node.condition !== undefined ? `${node.tag} ${node.condition}` : node.tag;
                    detail = '';
                    kind = vscode.SymbolKind.Boolean;
                } else if (node.kind === 'loop') {
                    kind = vscode.SymbolKind.Operator;
                } else if (node.kind === 'namedSlot') {
                    kind = vscode.SymbolKind.Key;
                    detail = node.fillsSlot ? 'slot fill' : node.defaultSlot ? 'slot (default)' : 'slot';
                } else if (node.anonymous) {
                    // Named by its type, as the author wrote it; the made-up id is what the designer shows.
                    name = node.tag;
                    detail = node.id;
                }
                const range = span(node.start, Math.max(node.end, node.start + 1));
                const selection = span(node.selectionStart, Math.max(node.selectionEnd, node.selectionStart));
                const symbol = new vscode.DocumentSymbol(name || node.tag, detail, kind, range,
                    range.contains(selection) ? selection : range);
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
            // What the class offers its hosts: the props they set, the events they route. A group spans its
            // first entry's line to its last's, so every child sits inside its parent's range.
            const lines = (first: number, last: number): vscode.Range => new vscode.Range(
                document.lineAt(Math.max(0, first - 1)).range.start, document.lineAt(Math.max(0, last - 1)).range.end);
            const props = model.structure.props ?? [];
            if (props.length > 0) {
                const first = lines(props[0].line, props[props.length - 1].line);
                const group = new vscode.DocumentSymbol('props', '', vscode.SymbolKind.Namespace, first, first);
                for (const prop of props) {
                    const range = document.lineAt(Math.max(0, prop.line - 1)).range;
                    const selection = span(prop.nameStart, prop.nameStart + prop.name.length);
                    group.children.push(new vscode.DocumentSymbol(prop.name,
                        prop.defaultText ? `${prop.type} = ${prop.defaultText}` : prop.type,
                        vscode.SymbolKind.Property, range, range.contains(selection) ? selection : range));
                }
                out.push(group);
            }
            const viewModels = model.structure.viewModels ?? [];
            if (viewModels.length > 0) {
                const first = lines(viewModels[0].line, viewModels[viewModels.length - 1].line);
                const group = new vscode.DocumentSymbol('viewmodels', '', vscode.SymbolKind.Namespace, first, first);
                for (const decl of viewModels) {
                    const range = document.lineAt(Math.max(0, decl.line - 1)).range;
                    const selection = span(decl.nameStart, decl.nameStart + decl.name.length);
                    const source = decl.source === 'host' ? '' : ` = ${decl.source}${decl.sourceName ? ` "${decl.sourceName}"` : ''}`;
                    group.children.push(new vscode.DocumentSymbol(decl.name, `${decl.type}${source}`,
                        vscode.SymbolKind.Variable, range, range.contains(selection) ? selection : range));
                }
                out.push(group);
            }
            const events = model.structure.events ?? [];
            if (events.length > 0) {
                const first = lines(events[0].line, events[events.length - 1].line);
                const group = new vscode.DocumentSymbol('events', '', vscode.SymbolKind.Namespace, first, first);
                for (const event of events) {
                    const range = document.lineAt(Math.max(0, event.line - 1)).range;
                    const selection = span(event.nameStart, event.nameStart + event.name.length);
                    group.children.push(new vscode.DocumentSymbol(event.name, eventSignature(event),
                        vscode.SymbolKind.Event, range, range.contains(selection) ? selection : range));
                }
                out.push(group);
            }
            return out;
        },
    }));
}
