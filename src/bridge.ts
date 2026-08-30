/**
 * The client end of the drop-folder bridge. Requests are written beside-then-renamed (the editor
 * polls-then-reads, same as we do coming back), responses are polled for by existence, and a
 * timeout abandons the id -- the editor sweeps stale responses at its next startup, and ids are
 * never reused. Liveness is read before sending so a closed editor fails in one file stat, not
 * one timeout.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    BridgeAction, BridgeRequest, BridgeResponse, bridgePaths, buildRequest, makeRequestId,
    parseResponse, parseStatus, livenessOf, canServe, Liveness,
} from './core/bridgeProtocol';

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class BridgeClient implements vscode.Disposable {
    private readonly projectDirCache = new Map<string, string | undefined>();

    dispose(): void {}

    /** The project root (the directory holding the .uproject), walked up from a .dui. */
    resolveProjectDir(documentPath: string | undefined): string | undefined {
        if (!documentPath) {
            return undefined;
        }
        let directory = path.dirname(documentPath);
        if (this.projectDirCache.has(directory)) {
            return this.projectDirCache.get(directory);
        }
        const started = directory;
        let found: string | undefined;
        for (let hops = 0; hops < 12; hops++) {
            try {
                if (fs.readdirSync(directory).some((name) => name.endsWith('.uproject'))) {
                    found = directory;
                    break;
                }
            } catch {
                break;
            }
            const parent = path.dirname(directory);
            if (parent === directory) {
                break;
            }
            directory = parent;
        }
        this.projectDirCache.set(started, found);
        return found;
    }

    livenessFor(documentPath: string | undefined): Liveness {
        const projectDir = this.resolveProjectDir(documentPath);
        if (!projectDir) {
            return 'closed';
        }
        const paths = bridgePaths(projectDir, path.join);
        let status;
        try {
            status = parseStatus(fs.readFileSync(paths.status, 'utf8'));
        } catch {
            status = undefined;
        }
        return livenessOf(status, Date.now(), isProcessAlive);
    }

    /**
     * Sends one request and waits for its answer. Undefined means "no editor to ask" or a
     * timeout -- callers degrade (completion falls back to less, commands say why) rather than
     * retry: the editor drains in order, so a retry would only queue the same question twice.
     */
    async send(documentPath: string | undefined, action: BridgeAction,
        extra: Omit<Partial<BridgeRequest>, 'protocol' | 'requestId' | 'action'> = {},
        timeoutMs = 5000): Promise<BridgeResponse | undefined> {
        const projectDir = this.resolveProjectDir(documentPath);
        if (!projectDir || !canServe(this.livenessFor(documentPath))) {
            return undefined;
        }
        const paths = bridgePaths(projectDir, path.join);
        try {
            fs.mkdirSync(paths.requests, { recursive: true });
            fs.mkdirSync(paths.responses, { recursive: true });
        } catch {
            return undefined;
        }

        const requestId = makeRequestId(Date.now());
        const request = buildRequest(requestId, action, extra);
        const finalPath = path.join(paths.requests, `${requestId}.request.json`);
        try {
            fs.writeFileSync(finalPath + '.tmp', JSON.stringify(request), 'utf8');
            fs.renameSync(finalPath + '.tmp', finalPath);
        } catch {
            return undefined;
        }

        const responsePath = path.join(paths.responses, `${requestId}.response.json`);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (fs.existsSync(responsePath)) {
                try {
                    const parsed = parseResponse(fs.readFileSync(responsePath, 'utf8'));
                    fs.unlinkSync(responsePath);
                    return parsed;
                } catch {
                    return undefined;
                }
            }
            await sleep(100);
        }
        // Abandoned: the id is never reused and the editor sweeps stale responses at startup.
        return undefined;
    }
}

export function registerBridge(context: vscode.ExtensionContext): BridgeClient {
    const client = new BridgeClient();
    context.subscriptions.push(client);
    return client;
}
