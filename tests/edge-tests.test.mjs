import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "vitest";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { decide, evaluatePlan } from "../src/edge-plan.ts";
import { personalizeResponse } from "../src/personalize.ts";
import { createPlanCache, startPlanLoad } from "../src/plan-load.ts";
import { admitRequest } from "../src/request.ts";
import { decodeTouchCookie, observeTouchCookie, TOUCH_COOKIE_NAME } from "../src/touch-cookie.ts";
import { HTMLRewriter } from "../src/wasm.ts";

// Source fixture: RightMessage app tests/Fixtures/edge-tests.json (copied byte for byte). The app
// compiles `config` into exactly `plan`; the browser tests read the same cases and envelopes.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/edge-tests.json", import.meta.url), "utf8"));
const revision = "c".repeat(64);
const release = { version: 1, teamPid: fixture.plan.teamPid, revision, planUrl: `https://t.rightmessage.com/${fixture.plan.teamPid}/revisions/${revision}/plan.json`, loaderUrl: `https://t.rightmessage.com/${fixture.plan.teamPid}.js?revision=${revision}` };
const planOf = entry => ({ ...fixture.plan, ...entry.plan });
const requestOf = entry => new Request(entry.url, { headers: { cookie: entry.cookie } });
const wireStep = step => step.kind === "apply" ? { kind: "apply", actionId: step.action.actionId, ...(step.versions ? { versions: step.versions } : {}) } : step;
const wireDecision = ({ campaignId, variantId, layer, versionId, actions }) => ({ campaignId, variantId, layer, ...(versionId ? { versionId } : {}), actionIds: actions.map(action => action.actionId) });
const variantOf = new Map(fixture.plan.campaigns.flatMap(campaign => [...(campaign.original?.actions ?? []), ...campaign.variants.flatMap(variant => variant.actions)]).map(action => [action.actionId, action.variantId]));
const envelope = html => {
  const match = html.match(/<script type="application\/json" id="RM_EDGE">([\s\S]*?)<\/script>/);
  return match ? JSON.parse(match[1]) : null;
};

let native;
beforeAll(async () => {
  const bundled = await build({ stdin: { contents: `import { personalizeResponse } from './src/personalize.ts';
export default { async fetch(request) {
 const { plan, url, cookie, html, release } = await request.json();
 const origin = new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
 const response = await personalizeResponse(new Request(url, { headers: { cookie } }), origin, { promise: Promise.resolve({ loaded: { plan, release } }), abort() {} }, { HTMLRewriter, log() {} });
 return Response.json({ html: await response.text(), headers: Object.fromEntries(response.headers), setCookies: response.headers.getSetCookie() });
}};`, resolveDir: fileURLToPath(new URL("..", import.meta.url)) }, bundle: true, write: false, format: "esm", platform: "browser" });
  native = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-08-31" }));
});
afterAll(async () => native?.dispose());

const personalizeWASM = async entry => {
  const origin = new Response(fixture.html, { headers: { "content-type": "text/html; charset=utf-8" } });
  const response = await personalizeResponse(requestOf(entry), origin, { promise: Promise.resolve({ loaded: { plan: planOf(entry), release } }), abort() {} }, { HTMLRewriter, log() {} });
  return { html: await response.text(), headers: Object.fromEntries(response.headers), setCookies: response.headers.getSetCookie() };
};

