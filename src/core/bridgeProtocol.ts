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
 * half changes INCOMPATIBLY, PROTOCOL_VERSION changes with it.
 *
 * The 2026-09-04 additions -- `variables`, `members`, `revealAsset`, a `callable` list beside
 * the two `functions` already had -- stay at version 1, and that is a judgement rather than an
 * oversight. Every direction of mismatch already lands somewhere survivable: an editor that
 * predates them answers an unknown action with ok:false, which every caller here treats as "no
 * answer" (the same as a closed editor); a client that predates them ignores fields it does not
 * read; and each new field's absence narrows into an empty list or undefined, which is a feature
 * falling silent rather than a feature answering wrongly. Bumping the version would instead make
 * the two halves refuse each other outright over a difference neither of them needs to care
 * about -- livenessOf calls a protocol mismatch 'stale', and 'stale' takes the WHOLE bridge down,
 * completion and compile and reveal along with it.
 */

export const PROTOCOL_VERSION = 1;

export type BridgeAction =
    | 'ping'
    /** The bindable functions, event handlers and callable functions of one class. */
    | 'functions'
    /** The Blueprint-visible member variables of one class -- what `<->` can mirror. */
    | 'variables'
    /** The Blueprint-visible properties of one TYPE -- what `Item.` offers inside an `each`. */
    | 'members'
    /** Assets by native class, for nested-tag and asset-value completion. */
    | 'assets'
    /** Open the class's designer, optionally selecting one widget. */
    | 'reveal'
    /** Sync the content browser to one asset path and open its editor. */
    | 'revealAsset'
    /** Compile the class now; its verdicts arrive through the diagnostics mailbox, not here. */
    | 'compile';

export interface BridgeRequest {
    protocol: number;
    requestId: string;
    action: BridgeAction;
    /** functions / variables / reveal / compile: the class line's /Game path. */
    classPath?: string;
    /** reveal: select this widget (a node id) after opening. */
    widgetId?: string;
    /** assets: the native class to list, default DreamWidgetBlueprint. */
    classFilter?: string;
    /**
     * members: a type as the reflection layer spells it -- `TArray<FFoo>`, `FFoo`, `UFoo*`,
     * `TObjectPtr<UFoo>`, `/Game/X.Y_C` or a bare `Foo`. The same spelling `returnType` and
     * `type` come back in, so an answer feeds straight into the next question.
     */
    typePath?: string;
    /** revealAsset: a package path, `/Game/UI/Tex`. */
    assetPath?: string;
}

/** One declared parameter, in declaration order. The return value is never in this list. */
export interface BridgeParamInfo {
    name: string;
    type: string;
}

export interface BridgeFunctionInfo {
    name: string;
    /** Unset when the function returns nothing. */
    returnType?: string;
    paramCount: number;
    /** Declaration order, return excluded. Absent from an editor that predates the field. */
    params?: BridgeParamInfo[];
    pure?: boolean;
    tooltip?: string;
}

/**
 * One Blueprint-visible member variable. `fieldNotify` decides how the RUNTIME learns the value
 * changed (a broadcast, versus the per-frame poll every other source falls back to) -- it is not
 * what makes `<->` legal, which is only that the name IS a variable on the class. See
 * bridgeCompletion.ts, where that distinction is spent.
 */
export interface BridgeVariableInfo {
    name: string;
    type: string;
    fieldNotify: boolean;
    tooltip?: string;
}

/** One Blueprint-visible property of a struct or class -- the answer to `members`. */
export interface BridgeMemberInfo {
    name: string;
    type: string;
    tooltip?: string;
}

