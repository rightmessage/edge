import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { carriedDimensions, decodeUrlContext } from "../src/context.ts";
import { decide, evaluatePlan } from "../src/edge-plan.ts";
import { personalizeResponse } from "../src/personalize.ts";
import { admitRequest } from "../src/request.ts";
import { decodeTouchCookie, observeTouchCookie } from "../src/touch-cookie.ts";
import { HTMLRewriter } from "../src/wasm.ts";

// Source fixture: edge-tests.json#plan (a holdback campaign with a running Original test and audience test, and a deployment).
const fixture = JSON.parse(readFileSync(new URL("./fixtures/edge-tests.json", import.meta.url), "utf8"));
const revision = "d".repeat(64);
const release = { version: 1, teamPid: fixture.plan.teamPid, revision, planUrl: `https://t.rightmessage.com/${fixture.plan.teamPid}/revisions/${revision}/plan.json`, loaderUrl: `https://t.rightmessage.com/${fixture.plan.teamPid}.js?revision=${revision}` };
const encode = payload => Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "~");
const carry = (dims, extra = {}) => `_rm=${encodeURIComponent(encode({ v: 1, dims, ...extra }))}`;
const wireStep = step => step.kind === "apply" ? { kind: "apply", actionId: step.action.actionId, ...(step.versions ? { versions: step.versions } : {}) } : step;