test("the fixture carries every walk case of the design", () => {
  assert.deepEqual(fixture.cases.map(entry => entry.name), ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S9b", "S9c"]);
});

for (const entry of fixture.cases) {
  // Source fixture: edge-tests.json#cases (steps, decisions, nextDecisions, setCookie)
  test(`${entry.name}: admission, walk and decisions`, () => {
    const plan = planOf(entry);
    const request = requestOf(entry);
    const admission = admitRequest(plan, request);
    if (entry.edge === "bypass:consent") {
      assert.deepEqual(admission, { bypass: "consent" });
      // A caller that skips admitRequest still personalizes nothing.
      const touch = decodeTouchCookie(entry.cookie, plan.queryNames);
      assert.deepEqual(evaluatePlan(plan, request, touch), []);
      assert.deepEqual(decide(plan, request, touch), []);
      return;
    }
    assert.equal(admission.cookie, entry.setCookie === null ? null : `${TOUCH_COOKIE_NAME}=${entry.setCookie}; Secure; Path=/; SameSite=Lax`);
    assert.deepEqual(evaluatePlan(plan, request, admission.touch).map(wireStep), entry.steps);
    const decisions = decide(plan, request, admission.touch).map(wireDecision);
    assert.deepEqual(decisions, entry.decisions);
    if (entry.nextDecisions) assert.deepEqual([...decisions.filter(d => d.layer === "audience"), ...decisions.filter(d => d.layer === "original")], entry.nextDecisions);
  });

  // Source fixture: edge-tests.json#cases (receipts, edge, setCookie, text, classes, bodyUnchanged)
  test(`${entry.name}: personalized response matches on native and WASM`, async () => {
    const wasm = await personalizeWASM(entry);
    const nativeResult = await (await native.dispatchFetch("https://test.example/", { method: "POST", body: JSON.stringify({ plan: planOf(entry), url: entry.url, cookie: entry.cookie, html: fixture.html, release }) })).json();
    assert.equal(wasm.html, nativeResult.html);
    assert.deepEqual(wasm.setCookies, nativeResult.setCookies);
    assert.equal(wasm.headers["x-rm-edge"], entry.edge);
    assert.equal(nativeResult.headers["x-rm-edge"], entry.edge);
    assert.deepEqual(wasm.setCookies, entry.setCookie === null ? [] : [`${TOUCH_COOKIE_NAME}=${entry.setCookie}; Secure; Path=/; SameSite=Lax`]);
    const received = envelope(wasm.html);
    assert.deepEqual(received?.receipts.map(({ actionId, targetId, versions }) => ({ actionId, targetId, ...(versions ? { versions } : {}) })) ?? [], entry.receipts);
    if (entry.bodyUnchanged) {
      assert.equal(wasm.html, fixture.html);
      assert.equal(wasm.headers["cache-control"], undefined);
    }
    const document = new JSDOM(wasm.html).window.document;
    for (const [selector, text] of Object.entries(entry.text ?? {})) assert.equal(document.querySelector(selector).textContent, text, selector);
    for (const [selector, classes] of Object.entries(entry.classes ?? {})) assert.equal(document.querySelector(selector).getAttribute("class"), classes, selector);
    // The variant stamp names the last applied action's node on each target.
    const last = new Map(entry.receipts.map(({ actionId, targetId }) => [targetId, actionId]));
    for (const [targetId, actionId] of last) assert.equal(document.querySelector(`[data-rm-edge-target="${targetId}"]`).getAttribute("data-rm-variant"), variantOf.get(actionId), targetId);
  });
}

// Source fixture: edge-tests.json#touch. T3 is browser-only: the edge writes no field it does not own.
test("the edge touch cookie writer agrees with the browser's for the landing path field", () => {
  for (const entry of fixture.touch.filter(row => row.name !== "T3")) {
    const observation = observeTouchCookie(entry.header, entry.queryNames, entry.url, entry.referrer);
    assert.equal(observation.value, entry.value, entry.name);
    assert.equal(observation.changed, entry.changed, entry.name);
  }
});

// Source fixture: edge-tests.json#plan
test("0.1 and 0.2 evaluators find nothing executable in the fixture plan", () => {
  // 0.2.2 executes a variant action when supported is true, or campaign-experiment with operations, and never reads `original`.
  const legacyExecutable = action => action.edge?.supported === true || (action.edge?.reason === "campaign-experiment" && (action.edge.operations?.length ?? 0) > 0);
  assert.deepEqual(fixture.plan.campaigns.flatMap(campaign => campaign.variants.flatMap(variant => variant.actions)).filter(legacyExecutable), []);
  assert.equal(fixture.plan.version, 1);
});

// Source fixture: edge-tests.json#plan and #cases S1 (cookies); design section 7.
test("rm_exclude observes rule facts but mints no unit and writes no cookie", () => {
  const plan = fixture.plan;
  const excluded = admitRequest(plan, new Request("https://example.com/?role=saas", { headers: { cookie: "rm_exclude=1" } }));
  assert.deepEqual(excluded, { touch: { v: 1, q: { role: ["saas", "saas"] }, r: "", l: "/" }, cookie: null });
  const included = admitRequest(plan, new Request("https://example.com/?role=saas", { headers: { cookie: "rm_exclude=0" } }));
  assert.match(included.touch.u, /^[A-Za-z0-9_-]{22}$/);
  assert.match(included.cookie, /^__Host-rm_touch=.*%22u%22%3A%22[A-Za-z0-9_-]{22}%22%7D; Secure; Path=\/; SameSite=Lax$/);
  // Conflicting duplicates read as absent.
  assert.notEqual(admitRequest(plan, new Request("https://example.com/", { headers: { cookie: "rm_exclude=1; rm_exclude=0" } })).cookie, null);
  // A debug request takes precedence over exclusion: every tested node is a cut.
  const s1 = fixture.cases.find(entry => entry.name === "S1");
  const debug = new Request("https://example.com/?role=saas&debug=true", { headers: { cookie: `${s1.cookie}; rm_exclude=1` } });
  assert.deepEqual(evaluatePlan(plan, debug, admitRequest(plan, debug).touch).map(wireStep), fixture.cases.find(entry => entry.name === "S6").steps);
});

// Source fixture: edge-tests.json#plan and #cases S9; design section 7.
test("consent is checked first and gates a version 1 plan that requires it", () => {
  const plan = { ...fixture.plan, consent: "required" };
  const request = cookie => new Request("https://example.com/?role=saas", { headers: { cookie } });
  let observed = false;
  const observe = (...args) => { observed = true; return observeTouchCookie(...args); };
  for (const cookie of ["", "rm_exclude=1", "rm_consent=yes", "rm_consent=", "rm_consent=1; rm_consent=0"]) {
    assert.deepEqual(admitRequest(plan, request(cookie), observe), { bypass: "consent" }, cookie);
    assert.deepEqual(evaluatePlan(plan, request(cookie), { q: {} }), [], cookie);
  }
  assert.equal(observed, false);
  assert.equal(admitRequest(plan, request("rm_consent=1; rm_consent=1"), observe).cookie === null, false);
  assert.equal(observed, true);
});

// Source fixture: edge-tests.json#plan; design section 7 (fail closed).
test("a version 2 plan loads only with consent required", async () => {
  const load = async plan => {
    const fetch = request => new Response(JSON.stringify(request.url.endsWith("/release.json") ? release : plan));
    return (await startPlanLoad(new Request("https://example.com/"), { teamPid: fixture.plan.teamPid }, { fetch, planCache: createPlanCache() }).promise);
  };
  assert.deepEqual(await load({ ...fixture.plan, version: 2 }), { reason: "invalid-plan" });
  assert.deepEqual(await load({ ...fixture.plan, version: 3, consent: "required" }), { reason: "invalid-plan" });
  const loaded = await load({ ...fixture.plan, version: 2, consent: "required" });
  assert.equal(loaded.loaded.plan.consent, "required");
});

// Source fixture: edge-tests.json#plan and #cases S1, S2 (cookies); design section 3.
test("setup tests render untested, debug cuts them, and a held-back audience never claims", () => {
  const touchOf = name => fixture.cases.find(entry => entry.name === name).cookie;
  const steps = (plan, url, cookie) => {
    const request = new Request(url, { headers: { cookie } });
    return evaluatePlan(plan, request, admitRequest(plan, request).touch).map(wireStep);
  };
  const setup = structuredClone(fixture.plan);
  setup.campaigns[0].original = { abTest: { id: "abt_OrigHero0001", state: "setup" }, actions: [] };
  setup.campaigns[0].variants[0].abTest = { id: "abt_AbCdEf012345", state: "setup" };
  setup.campaigns[0].variants[0].actions = setup.campaigns[0].variants[0].actions.filter(action => !action.versions || action.versions.includes("A")).map(({ versions: _versions, ...action }) => action);
  assert.deepEqual(steps(setup, "https://example.com/?role=saas", touchOf("S1")), [{ kind: "apply", actionId: "act_dep" }, { kind: "apply", actionId: "act_cta" }, { kind: "apply", actionId: "act_sub" }]);
  assert.deepEqual(steps(setup, "https://example.com/?role=saas&debug=yes", touchOf("S1")), [{ kind: "cut" }, { kind: "apply", actionId: "act_dep" }, { kind: "cut" }]);
  // zZ9 is held back: var_ent's undecided rules do not matter, the browser never writes it.
  assert.deepEqual(steps(fixture.plan, "https://example.com/?role=enterprise", touchOf("S2")), [{ kind: "apply", actionId: "act_dep" }]);
  // A deployment renders without a unit, while the unknown Original version claims its forms.
  assert.deepEqual(evaluatePlan(fixture.plan, new Request("https://example.com/"), { q: {} }).map(wireStep), [{ kind: "claim", selector: "h1", slots: ["children"] }, { kind: "apply", actionId: "act_dep" }]);
});