export interface BridgeFunctions {
    /** No inputs and a return value: what `<-` can pull from every frame. */
    bindable: BridgeFunctionInfo[];
    /** Callable at all: what `->` can route an event into. */
    handlers: BridgeFunctionInfo[];
    /** Every callable UFunction, inherited included -- what a binding EXPRESSION may call. */
    callable: BridgeFunctionInfo[];
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
    functions?: BridgeFunctions;
    assets?: BridgeAssetInfo[];
    variables?: BridgeVariableInfo[];
    members?: BridgeMemberInfo[];
    /** members: set when typePath was a container -- the element type its members describe. */
    elementType?: string;
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

/**
 * The payload narrowings. Each drops the entries it cannot vouch for rather than the whole list:
 * one malformed function in a class of forty should cost that one name, not the feature. A `name`
 * that is not a string is the line -- everything downstream renders it.
 */
function narrowFunctions(value: unknown): BridgeFunctionInfo[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const out: BridgeFunctionInfo[] = [];
    for (const raw of value) {
        if (typeof raw !== 'object' || raw === null) {
            continue;
        }
        const candidate = raw as Partial<BridgeFunctionInfo>;
        if (typeof candidate.name !== 'string' || candidate.name.length === 0) {
            continue;
        }
        const params = Array.isArray(candidate.params)
            ? candidate.params
                .filter((param): param is BridgeParamInfo =>
                    typeof param === 'object' && param !== null
                    && typeof (param as BridgeParamInfo).name === 'string'
                    && typeof (param as BridgeParamInfo).type === 'string')
                .map((param) => ({ name: param.name, type: param.type }))
            : undefined;
        out.push({
            name: candidate.name,
            returnType: typeof candidate.returnType === 'string' ? candidate.returnType : undefined,
            // A missing count is answered by the params list when there is one: the two say the
            // same thing, and trusting the list keeps an older editor's answer usable.
            paramCount: typeof candidate.paramCount === 'number' ? candidate.paramCount : params?.length ?? 0,
            params,
            pure: candidate.pure === true ? true : undefined,
            tooltip: typeof candidate.tooltip === 'string' ? candidate.tooltip : undefined,
        });
    }
    return out;
}

function narrowVariables(value: unknown): BridgeVariableInfo[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const out: BridgeVariableInfo[] = [];
    for (const raw of value) {
        if (typeof raw !== 'object' || raw === null) {
            continue;
        }
        const candidate = raw as Partial<BridgeVariableInfo>;
        if (typeof candidate.name !== 'string' || candidate.name.length === 0) {
            continue;
        }
        out.push({
            name: candidate.name,
            type: typeof candidate.type === 'string' ? candidate.type : '',
            // Absent reads as false, which costs a marker and never a completion: a variable is
            // offered either way, and the compiler's rule for `<->` never asked about this.
            fieldNotify: candidate.fieldNotify === true,
            tooltip: typeof candidate.tooltip === 'string' ? candidate.tooltip : undefined,
        });
    }
    return out;
}

function narrowMembers(value: unknown): BridgeMemberInfo[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const out: BridgeMemberInfo[] = [];
    for (const raw of value) {
        if (typeof raw !== 'object' || raw === null) {
            continue;
        }
        const candidate = raw as Partial<BridgeMemberInfo>;
        if (typeof candidate.name !== 'string' || candidate.name.length === 0) {
            continue;
        }
        out.push({
            name: candidate.name,
            type: typeof candidate.type === 'string' ? candidate.type : '',
            tooltip: typeof candidate.tooltip === 'string' ? candidate.tooltip : undefined,
        });
    }
    return out;
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
                bindable: narrowFunctions(candidate.functions.bindable),
                handlers: narrowFunctions(candidate.functions.handlers),
                // Absent from an editor that predates the field: an empty list, so the callers
                // that want it fall silent while `<-` and `->` keep working against the old one.
                callable: narrowFunctions(candidate.functions.callable),
            }
            : undefined,
        assets: Array.isArray(candidate.assets) ? candidate.assets : undefined,
        variables: narrowVariables(candidate.variables),
        members: narrowMembers(candidate.members),
        elementType: typeof candidate.elementType === 'string' && candidate.elementType.length > 0
            ? candidate.elementType : undefined,
    };
}

// ---- the reverse channel: editor -> VS Code ---------------------------------------------------

/**
 * The one message that travels the other way: the designer asking the editor's text side to jump
 * to a widget's line. It is a FILE and not a request/response pair because the direction is
 * inverted -- VS Code cannot be polled, only told -- and because a jump is idempotent: the editor
 * overwrites the same file (beside-then-rename, as everything here does) and the newest stamp is
 * the only one worth acting on. A dropped one costs a jump, never state.
 */
export const REVEAL_TO_EDITOR_FILE = 'reveal-to-editor.json';

/**
 * Older than this at startup and the file is history, not an instruction: the editor wrote it in
 * a session that is over, and jumping the author somewhere they asked to go an hour ago is worse
 * than doing nothing. Live messages are acted on regardless of age -- the watcher sees them
 * arrive, which is proof enough.
 */
export const REVEAL_TO_EDITOR_STALE_MS = 30_000;

export interface RevealToEditor {
    protocol: number;
    /** Absolute path to a .dui. */
    file: string;
    /** 1-based, as every DUInnnn message counts. */
    line: number;
    /** 1-based. */
    column: number;
    /** The widget's display name, or empty when the designer had no one node in mind. */
    widgetId: string;
    stampUtc: string;
}

export function revealToEditorPath(projectDir: string, join: (...parts: string[]) => string): string {
    return join(bridgePaths(projectDir, join).root, REVEAL_TO_EDITOR_FILE);
}

/**
 * Narrows one reveal message. A foreign protocol is REFUSED rather than read leniently: the file
 * and line are about to move the author's cursor, and a version that spells them differently
 * would move it somewhere wrong -- silence is the failure this side is allowed to have.
 */
export function parseRevealToEditor(text: string): RevealToEditor | undefined {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const candidate = value as Partial<RevealToEditor>;
    if (candidate.protocol !== PROTOCOL_VERSION) {
        return undefined;
    }
    if (typeof candidate.file !== 'string' || candidate.file.length === 0) {
        return undefined;
    }
    if (typeof candidate.stampUtc !== 'string' || !Number.isFinite(Date.parse(candidate.stampUtc))) {
        return undefined;
    }
    // A missing or nonsensical line/column is the top of the file, not a rejection: the FILE was
    // the message, and a truncated position still lands the author in the right document.
    const at = (raw: unknown): number =>
        typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
    return {
        protocol: candidate.protocol,
        file: candidate.file,
        line: at(candidate.line),
        column: at(candidate.column),
        widgetId: typeof candidate.widgetId === 'string' ? candidate.widgetId : '',
        stampUtc: candidate.stampUtc,
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
