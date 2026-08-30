/**
 * The drop-folder protocol shared with the Unreal editor side (FDreamUIBridgeService). The shape
 * is the DreamFX bridge's, re-spoken for this language -- that shape already paid for its
 * non-obvious choices: requests are taken-then-deleted (a crash cannot replay them), responses
 * are written beside and renamed (the client polls-for-existence then reads), unknown actions
 * MUST be answered (a silent editor and a missing feature look identical otherwise), and
 * liveness rides two signals, heartbeat and pid, because a timestamp only says when the editor
 * last chose to write while a dead pid is proof.
 *
 * Kept in core, away from vscode: this is the half of the contract this side owns, tested
 * without an editor at either end. Counterparts live in DreamUIBridgeService.cpp; when either
 * half changes, PROTOCOL_VERSION changes with it.
 */

export const PROTOCOL_VERSION = 1;

export type BridgeAction =
    | 'ping'
    /** The bindable functions and event handlers of one class -- what `<-` and `->` can name. */
    | 'functions'
    /** Assets by native class, for nested-tag and asset-value completion. */
    | 'assets'
    /** Open the class's designer, optionally selecting one widget. */
    | 'reveal'
    /** Compile the class now; its verdicts arrive through the diagnostics mailbox, not here. */
    | 'compile';

export interface BridgeRequest {
    protocol: number;
    requestId: string;
    action: BridgeAction;
    /** functions / reveal / compile: the class line's /Game path. */
    classPath?: string;
    /** reveal: select this widget (a node id) after opening. */
    widgetId?: string;
    /** assets: the native class to list, default DreamWidgetBlueprint. */
    classFilter?: string;
}

export interface BridgeFunctionInfo {
    name: string;
    /** Unset when the function returns nothing. */
    returnType?: string;
    paramCount: number;
}

export interface BridgeAssetInfo {
    /** The package path, the spelling a .dui writes. */
    path: string;
    name: string;
}

export interface BridgeResponse {
    protocol: number;
    requestId: string;
    ok: boolean;
    durationMs: number;
    message: string;
    functions?: { bindable: BridgeFunctionInfo[]; handlers: BridgeFunctionInfo[] };
    assets?: BridgeAssetInfo[];
}

export interface BridgeStatus {
    protocol: number;
    pid: number;
    project: string;
    busy: boolean;
    busyAction?: string;
    heartbeatUtc: string;
}

export interface BridgePaths {
    root: string;
    requests: string;
    responses: string;
    status: string;
}

/** Everything lives under Saved/, which is already outside version control. */
export function bridgePaths(projectDir: string, join: (...parts: string[]) => string): BridgePaths {
    const root = join(projectDir, 'Saved', 'DreamGUI', 'Bridge');
    return {
        root,
        requests: join(root, 'Requests'),
        responses: join(root, 'Responses'),
        status: join(root, 'status.json'),
    };
}

/** The editor rewrites status.json every two seconds; inside this budget it is alive. */
export const HEARTBEAT_STALE_MS = 15_000;

/**
 * A compile blocks the game thread, which stops the heartbeat with it -- while an action runs,
 * silence is expected. It still has to end somewhere: a crash mid-action leaves busy:true behind
 * forever, and without a ceiling the client waits on a corpse.
 */
export const BUSY_STALE_MS = 15 * 60_000;

export type Liveness = 'alive' | 'busy' | 'stale' | 'closed';

/** Is there an editor on the other end? Injected isProcessAlive keeps this testable. */
export function livenessOf(
    status: BridgeStatus | undefined,
    nowMs: number,
    isProcessAlive: (pid: number) => boolean,
): Liveness {
    if (!status) {
        return 'closed';
    }
    if (status.protocol !== PROTOCOL_VERSION) {
        return 'stale';
    }
    if (Number.isFinite(status.pid) && status.pid > 0 && !isProcessAlive(status.pid)) {
        return 'closed';
    }
    const beat = Date.parse(status.heartbeatUtc);
    if (!Number.isFinite(beat)) {
        return 'stale';
    }
    const age = nowMs - beat;
    if (status.busy) {
        return age < BUSY_STALE_MS ? 'busy' : 'stale';
    }
    return age < HEARTBEAT_STALE_MS ? 'alive' : 'stale';
}

export function canServe(liveness: Liveness): boolean {
    return liveness === 'alive' || liveness === 'busy';
}

/**
 * Request ids sort oldest-first as plain strings, so the editor drains them in send order with a
 * sort rather than a guess. The counter disambiguates two requests inside one millisecond.
 */
let sequence = 0;

export function makeRequestId(nowMs: number, random: () => number = Math.random): string {
    sequence = (sequence + 1) % 1000;
    const stamp = new Date(nowMs).toISOString().replace(/[-:.TZ]/g, '');
    const salt = Math.floor(random() * 0xffff).toString(16).padStart(4, '0');
    return `${stamp}-${String(sequence).padStart(3, '0')}-${salt}`;
}

export function buildRequest(
    requestId: string,
    action: BridgeAction,
    extra: Omit<Partial<BridgeRequest>, 'protocol' | 'requestId' | 'action'> = {},
): BridgeRequest {
    return { protocol: PROTOCOL_VERSION, requestId, action, ...extra };
}

/** Narrows unknown JSON to a response, so a truncated or foreign file is rejected rather than used. */
export function parseResponse(text: string): BridgeResponse | undefined {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const candidate = value as Partial<BridgeResponse>;
    if (typeof candidate.requestId !== 'string' || typeof candidate.ok !== 'boolean') {
        return undefined;
    }
    return {
        protocol: typeof candidate.protocol === 'number' ? candidate.protocol : 0,
        requestId: candidate.requestId,
        ok: candidate.ok,
        durationMs: typeof candidate.durationMs === 'number' ? candidate.durationMs : 0,
        message: typeof candidate.message === 'string' ? candidate.message : '',
        functions: candidate.functions && typeof candidate.functions === 'object'
            ? {
                bindable: Array.isArray(candidate.functions.bindable) ? candidate.functions.bindable : [],
                handlers: Array.isArray(candidate.functions.handlers) ? candidate.functions.handlers : [],
            }
            : undefined,
        assets: Array.isArray(candidate.assets) ? candidate.assets : undefined,
    };
}

export function parseStatus(text: string): BridgeStatus | undefined {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const candidate = value as Partial<BridgeStatus>;
    if (typeof candidate.heartbeatUtc !== 'string') {
        return undefined;
    }
    return {
        protocol: typeof candidate.protocol === 'number' ? candidate.protocol : 0,
        pid: typeof candidate.pid === 'number' ? candidate.pid : 0,
        project: candidate.project ?? '',
        busy: candidate.busy === true,
        busyAction: candidate.busyAction,
        heartbeatUtc: candidate.heartbeatUtc,
    };
}
