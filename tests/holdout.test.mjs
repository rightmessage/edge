import assert from "node:assert/strict";
import { test } from "vitest";
import { decide } from "../src/edge-plan.ts";
import { holdoutPoint, mintHoldoutUnit } from "../src/holdout.ts";
import { decodeTouchCookie, observeTouchCookie, TOUCH_COOKIE_NAME } from "../src/touch-cookie.ts";

// Pinned in the RightMessage application's browser tests too: both implementations must agree.
const VECTORS = [
  ["AAAAAAAAAAAAAAAAAAAAAA", "cpn_opCBD8W3", 25.050231581553817],
  ["3f2b8c1e-7a44-4d0e-9b1f-2c6a0d5e8f71", "cpn_5didDYbc", 66.09369346406311],
  ["zZ9_-QkLmNoPqRsTuVwXyA", "cpn_BOrtJrzE", 28.193707740865648],
  ["visitor-é", "campaign", 30.307251238264143],
];
const HELD_UNIT = "AAAAAAAAAAAAAAAAAAAAAA"; // 25.05 for cpn_opCBD8W3
const action = { id: "a", actionId: "a", campaignId: "cpn_opCBD8W3", variantId: "v", page: [{ domain: "*", path: "*" }], selector: "h1", modifications: { text: "Treatment" }, edge: { supported: false, reason: "campaign-experiment", operations: ["text"], deferredOperations: [] } };
const plan = (testing, edge = action.edge) => ({ version: 1, teamPid: "1", queryNames: [], dimensions: [], campaigns: [{ id: "cpn_opCBD8W3", is_active: true, testing, variants: [{ id: "v", rules: { all: [] }, actions: [{ ...action, edge }] }] }] });
const context = payload => `_rm_ctx=${Buffer.from(JSON.stringify({ v: 1, ...payload })).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "~")}`;
const applied = (testing, { cookie = "", touch = { q: {} }, edge } = {}) =>
  decide(plan(testing, edge), new Request("https://rightmessage.com/", { headers: { cookie } }), touch).length === 1;

test("holdout points match the browser implementation", () => {
  for (const [unit, campaignId, point] of VECTORS) assert.equal(holdoutPoint(unit, campaignId), point);
});

test("holdout points split units evenly and independently per campaign", () => {
  let held = 0, both = 0;
  for (let index = 0; index < 50000; index++) {
    const first = holdoutPoint(`unit-${index}`, "cpn_a") < 50;
    held += first;
    both += first && holdoutPoint(`unit-${index}`, "cpn_b") < 50;
  }
  assert.ok(Math.abs(held / 50000 - 0.5) < 0.01);
  assert.ok(Math.abs(both / 50000 - 0.25) < 0.01);
});

test("the touch unit assigns the same arm the browser hashes, using the browser's withhold default", () => {
  const touch = { q: {}, u: HELD_UNIT };
  assert.equal(applied({ is_enabled: true, withhold: 50 }, { touch }), false);
  assert.equal(applied({ is_enabled: true, withhold: 25 }, { touch }), true);
  // `withhold || 10` in the browser: 0 and absent both mean 10%.
  assert.equal(applied({ is_enabled: true, withhold: 0 }, { touch }), true);
  assert.equal(applied({ is_enabled: true, withhold: 26 }, { touch }), false);
});

test("a recorded arm wins over the hash, including a sticky holdout after testing ends", () => {
  const touch = { q: {}, u: HELD_UNIT };
  const ledger = holdback => context({ vid: "v", ca: { v: 1, r: [["cpn_opCBD8W3", true, holdback]] } });
  assert.equal(applied({ is_enabled: true, withhold: 50 }, { touch, cookie: ledger(false) }), true);
  assert.equal(applied({ is_enabled: true, withhold: 1 }, { touch, cookie: ledger(true) }), false);
  assert.equal(applied({ is_enabled: false }, { cookie: ledger(true), edge: { ...action.edge, supported: true, reason: null } }), false);
  // A duplicated record is ambiguous, as in the browser decoder, so the hash decides.
  const duplicated = context({ ca: { v: 1, r: [["cpn_opCBD8W3", true, false], ["cpn_opCBD8W3", true, true]] } });
  assert.equal(applied({ is_enabled: true, withhold: 50 }, { touch, cookie: duplicated }), false);
});

test("the visitor id is a unit only beside a mirrored ledger; otherwise the browser assigns", () => {
  const vid = "3f2b8c1e-7a44-4d0e-9b1f-2c6a0d5e8f71"; // 42.54 for cpn_opCBD8W3
  const mirrored = context({ vid, ca: { v: 1, r: [] } });
  assert.equal(applied({ is_enabled: true, withhold: 42 }, { cookie: mirrored }), true);
  assert.equal(applied({ is_enabled: true, withhold: 43 }, { cookie: mirrored }), false);
  assert.equal(applied({ is_enabled: true, withhold: 42 }, { cookie: context({ vid }) }), false);
  assert.equal(applied({ is_enabled: true, withhold: 42 }), false);
  assert.equal(applied({ is_enabled: false }, { edge: { ...action.edge, supported: true, reason: null } }), true);
});

test("experiment operations run only after assignment and never from other unsupported actions", () => {
  const touch = { q: {}, u: HELD_UNIT };
  assert.equal(applied({ is_enabled: true, withhold: 10 }, { touch }), true);
  assert.equal(applied({ is_enabled: true, withhold: 10 }, { touch, edge: { ...action.edge, operations: [] } }), false);
  assert.equal(applied({ is_enabled: true, withhold: 10 }, { touch, edge: { ...action.edge, reason: "browser-action" } }), false);
});

test("the touch cookie records a minted unit once, keeps it, and orders keys canonically", () => {
  const unit = mintHoldoutUnit();
  assert.match(unit, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(unit, mintHoldoutUnit());
  const first = observeTouchCookie("", ["biz"], "https://example.com/?biz=saas", "", null, [], unit);
  assert.equal(decodeURIComponent(first.value), `{"v":1,"q":{"biz":["saas","saas"]},"r":"","u":"${unit}"}`);
  const next = observeTouchCookie(first.cookie, ["biz"], "https://example.com/pricing", "https://other.example/", null, [], mintHoldoutUnit());
  assert.equal(next.state.u, unit);
  assert.equal(next.changed, false);
  const legacy = `${TOUCH_COOKIE_NAME}=${encodeURIComponent(JSON.stringify({ v: 1, q: {}, r: "" }))}`;
  assert.equal(decodeURIComponent(observeTouchCookie(legacy, [], "https://example.com/", "", null, [], unit).value), `{"v":1,"q":{},"r":"","u":"${unit}"}`);
  for (const invalid of ["short", `${unit}!`, 42]) {
    assert.equal(decodeTouchCookie(`${TOUCH_COOKIE_NAME}=${encodeURIComponent(JSON.stringify({ v: 1, q: {}, u: invalid }))}`, []).u, undefined);
  }
});
