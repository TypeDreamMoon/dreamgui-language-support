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
import { buildModel } from './docmodel';
import { BridgeFunctionInfo } from './core/bridgeProtocol';

const CACHE_TTL_MS = 60_000;

interface FunctionsEntry {
    at: number;
    bindable: BridgeFunctionInfo[];
    handlers: BridgeFunctionInfo[];
}

export class BridgeCompletionCache {
    private readonly functionsByClass = new Map<string, FunctionsEntry>();

    constructor(private readonly bridge: BridgeClient) {}

    clear(): void {
        this.functionsByClass.clear();
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

export function registerBridgeCompletion(context: vscode.ExtensionContext, bridge: BridgeClient): BridgeCompletionCache {
    const cache = new BridgeCompletionCache(bridge);

    context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: 'dui' }, {
        async provideCompletionItems(document, position) {
            const line = document.lineAt(position.line).text.slice(0, position.character);
            const wantsBinding = /<-\s*[\w -￿]*$/u.test(line);
            const wantsHandler = !wantsBinding && /->\s*[\w -￿]*$/u.test(line);
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
