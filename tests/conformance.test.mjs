import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { decodeContextCookie, decodeEdgeSignals, edgeSignalBinding, edgeSignalsFresh } from '../src/context.ts';
import { decodeTouchCookie } from '../src/touch-cookie.ts';
import { decide, evaluatePlan } from '../src/edge-plan.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/conformance.json', import.meta.url), 'utf8'));
for (const entry of fixture.cases) {
  test(`portable conformance: ${entry.name}`, () => {
    const context = decodeContextCookie(entry.cookie);
    const touch = decodeTouchCookie(entry.cookie, entry.plan.queryNames);
    const request = new Request(entry.url, { headers: { cookie: entry.cookie } });
    assert.deepEqual(context, entry.decodedContext);
    assert.deepEqual(touch, entry.decodedTouch);
    assert.deepEqual(Object.fromEntries(decodeEdgeSignals(context.es, entry.snapshotIdentity)), entry.snapshotOutcomes);
    assert.deepEqual(evaluatePlan(entry.plan, request, touch, entry.now).map(action => action.actionId), entry.actionIds);
    assert.deepEqual(decide(entry.plan, request, touch, entry.now).map(({ campaignId, variantId, actions }) => ({ campaignId, variantId, actionIds: actions.map(action => action.actionId) })), entry.decisions);
  });
}

const entry = fixture.cases[0];
const snapshot = entry.decodedContext.es;
const identity = entry.snapshotIdentity;

test('context malformed bytes fail closed without losing valid UTF-8 fields', () => {
  for (const encoded of ['%', '!', Buffer.from([0xff, 0xfe]).toString('base64'), Buffer.from('{"v":2}').toString('base64'), Buffer.from('null').toString('base64')]) {
    assert.deepEqual(decodeContextCookie(`_rm_ctx=${encoded}`), {});
  }
  assert.equal(decodeContextCookie(entry.cookie).label, 'café');
  const encoded = entry.cookie.split(';')[0].slice(8);
  assert.deepEqual(decodeContextCookie(`unrelated=value; _rm_ctx=${encodeURIComponent(encoded)}`), entry.decodedContext);
});

test('snapshot freshness accepts the inclusive 30-day boundary, not stale or future days', () => {
  assert.equal(edgeSignalsFresh(snapshot, snapshot.d), true);
  assert.equal(edgeSignalsFresh(snapshot, snapshot.d + 30), true);
  for (const day of [snapshot.d - 1, snapshot.d + 31]) {
    assert.equal(edgeSignalsFresh(snapshot, day), false);
    assert.equal(decodeEdgeSignals(snapshot, { ...identity, today: day }), null);
  }
  for (const d of [undefined, null, '20000', 20000.5, Infinity, NaN]) {
    assert.equal(decodeEdgeSignals({ ...snapshot, d }, identity), null);
  }
});

test('profile binding spans origins while landing outcomes remain origin-specific', () => {
  assert.equal(edgeSignalBinding(identity.project, identity.connection, identity.contactId), snapshot.b);
  assert.equal(edgeSignalBinding(identity.project, identity.origin, identity.contactId), snapshot.h);
  assert.deepEqual(Object.fromEntries(decodeEdgeSignals(snapshot, { ...identity, origin: 'https://shop.example.com' })), { aaaaaaaa: true, bbbbbbbb: false });
  for (const field of ['project', 'connection', 'contactId']) {
    assert.equal(decodeEdgeSignals(snapshot, { ...identity, [field]: 'different' }), null);
  }
  assert.equal(decodeEdgeSignals({ ...snapshot, t: 'short' }, identity), null);
  assert.equal(decodeEdgeSignals({ ...snapshot, f: null }, identity), null);
  assert.deepEqual(Object.fromEntries(decodeEdgeSignals({ ...snapshot, ht: 'short' }, identity)), { aaaaaaaa: true, bbbbbbbb: false });
});

test('contradictory profile and page outcomes are removed rather than guessed', () => {
  const conflicting = { ...snapshot, t: 'aaaaaaaabbbbbbbb', ht: 'cccccccc', hf: 'aaaaaaaa' };
  assert.deepEqual(Object.fromEntries(decodeEdgeSignals(conflicting, identity)), { cccccccc: true });
  const nonHex = { ...snapshot, t: 'rule-key', f: '', ht: '', hf: '' };
  assert.deepEqual(Object.fromEntries(decodeEdgeSignals(nonHex, identity)), { 'rule-key': true });
});

test('origin or active connection changes cannot reuse landing or profile winners', () => {
  const touch = entry.decodedTouch;
  const sibling = new Request('https://shop.example.com/offer', { headers: { cookie: entry.cookie } });
  assert.deepEqual(evaluatePlan(entry.plan, sibling, touch, entry.now).map(action => action.actionId), ['profile-copy', 'answered-copy', 'attributed-copy']);
  const replaced = { ...entry.plan, connectionScope: 'replacement' };
  assert.deepEqual(evaluatePlan(replaced, new Request(entry.url, { headers: { cookie: entry.cookie } }), touch, entry.now).map(action => action.actionId), ['answered-copy', 'attributed-copy']);
});
