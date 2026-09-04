/**
 * Completion that only a live editor can answer: what `<-`, `<->` and `->` can name on THIS
 * class. Handler and binding legality is per-Blueprint -- the function lives on the class being
 * compiled -- so an offline export would always be stale; the bridge asks the editor that holds
 * the truth, and a closed editor degrades to offering nothing rather than guessing.
 *
 * The cache is also the one door for everything else that asks the same questions: signature
 * help, hover and `Item.` members all read it through bindingIntel.ts rather than opening their
 * own round trips. Answers are cached per class path (per TYPE, for members) for a minute: the
 * first keystroke pays the round trip, the rest of the session types against the cache.
 */
import * as vscode from 'vscode';
import { BridgeClient } from './bridge';
import { WorkspaceIndexHost } from './workspace';
import { buildModel } from './docmodel';
import {
    BridgeFunctionInfo, BridgeAssetInfo, BridgeVariableInfo, BridgeMemberInfo,
} from './core/bridgeProtocol';
import { packagePathOf } from './core/workspaceIndex';

const CACHE_TTL_MS = 60_000;

interface FunctionsEntry {
    at: number;
    bindable: BridgeFunctionInfo[];
    handlers: BridgeFunctionInfo[];
    callable: BridgeFunctionInfo[];
}

interface VariablesEntry {
    at: number;
    list: BridgeVariableInfo[];
}

export interface MembersEntry {
    at: number;
    list: BridgeMemberInfo[];
    /** Set when the asked-for type was a container: the element type the members belong to. */
    elementType?: string;
}

export class BridgeCompletionCache {
    private readonly functionsByClass = new Map<string, FunctionsEntry>();
    private readonly variablesByClass = new Map<string, VariablesEntry>();
    private readonly membersByType = new Map<string, MembersEntry>();
    private assets: { at: number; list: BridgeAssetInfo[] } | undefined;

    constructor(private readonly bridge: BridgeClient) {}

    clear(): void {
        this.functionsByClass.clear();
        this.variablesByClass.clear();
        this.membersByType.clear();
        this.assets = undefined;
    }

    async assetsFor(documentPath: string): Promise<BridgeAssetInfo[] | undefined> {
        if (this.assets && Date.now() - this.assets.at < CACHE_TTL_MS) {
            return this.assets.list;
        }
        const response = await this.bridge.send(documentPath, 'assets', {}, 4000);
        if (!response?.ok || !response.assets) {
            return this.assets?.list;
        }
        this.assets = { at: Date.now(), list: response.assets };
        return this.assets.list;
    }

    async functionsFor(documentPath: string, classPath: string): Promise<FunctionsEntry | undefined> {
        const cached = this.functionsByClass.get(classPath);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
            return cached;
        }
        const response = await this.bridge.send(documentPath, 'functions', { classPath }, 4000);
        if (!response?.ok || !response.functions) {
            return cached; // an expired answer beats none while the editor is away
        }
        const entry: FunctionsEntry = {
            at: Date.now(),
            bindable: response.functions.bindable,
            handlers: response.functions.handlers,
            callable: response.functions.callable,
        };
        this.functionsByClass.set(classPath, entry);
        return entry;
    }

    /**
     * Everything a binding EXPRESSION may call. One `functions` round trip answers all three
     * lists, so this rides the same cache entry `<-` and `->` already paid for.
     */
    async callableFor(documentPath: string, classPath: string): Promise<BridgeFunctionInfo[] | undefined> {
        return (await this.functionsFor(documentPath, classPath))?.callable;
    }

    /** The class's Blueprint-visible member variables -- what `<->` mirrors and a bare name reads. */
    async variablesFor(documentPath: string, classPath: string): Promise<BridgeVariableInfo[] | undefined> {
        const cached = this.variablesByClass.get(classPath);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
            return cached.list;
        }
        const response = await this.bridge.send(documentPath, 'variables', { classPath }, 4000);
        if (!response?.ok || !response.variables) {
            return cached?.list; // an expired answer beats none while the editor is away
        }
        const entry: VariablesEntry = { at: Date.now(), list: response.variables };
        this.variablesByClass.set(classPath, entry);
        return entry.list;
    }

    /**
     * The Blueprint-visible properties of one type. Unlike the other two, this is keyed by a
     * string the AUTHOR shapes -- every `Item.` on a half-typed source expression is a different
     * question -- so a REFUSAL is cached too: without that, a type the editor cannot resolve
     * costs a round trip on every keystroke for as long as the expression stays wrong.
     */
    async membersFor(documentPath: string, typePath: string): Promise<MembersEntry | undefined> {
        const key = typePath.trim();
        if (key.length === 0) {
            return undefined;
        }
        const cached = this.membersByType.get(key);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
            return cached;
        }
        const response = await this.bridge.send(documentPath, 'members', { typePath: key }, 4000);
        if (!response) {
            return cached; // no editor: the expired answer, or nothing
        }
        const entry: MembersEntry = response.ok && response.members
            ? { at: Date.now(), list: response.members, elementType: response.elementType }
            : { at: Date.now(), list: [] };
        this.membersByType.set(key, entry);
        return entry;
    }
}

