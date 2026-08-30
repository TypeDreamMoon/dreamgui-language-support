/**
 * Completion that only a live editor can answer: what `<-` and `->` can name on THIS class.
 * Handler and binding legality is per-Blueprint -- the function lives on the class being
 * compiled -- so an offline export would always be stale; the bridge asks the editor that holds
 * the truth, and a closed editor degrades to offering nothing rather than guessing.
 *
 * Answers are cached per class path for a minute: the first keystroke pays the round trip, the
 * rest of the session types against the cache.
 */
import * as vscode from 'vscode';
import { BridgeClient } from './bridge';
import { WorkspaceIndexHost } from './workspace';
import { buildModel } from './docmodel';
import { BridgeFunctionInfo, BridgeAssetInfo } from './core/bridgeProtocol';
import { packagePathOf } from './core/workspaceIndex';

const CACHE_TTL_MS = 60_000;

interface FunctionsEntry {
    at: number;
    bindable: BridgeFunctionInfo[];
    handlers: BridgeFunctionInfo[];
}

export class BridgeCompletionCache {
    private readonly functionsByClass = new Map<string, FunctionsEntry>();
    private assets: { at: number; list: BridgeAssetInfo[] } | undefined;

    constructor(private readonly bridge: BridgeClient) {}

    clear(): void {
        this.functionsByClass.clear();
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
        };
        this.functionsByClass.set(classPath, entry);
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
            const wantsBinding = /<-\s*[\w\u00A0-\uFFFF]*$/u.test(line);
            const wantsHandler = !wantsBinding && /->\s*[\w\u00A0-\uFFFF]*$/u.test(line);
            if (!wantsBinding && !wantsHandler) {
                return undefined;
            }

            const model = buildModel(document);
            const classPath = model.structure.classPath?.path;
            if (!classPath) {
                return undefined; // no class line, nothing to ask about
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
