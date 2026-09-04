/**
 * The bridge contract's client half: liveness judgement (two signals, pid the stronger one),
 * request id ordering, and the narrow parses that reject truncated or foreign files.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    livenessOf, canServe, makeRequestId, buildRequest, parseResponse, parseStatus,
    bridgePaths, PROTOCOL_VERSION, HEARTBEAT_STALE_MS, BUSY_STALE_MS, BridgeStatus,
    parseRevealToEditor, revealToEditorPath, REVEAL_TO_EDITOR_FILE,
} from '../src/core/bridgeProtocol';

const NOW = Date.parse('2026-08-30T12:00:00Z');
const alive = (): boolean => true;
const dead = (): boolean => false;

function status(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
    return {
        protocol: PROTOCOL_VERSION, pid: 1234, project: 'DevTest', busy: false,
        heartbeatUtc: new Date(NOW - 2000).toISOString(), ...overrides,
    };
}

test('a fresh heartbeat with a live pid is alive', () => {
    assert.equal(livenessOf(status(), NOW, alive), 'alive');
    assert.ok(canServe('alive'));
});

test('no status file means closed -- nothing to talk to, do not time out at it', () => {
    assert.equal(livenessOf(undefined, NOW, alive), 'closed');
    assert.ok(!canServe('closed'));
});

test('a dead pid is proof, whatever the timestamp says', () => {
    assert.equal(livenessOf(status(), NOW, dead), 'closed');
});

test('a stale heartbeat on an idle editor is stale; busy buys the long budget', () => {
    const old = status({ heartbeatUtc: new Date(NOW - HEARTBEAT_STALE_MS - 1000).toISOString() });
    assert.equal(livenessOf(old, NOW, alive), 'stale');

    const busy = status({ busy: true, heartbeatUtc: new Date(NOW - 60_000).toISOString() });
    assert.equal(livenessOf(busy, NOW, alive), 'busy');
    assert.ok(canServe('busy'));

    const corpse = status({ busy: true, heartbeatUtc: new Date(NOW - BUSY_STALE_MS - 1000).toISOString() });
    assert.equal(livenessOf(corpse, NOW, alive), 'stale');
});

test('a protocol mismatch is stale, not a misread', () => {
    assert.equal(livenessOf(status({ protocol: 99 }), NOW, alive), 'stale');
});

test('request ids sort oldest-first as plain strings', () => {
    const first = makeRequestId(NOW);
    const second = makeRequestId(NOW);
    const later = makeRequestId(NOW + 5000);
    assert.ok(first < second, `${first} < ${second}`);
    assert.ok(second < later);
});

test('buildRequest stamps the protocol and carries the extras', () => {
    const request = buildRequest('id-1', 'functions', { classPath: '/Game/UI/WBP_X' });
    assert.equal(request.protocol, PROTOCOL_VERSION);
    assert.equal(request.action, 'functions');
    assert.equal(request.classPath, '/Game/UI/WBP_X');
});

test('parseResponse narrows: payloads come through, garbage does not', () => {
    const good = parseResponse(JSON.stringify({
        protocol: 1, requestId: 'r', ok: true, durationMs: 12, message: '',
        functions: { bindable: [{ name: 'GetTitle', returnType: 'FText', paramCount: 0 }], handlers: [] },
    }))!;
    assert.equal(good.functions?.bindable[0].name, 'GetTitle');

    assert.equal(parseResponse('not json'), undefined);
    assert.equal(parseResponse('{"ok": true}'), undefined);
    assert.equal(parseResponse('{"requestId": "r"}'), undefined);
});

test('parseStatus narrows on the heartbeat, the one field liveness cannot do without', () => {
    assert.equal(parseStatus('{"pid": 3}'), undefined);
    const parsed = parseStatus(JSON.stringify(status()))!;
    assert.equal(parsed.pid, 1234);
});

test('bridge paths live under Saved, outside version control', () => {
    const paths = bridgePaths('X:/Proj', (...parts) => parts.join('/'));
    assert.equal(paths.requests, 'X:/Proj/Saved/DreamGUI/Bridge/Requests');
    assert.equal(paths.status, 'X:/Proj/Saved/DreamGUI/Bridge/status.json');
});

test('buildRequest carries the type and asset extras the new actions ask with', () => {
    const members = buildRequest('id-2', 'members', { typePath: 'TArray<FTrackInfo>' });
    assert.equal(members.action, 'members');
    assert.equal(members.typePath, 'TArray<FTrackInfo>');

    const reveal = buildRequest('id-3', 'revealAsset', { assetPath: '/Game/UI/Tex' });
    assert.equal(reveal.assetPath, '/Game/UI/Tex');
    assert.equal(reveal.protocol, PROTOCOL_VERSION);
});

test('parseResponse takes in callable, variables, members and the element type', () => {
    const parsed = parseResponse(JSON.stringify({
        protocol: 1, requestId: 'r', ok: true, durationMs: 3, message: '',
        functions: {
            bindable: [{ name: 'GetTitle', returnType: 'FText', paramCount: 0 }],
            handlers: [],
            callable: [{
                name: 'Format', returnType: 'FText', paramCount: 2, pure: true,
                params: [{ name: 'Value', type: 'float' }, { name: 'Digits', type: 'int32' }],
                tooltip: 'Rounds and formats.',
            }],
        },
        variables: [
            { name: 'bMuted', type: 'bool', fieldNotify: true },
            { name: 'Tracks', type: 'TArray<FTrackInfo>', fieldNotify: false, tooltip: 'The library.' },
        ],
        members: [{ name: 'Title', type: 'FText' }],
        elementType: 'FTrackInfo',
    }))!;
    assert.equal(parsed.functions?.callable[0].params?.[1].name, 'Digits');
    assert.equal(parsed.functions?.callable[0].pure, true);
    assert.deepEqual(parsed.variables?.map((v) => v.fieldNotify), [true, false]);
    assert.equal(parsed.members?.[0].type, 'FText');
    assert.equal(parsed.elementType, 'FTrackInfo');
});

test('a payload keeps the entries it can vouch for and drops the ones it cannot', () => {
    const parsed = parseResponse(JSON.stringify({
        requestId: 'r', ok: true,
        functions: {
            // No callable at all: an editor older than the field. The other two still work.
            bindable: [{ name: 'Good', paramCount: 0 }, { returnType: 'FText' }, 'nonsense'],
            handlers: [{ name: 'OnClick', params: [{ name: 'X', type: 'int32' }, { name: 5 }] }],
        },
        variables: [{ name: 'Ok' }, { type: 'bool' }],
        members: 'not an array',
        elementType: '',
    }))!;
    assert.deepEqual(parsed.functions?.bindable.map((f) => f.name), ['Good']);
    assert.deepEqual(parsed.functions?.callable, []);
    // paramCount is absent but the list says two entries, one of which is unusable.
    assert.deepEqual(parsed.functions?.handlers[0].params, [{ name: 'X', type: 'int32' }]);
    assert.equal(parsed.functions?.handlers[0].paramCount, 1);
    assert.deepEqual(parsed.variables?.map((v) => [v.name, v.type, v.fieldNotify]), [['Ok', '', false]]);
    assert.equal(parsed.members, undefined);
    assert.equal(parsed.elementType, undefined);
});

test('the reveal file sits beside the rest of the bridge', () => {
    assert.equal(revealToEditorPath('X:/Proj', (...parts) => parts.join('/')),
        `X:/Proj/Saved/DreamGUI/Bridge/${REVEAL_TO_EDITOR_FILE}`);
});

test('parseRevealToEditor takes a whole message and refuses a partial one', () => {
    const message = parseRevealToEditor(JSON.stringify({
        protocol: 1, file: 'I:/Proj/DUI/Main.dui', line: 42, column: 9,
        widgetId: 'OkButton', stampUtc: '2026-09-04T10:00:00Z',
    }))!;
    assert.equal(message.file, 'I:/Proj/DUI/Main.dui');
    assert.equal(message.line, 42);
    assert.equal(message.widgetId, 'OkButton');

    assert.equal(parseRevealToEditor('not json'), undefined);
    // A foreign protocol is refused rather than read leniently: this moves the cursor.
    assert.equal(parseRevealToEditor('{"protocol":2,"file":"x","stampUtc":"2026-09-04T10:00:00Z"}'), undefined);
    assert.equal(parseRevealToEditor('{"protocol":1,"stampUtc":"2026-09-04T10:00:00Z"}'), undefined);
    assert.equal(parseRevealToEditor('{"protocol":1,"file":"x","stampUtc":"whenever"}'), undefined);
});

test('a reveal with no usable position still names the file, and lands at its top', () => {
    const message = parseRevealToEditor(JSON.stringify({
        protocol: 1, file: 'I:/Proj/DUI/Main.dui', line: 0, stampUtc: '2026-09-04T10:00:00Z',
    }))!;
    assert.equal(message.line, 1);
    assert.equal(message.column, 1);
    assert.equal(message.widgetId, '');
});
