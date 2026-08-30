/**
 * The bridge contract's client half: liveness judgement (two signals, pid the stronger one),
 * request id ordering, and the narrow parses that reject truncated or foreign files.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    livenessOf, canServe, makeRequestId, buildRequest, parseResponse, parseStatus,
    bridgePaths, PROTOCOL_VERSION, HEARTBEAT_STALE_MS, BUSY_STALE_MS, BridgeStatus,
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