// var_saas needs the asked, signalled `dim_role` (an answer, or `?role=saas`) and the plain `dim_plan`.
const consentPlan = (() => {
  const plan = structuredClone(fixture.plan);
  plan.version = 2;
  plan.consent = "required";
  plan.dimensions = [
    { id: "dim_role", isMultiWinning: false, asked: true, segments: [{ id: "seg_saas" }, { id: "seg_ent" }], signals: [{ indicates: "seg_saas", definition: { $source: "query", $type: "custom", query: "role", occurrence: "current", operator: "equals", value: "saas" }, edge: { supported: true, reason: null } }] },
    { id: "dim_plan", isMultiWinning: false, segments: [{ id: "seg_pro" }, { id: "seg_free" }], signals: [] },
    { id: "dim_source", isMultiWinning: false, segments: [{ id: "seg_ads" }], signals: [{ indicates: "seg_ads", definition: { $source: "query", $type: "custom", query: "src", occurrence: "current", operator: "equals", value: "ads" }, edge: { supported: true, reason: null } }] },
  ];
  plan.campaigns[0].variants[0].rules = { all: [{ segment: "seg_saas" }, { segment: "seg_pro" }] };
  return plan;
})();
// A unit drawing Original B and arms/versions recorded in `_rm_ctx`: none may be read before consent.
const STALE = `__Host-rm_touch=%7B%22v%22%3A1%2C%22q%22%3A%7B%7D%2C%22r%22%3A%22%22%2C%22u%22%3A%22AAAAAAAAAAAAAAAAAAAAAA%22%7D; _rm_ctx=${encode({ v: 1, dims: { dim_role: ["seg_saas"], dim_plan: ["seg_pro"] }, ca: { v: 1, r: [["cpn_opCBD8W3", true, true]] }, ab: { v: 1, r: [["abt_AbCdEf012345:abr_AbCdEf0123456789", true, "B"]] } })}`;
const PRE_CONSENT_STEPS = [{ kind: "apply", actionId: "act_dep" }, { kind: "apply", actionId: "act_cta" }, { kind: "apply", actionId: "act_sub", versions: ["A"] }];
const request = (query, cookie = "") => new Request(`https://example.com/${query ? `?${query}` : ""}`, { headers: { cookie } });
const steps = (plan, req, touch = { q: {} }) => evaluatePlan(plan, req, touch).map(wireStep);
const respond = async (plan, req) => {
  const origin = new Response(fixture.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
  const response = await personalizeResponse(req, origin, { promise: Promise.resolve({ loaded: { plan, release } }), abort() {} }, { HTMLRewriter, log() {} });
  return { html: await response.text(), headers: Object.fromEntries(response.headers), setCookies: response.headers.getSetCookie() };
};

test("before consent, `_rm` answers personalize with assignment off, reading and writing no cookie", async () => {
  let observed = false;
  const observe = (...args) => { observed = true; return observeTouchCookie(...args); };
  for (const cookie of ["", STALE, "rm_consent=0"]) {
    const req = request(carry({ dim_role: ["seg_saas"], dim_plan: ["seg_pro"] }), cookie);
    const admission = admitRequest(consentPlan, req, observe);
    assert.equal(admission.cookie, null, cookie);
    assert.equal(admission.touch.u, undefined, cookie);
    // Every test shows version A (the Original layer stays unchanged) and the holdback campaign renders its treatment.
    assert.deepEqual(steps(consentPlan, req, admission.touch), PRE_CONSENT_STEPS, cookie);
    // A caller that skips admitRequest gets the same walk: the touch it passes is ignored.
    assert.deepEqual(steps(consentPlan, req, decodeTouchCookie(cookie, consentPlan.queryNames)), PRE_CONSENT_STEPS, cookie);
    assert.deepEqual(decide(consentPlan, req, admission.touch).map(({ campaignId, variantId, versionId }) => ({ campaignId, variantId, versionId })), [
      { campaignId: "cpn_deploy0001", variantId: "original", versionId: undefined },
      { campaignId: "cpn_opCBD8W3", variantId: "var_saas", versionId: "A" },
    ], cookie);
    const response = await respond(consentPlan, req);
    assert.equal(response.headers["x-rm-edge"], "applied", cookie);
    assert.deepEqual(response.setCookies, [], cookie);
    assert.equal(response.headers["cache-control"], "private, no-store", cookie);
    assert.equal(response.headers["cdn-cache-control"], "no-store", cookie);
    assert.match(response.html, /<p class="sub"[^>]*>For SaaS teams<\/p>/);
    assert.match(response.html, /<h1[^>]*>Ship it<\/h1>/);
  }
  assert.equal(observed, false);
  // `_rm_ctx` answers do not count before consent: without `_rm` dim_plan is unanswered.
  assert.deepEqual(steps(consentPlan, request(carry({ dim_role: ["seg_saas"] }), STALE)), [{ kind: "apply", actionId: "act_dep" }]);
  // The current query is this page view's touch: `?role=saas` still signals seg_saas.
  assert.deepEqual(steps(consentPlan, request(`role=saas&${carry({ dim_plan: ["seg_pro"] })}`)), PRE_CONSENT_STEPS);
});

test("before consent, without an accepted `_rm` dimension the request bypasses as before", async () => {
  const bypasses = [
    "",
    "role=saas",
    // A dimension with signals and no question is evaluated fresh, as the browser does for a URL.
    carry({ dim_source: ["seg_ads"] }),
    // A dimension outside the plan is ignored.
    carry({ dim_elsewhere: ["seg_x"] }),
    carry({}),
    `_rm=${encode({ v: 2, dims: { dim_role: ["seg_saas"] } })}`,
    `_rm=${encode({ dims: { dim_role: ["seg_saas"] } })}`,
    `_rm=${encode("not json")}`,
    `_rm=${Buffer.from([0x7b, 0xff, 0xfe, 0x7d]).toString("base64url")}`,
    "_rm=%25%25%25",
    "_rm=!!!",
    `_rm=${encode({ v: 1, dims: "dim_role" })}`,
  ];
  for (const query of bypasses) {
    const req = request(query, STALE);
    assert.deepEqual(admitRequest(consentPlan, req), { bypass: "consent" }, query);
    assert.deepEqual(evaluatePlan(consentPlan, req, { q: {} }), [], query);
    const response = await respond(consentPlan, req);
    assert.equal(response.headers["x-rm-edge"], "bypass:consent", query);
    assert.equal(response.headers["cache-control"], "public, max-age=60", query);
    assert.equal(response.html, fixture.html, query);
  }
  // The first `_rm` value is the one the browser reads.
  assert.deepEqual(admitRequest(consentPlan, request(`_rm=bad&${carry({ dim_plan: ["seg_pro"] })}`)), { bypass: "consent" });
  assert.notDeepEqual(admitRequest(consentPlan, request(`${carry({ dim_plan: ["seg_pro"] })}&_rm=bad`)), { bypass: "consent" });
});

test("a carried dimension's segments outside it are dropped, and the rest of the dimension is replaced", () => {
  assert.deepEqual(carriedDimensions(consentPlan.dimensions, new URL(`https://example.com/?${carry({ dim_role: ["seg_bogus", "seg_saas", 7], dim_plan: "seg_pro", dim_source: ["seg_ads"], dim_elsewhere: ["seg_x"] })}`)), { dim_role: ["seg_saas"], dim_plan: [] });
  // An accepted dimension with no valid segment still admits the request: it is answered with nothing.
  const invalid = request(carry({ dim_role: ["seg_bogus"], dim_plan: ["seg_pro"] }));
  assert.notDeepEqual(admitRequest(consentPlan, invalid), { bypass: "consent" });
  assert.deepEqual(steps(consentPlan, invalid), [{ kind: "apply", actionId: "act_dep" }]);
  assert.deepEqual(steps(consentPlan, request(carry({ dim_role: ["seg_bogus", "seg_saas"], dim_plan: ["seg_pro"] }))), PRE_CONSENT_STEPS);
  // `vars` and every other field stay with the browser.
  assert.deepEqual(decodeUrlContext(new URL(`https://example.com/?${carry({ dim_plan: ["seg_pro"] }, { vars: { plan: "pro" } })}`)), { v: 1, dims: { dim_plan: ["seg_pro"] }, vars: { plan: "pro" } });
});

test("with consent, accepted `_rm` dimensions replace `_rm_ctx` answers per dimension", async () => {
  const touch = "__Host-rm_touch=%7B%22v%22%3A1%2C%22q%22%3A%7B%7D%2C%22r%22%3A%22%22%2C%22u%22%3A%22AAAAAAAAAAAAAAAAAAAAAA%22%7D";
  const context = dims => `_rm_ctx=${encode({ v: 1, dims })}`;
  const consented = (query, dims, plan = consentPlan) => {
    const req = request(query, `rm_consent=1; ${touch}; ${context(dims)}`);
    return steps(plan, req, admitRequest(plan, req).touch);
  };
  // Assignment is normal again: unit AAAA… draws Original B and audience version A, as fixture case S1.
  const S1 = fixture.cases.find(entry => entry.name === "S1").steps;
  assert.deepEqual(consented("", { dim_role: ["seg_saas"], dim_plan: ["seg_pro"] }), S1);
  // The payload wins for dim_role; dim_plan keeps its `_rm_ctx` answer.
  assert.deepEqual(consented(carry({ dim_role: ["seg_saas"] }), { dim_role: ["seg_ent"], dim_plan: ["seg_pro"] }), S1);
  assert.notDeepEqual(consented("", { dim_role: ["seg_ent"], dim_plan: ["seg_pro"] }), S1);
  // An accepted dimension with no valid segment clears that dimension's `_rm_ctx` answer.
  assert.notDeepEqual(consented(carry({ dim_plan: ["seg_bogus"] }), { dim_role: ["seg_saas"], dim_plan: ["seg_pro"] }), S1);
  // A dimension with signals and no question is skipped and keeps its `_rm_ctx` answer.
  const unasked = structuredClone(consentPlan);
  delete unasked.dimensions[0].asked;
  assert.deepEqual(consented(carry({ dim_role: ["seg_ent"] }), { dim_role: ["seg_saas"], dim_plan: ["seg_pro"] }, unasked), S1);
  assert.notDeepEqual(consented(carry({ dim_role: ["seg_ent"] }), { dim_role: ["seg_saas"], dim_plan: ["seg_pro"] }), S1);
  // A consented visitor still gets the usual touch cookie.
  const response = await respond(consentPlan, request(`role=saas&${carry({ dim_role: ["seg_saas"] })}`, `rm_consent=1; ${touch}; ${context({ dim_plan: ["seg_pro"] })}`));
  assert.equal(response.headers["x-rm-edge"], "applied");
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.setCookies.length, 1);
  assert.doesNotMatch(response.setCookies[0], /_rm%22/);
});

test("`_rm` is never a touch query name", () => {
  const value = encode({ v: 1, dims: { dim_role: ["seg_saas"] } });
  const observation = observeTouchCookie("", ["_rm", "_rm_ctx", "role"], `https://example.com/?role=saas&_rm=${value}&_rm_ctx=x`, "");
  assert.deepEqual(observation.state.q, { role: ["saas", "saas"] });
  const tampered = `__Host-rm_touch=${encodeURIComponent(JSON.stringify({ v: 1, q: { _rm: [value, value], role: ["a", "b"] } }))}`;
  assert.deepEqual(decodeTouchCookie(tampered, ["_rm", "role"]).q, { role: ["a", "b"] });
  const plan = { ...consentPlan, queryNames: ["_rm", "role"] };
  const req = request(`role=saas&${carry({ dim_plan: ["seg_pro"] })}`, "rm_consent=1");
  assert.deepEqual(admitRequest(plan, req).touch.q, { role: ["saas", "saas"] });
});