export function registerBridgeCompletion(context: vscode.ExtensionContext, bridge: BridgeClient,
    workspace: WorkspaceIndexHost): BridgeCompletionCache {
    const cache = new BridgeCompletionCache(bridge);

    // Nested-tag position: a '/' opening a statement offers every widget class -- the bridge's
    // registry answer when the editor is up, the workspace's class lines alone when it is not.
    // Both, deduplicated by package path, when both are at hand: the registry knows classes that
    // have no .dui, the index knows ones the editor has not loaded.
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: 'dui' }, {
        async provideCompletionItems(document, position) {
            const line = document.lineAt(position.line).text.slice(0, position.character);
            if (!/^\s*\/[\w/.\u00A0-\uFFFF]*$/u.test(line)) {
                return undefined;
            }
            await workspace.ensureScanned();

            const byPackage = new Map<string, vscode.CompletionItem>();
            for (const info of (await cache.assetsFor(document.uri.fsPath)) ?? []) {
                const item = new vscode.CompletionItem(info.name, vscode.CompletionItemKind.Class);
                item.detail = info.path;
                item.insertText = `${info.path} `;
                item.filterText = `${info.path} ${info.name}`;
                byPackage.set(packagePathOf(info.path), item);
            }
            for (const summary of workspace.index.allSummaries()) {
                if (!summary.classPath || summary.file === document.uri.fsPath) {
                    continue;
                }
                const key = packagePathOf(summary.classPath.name);
                if (byPackage.has(key)) {
                    continue;
                }
                const name = summary.classPath.name.split('/').pop() ?? summary.classPath.name;
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
                item.detail = `${summary.classPath.name} — ${vscode.workspace.asRelativePath(summary.file)}`;
                item.insertText = `${summary.classPath.name} `;
                item.filterText = `${summary.classPath.name} ${name}`;
                byPackage.set(key, item);
            }
            return [...byPackage.values()];
        },
    }, '/'));

    context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: 'dui' }, {
        async provideCompletionItems(document, position) {
            const line = document.lineAt(position.line).text.slice(0, position.character);
            // `<->` contains both other arrows, so it is judged first: its right side is a
            // VARIABLE, and the bridge now has a list of those.
            const wantsTwoWay = /<->\s*[\w\u00A0-\uFFFF]*$/u.test(line);
            const wantsBinding = !wantsTwoWay && /<-\s*[\w\u00A0-\uFFFF]*$/u.test(line);
            const wantsHandler = !wantsTwoWay && !wantsBinding && /->\s*[\w\u00A0-\uFFFF]*$/u.test(line);
            if (!wantsTwoWay && !wantsBinding && !wantsHandler) {
                return undefined;
            }

            const model = buildModel(document);
            const classPath = model.structure.classPath?.path;
            if (!classPath) {
                return undefined; // no class line, nothing to ask about
            }

            if (wantsTwoWay) {
                // EVERY variable, not just the FieldNotify ones. What makes `<->` legal is the
                // compiler's FindVariablePinType -- the name has to BE a variable on the class,
                // and that is all it asks (DreamUIExpressionThunks.cpp, LowerTwoWay). FieldNotify
                // decides how the runtime learns the value changed: a broadcast, or the per-frame
                // poll every other source already falls back to (DreamUserWidget.cpp). Hiding the
                // polled ones would refuse bindings the compiler accepts, which is the failure
                // mode this extension is not allowed to have. They are sorted second and labelled
                // instead, so the cheaper choice is the one in front of the cursor.
                const variables = await cache.variablesFor(document.uri.fsPath, classPath);
                return variables?.map((info) => {
                    const item = new vscode.CompletionItem(info.name, vscode.CompletionItemKind.Variable);
                    item.detail = info.type;
                    item.sortText = `${info.fieldNotify ? '0' : '1'}${info.name}`;
                    const documentation = new vscode.MarkdownString(info.fieldNotify
                        ? '**FieldNotify** \u2014 writes push straight back into the control.'
                        : 'No FieldNotify entry \u2014 this one is re-read on the per-frame poll.');
                    if (info.tooltip) {
                        documentation.appendMarkdown(`\n\n${info.tooltip}`);
                    }
                    item.documentation = documentation;
                    return item;
                });
            }

            const functions = await cache.functionsFor(document.uri.fsPath, classPath);
            if (!functions) {
                return undefined;
            }

            if (wantsBinding) {
                return functions.bindable.map((info) => {
                    const item = new vscode.CompletionItem(`${info.name}()`, vscode.CompletionItemKind.Function);
                    item.detail = info.returnType ?? '';
                    item.filterText = info.name;
                    return item;
                });
            }
            return functions.handlers.map((info) => {
                const item = new vscode.CompletionItem(info.name, vscode.CompletionItemKind.Function);
                item.detail = info.paramCount === 0 ? '()' : `${info.paramCount} param(s)`;
                return item;
            });
        },
    }, ' ', '-', '>'));

    return cache;
}
