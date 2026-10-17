import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { abTestVersionPoint, assignAbTestVersion, assignmentUnit, decodeTestVersions } from "../src/assignment.ts";
import { evaluatePlan } from "../src/edge-plan.ts";

// Source fixture: RightMessage app tests/Fixtures/audience-test-assignment.json (copied byte for byte).
const assignment = JSON.parse(readFileSync(new URL("./fixtures/audience-test-assignment.json", import.meta.url), "utf8"));
const UNIT = "AAAAAAAAAAAAAAAAAAAAAA";
const KEY = "abt_AbCdEf012345:abr_AbCdEf0123456789";

// Source fixture: audience-test-assignment.json#vectors
test("audience version points match the browser's rm-abtest-v1 draw", () => {
  for (const { unit, campaignId, audienceId, testId, run, point } of assignment.vectors) {
    assert.equal(abTestVersionPoint(unit, campaignId, audienceId, testId, run), point, unit);
  }
});

// Source fixture: audience-test-assignment.json#originalVectors
test("Original-layer version points hash the node id original and pick the browser's version", () => {
  assert.equal(assignment.originalVectors.length, 3);
  for (const { unit, campaignId, audienceId, testId, run, point, expected } of assignment.originalVectors) {
    assert.equal(audienceId, "original");
    assert.equal(abTestVersionPoint(unit, campaignId, audienceId, testId, run), point, unit);
    assert.equal(assignAbTestVersion({ A: 50, B: 50 }, point), expected, unit);
  }
});

// Source fixture: audience-test-assignment.json#boundaries
test("version boundaries walk A to D in fixed order whatever the weight key order", () => {
  assert.ok(assignment.boundaries.length > 0);
  for (const { weights, point, expected } of assignment.boundaries) {
    assert.equal(assignAbTestVersion(weights, point), expected, `${JSON.stringify(weights)} at ${point}`);
  }
  assert.throws(() => assignAbTestVersion({ A: 50, B: 50 }, 100), /between 0 and 100/);
});

// Source: design test plan "Units and ledgers" (edge-tests.md); no app fixture rows.
test("the unit is a valid touch unit, else the visitor id beside either mirrored ledger", () => {
  assert.equal(assignmentUnit(undefined, { vid: "v", ab: { v: 1, r: [] } }), "v");
  assert.equal(assignmentUnit(undefined, { vid: "v", ca: { v: 1, r: [] } }), "v");
  assert.equal(assignmentUnit(undefined, { vid: "v" }), null);
  assert.equal(assignmentUnit(undefined, { vid: "v", ab: { v: 2, r: [] } }), null);
  assert.equal(assignmentUnit(UNIT, { vid: "v", ca: { v: 1, r: [] } }), UNIT);
  assert.equal(assignmentUnit("short", {}), null);
});

// Source: design test plan "Units and ledgers" (edge-tests.md).
test("the version ledger keeps valid records and drops a key recorded twice", () => {
  const decoded = decodeTestVersions({ ab: { v: 1, r: [[KEY, true, "B"], [KEY, false, "A"], ["abt_x:abr_y", true, "B"], ["bad", true, "B"], ["abt_z:abr_z", true, "E"]] } });
  assert.deepEqual([...decoded], [["abt_x:abr_y", "B"]]);
  assert.deepEqual([...decodeTestVersions({ ab: { v: 1, r: [["abt_x:abr_y", "yes", "B"], ["abt_x:abr_y", true, "B", 1], [`abt_${"a".repeat(250)}:abr_y`, true, "C"]] } })], []);
  assert.equal(decodeTestVersions({ ab: { v: 1, r: Array.from({ length: 129 }, (_, index) => [`abt_t${index}:abr_r`, true, "A"]) } }), null);
  assert.equal(decodeTestVersions({ ab: { v: 1, r: Array.from({ length: 128 }, (_, index) => [`abt_t${index}:abr_r`, true, "A"]) } }).size, 128);
  assert.equal(decodeTestVersions({}), null);
});

// Source: design test plan "Weights" (edge-tests.md); the plan shape follows edge-tests.json#plan.
test("invalid weights leave the version unknown, so the tested node becomes claims", () => {
  const action = (id, versions) => ({ $type: "MODIFY_ELEMENT", id, actionId: id, campaignId: "cpn_w", variantId: "var_w", page: [{ domain: "*", path: "*" }], selector: "h1", modifications: { text: id }, ...(versions ? { versions } : {}), edge: { supported: false, reason: "campaign-test", operations: ["text"], deferredOperations: [] } });
  const plan = weights => ({ version: 1, teamPid: "demo-team", queryNames: [], dimensions: [], campaigns: [{ id: "cpn_w", is_active: true, testing: { is_enabled: false, withhold: 0 }, variants: [{ id: "var_w", rules: { all: [] }, abTest: { id: "abt_W", state: "running", run: "abr_W", weights }, actions: [action("act_a", ["A"]), action("act_b", ["B"])] }] }] });
  const steps = weights => evaluatePlan(plan(weights), new Request("https://example.com/"), { q: {}, u: UNIT });
  const claims = [{ kind: "claim", selector: "h1", slots: ["children"] }, { kind: "claim", selector: "h1", slots: ["children"] }];
  for (const weights of [{ A: 50, B: 49 }, { A: 50, E: 50 }, { B: 100 }, { A: 0, B: 100 }, { A: 50.5, B: 49.5 }, null]) {
    assert.deepEqual(steps(weights), claims, JSON.stringify(weights));
  }
  assert.equal(steps({ A: 50, B: 50 }).length, 1);
  assert.equal(steps({ A: 50, B: 50 })[0].kind, "apply");
});
