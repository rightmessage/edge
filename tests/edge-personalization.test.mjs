import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { evaluatePlan } from "../src/edge-plan.ts";
import { edgeSignalBinding } from "../src/context.ts";
import { holdoutPoint } from "../src/holdout.ts";

let mf;
const revision = "a".repeat(64);
const action = (selector, modifications, extra = {}) => ({ id: "action", actionId: "action", campaignId: "campaign", variantId: "variant", type: "MODIFY_ELEMENT", page: [{ domain: "*", path: "/*" }], selector, modifications, edge: { supported: true, operations: Object.keys(modifications).flatMap(key => key === "text" && modifications.findReplace?.length ? [] : ["attr", "style"].includes(key) ? Object.keys(modifications[key]).map(name => `${key}:${name}`) : [key]), deferredOperations: [] }, ...extra });
const plan = (actions, definition = { $source: "query", query: "biz", occurrence: "last touch", operator: "equals", value: "saas" }) => ({ version: 1, teamPid: "demo-team", queryNames: ["biz"], dimensions: [{ id: "business", isMultiWinning: false, segments: [{ id: "saas" }], signals: [{ indicates: "saas", definition, edge: { supported: true } }] }], campaigns: [{ id: "campaign", is_active: true, variants: [{ id: "variant", rules: { all: [{ segment: "saas" }] }, actions }] }] });
const mixedSignalPlan = JSON.parse(readFileSync(new URL("./fixtures/mixed-signal-plan.json", import.meta.url), "utf8"));
const contextCookie = payload => Buffer.from(JSON.stringify({ v: 1, ...payload })).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "~");
const evaluateDate = (definition, timeZone, now) => {
  const request = new Request("https://rightmessage.com/");
  Object.defineProperty(request, "cf", { value: timeZone === undefined ? {} : { timezone: timeZone } });
  return evaluatePlan(
    plan([action("h1", { text: "matched" })], { ...definition, edge: { supported: true, reason: null } }),
    request,
    { q: {} },
    new Date(now),
  );
};
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import { personalizeResponse, createPlanCache, startPlanLoad } from './src/index.ts';
function createWorker(render, options, loadDependencies, dependencies) {
 return {async fetch(request) {
  const planLoad = startPlanLoad(request, options, loadDependencies);
  const origin = await render(request);
  return personalizeResponse(request, origin, planLoad, dependencies);
 }};
}
export default {async fetch(request) {
 const x=await request.json(); const bytes=new TextEncoder().encode(x.html);
 const source=new ReadableStream({start(c){const n=x.split??bytes.length;c.enqueue(bytes.slice(0,n));c.enqueue(bytes.slice(n));c.close();}});
 const origin=new Response(source,{status:x.status||200,headers:{'content-type':x.contentType||'text/html; charset=utf-8','etag':'"original"','last-modified':'Tue, 01 Sep 2026 00:00:00 GMT','content-length':String(bytes.length),'cache-control':'public, max-age=60',...x.headers}});
 const req=new Request(x.url||'https://rightmessage.com/?biz=saas',{method:x.method||'GET',headers:x.requestHeaders||{}}); Object.defineProperty(req,'cf',{value:x.cf||{}});
 const native=HTMLRewriter;
 let transforms=0;
 class NativeChunks {constructor(){this.r=new native();this.final=false} on(selector,handler){this.final ||= selector==='head';this.r.on(selector,selector==='head'&&x.lateHandlerFailure?{...handler,element(e){handler.element(e);throw new Error('late handler failure')}}:handler);return this} onDocument(...args){this.r.onDocument(...args);return this} transform(response){transforms++;const input=new Response(new ReadableStream({async start(c){const data=new Uint8Array(await response.arrayBuffer());const n=x.split??data.length;c.enqueue(data.slice(0,n));await Promise.resolve();c.enqueue(data.slice(n));c.close();}}),response);const out=this.r.transform(input);if(!x.lateFailure||!this.final)return out;return new Response(new ReadableStream({async start(c){const data=await out.arrayBuffer();c.enqueue(new Uint8Array(data));c.error(new Error('late output failure'));}}),out)}}
 const tagRequests=[]; const logs=[];
 const tagRouter={fetch(request){tagRequests.push({url:request.url,accept:request.headers.get('accept')});if(x.planStall)return new Promise((_,reject)=>request.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));if(x.planFailure)return new Response('',{status:503});return new Response(x.invalidPlan?'{':JSON.stringify(request.url.endsWith('/release.json')?{version:1,teamPid:'demo-team',revision:'${revision}',planUrl:'https://t.rightmessage.com/demo-team/revisions/${revision}/plan.json',loaderUrl:'https://t.rightmessage.com/demo-team.js?revision=${revision}'}:x.plan));}};
 const options={tagOrigin:'https://t.rightmessage.com',teamPid:'demo-team',enabled:!x.siteEnv||x.siteEnv==='production'};
 const loadDependencies={fetch:request=>tagRouter.fetch(request),planCache:createPlanCache(),planTimeoutMs:x.planTimeoutMs};
 const dependencies={HTMLRewriter:NativeChunks,log(_message,details){logs.push(details.reason)},observeTouchCookie:x.touchFailure?()=>{throw new Error('touch failure')}:undefined};
 const started=Date.now();
 const response=x.useWorker?await createWorker(async()=>origin,options,loadDependencies,dependencies).fetch(req):await personalizeResponse(req,origin,startPlanLoad(req,options,loadDependencies),dependencies);
 const elapsed=Date.now()-started;
 const result=await response.arrayBuffer(); const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',result)),b=>b.toString(16).padStart(2,'0')).join('');
 return new Response(JSON.stringify({html:new TextDecoder().decode(result),hash,headers:Object.fromEntries(response.headers),setCookies:response.headers.getSetCookie(),status:response.status,tagRequests,logs,elapsed,transforms}));
}};`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      sourcefile: "edge-test-worker.js",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",

  });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-08-31" }));
});
afterAll(async () => mf?.dispose());
const run = async (options) => (await mf.dispatchFetch("http://test/", { method: "POST", body: JSON.stringify({ html: '<html><head></head><body><h1 class="rmcloak">teams</h1></body></html>', plan: plan([action("h1", { findReplace: [{ find: "teams", replace: "software teams" }] })]), ...options }) })).json();
const receipt = (html) => JSON.parse(html.match(/<script[^>]*id="RM_EDGE"[^>]*>([\s\S]*?)<\/script>/)[1]);
const assertBypass = (result, reason) => {
  assert.equal(result.headers["x-rm-edge"], `bypass:${reason}`);
  assert.deepEqual(result.logs, [reason]);
};

for (const selector of ["h1", ".copy", "#headline", '[data-copy="hero"]', "main h1", "main > h1", "h1:nth-child(2)", "h1:nth-of-type(1)", "h1:not(.other)"]) {
  test(`native selector ${selector} personalizes only the matched target`, async () => {
    const result = await run({ html: '<html><head></head><body><main><p>teams</p><h1 id="headline" class="copy" data-copy="hero">teams</h1></main></body></html>', plan: plan([action(selector, { text: "software" })]) });
    assert.match(result.html, /<p>teams<\/p>/);
    assert.match(result.html, />software<\/h1>/);
    assert.equal(receipt(result.html).receipts.length, 1);
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers["content-length"], undefined);
    assert.match(result.headers["cache-control"], /private.*no-store/);
    assert.equal(result.headers["x-rm-edge"], "applied");
    assert.deepEqual(result.logs, []);
  });
}
for (const selector of ["p + h1", "p ~ h1", "h1:last-child", "main:has(h1)"]) {
  test(`compiler-deferred selector ${selector} remains browser work`, async () => {
    const html = '<html><head></head><body><p></p><h1>teams</h1></body></html>';
    const result = await run({ html, plan: plan([action(selector, { text: "wrong" }, { edge: { supported: false, reason: "selector" } })]) });
    assert.equal(result.html, html);
    assert.equal(result.headers.etag, '"original"');
    assertBypass(result, "cookie-only");
  });
}
test("every input split preserves UTF-8, nested children, and ordered regex/literal replacements", async () => {
  const html = '<html><head></head><body><h1>café teams <span>teams</span> teams</h1></body></html>';
  for (let split = 0; split <= new TextEncoder().encode(html).length; split++) {
    const result = await run({ html, split, plan: plan([action("h1", { text: "ignored", findReplace: [{ find: "/teams/g", replace: "software" }, { find: "software", replace: "software teams" }] })]) });
    assert.match(result.html, />café software teams <span>software teams<\/span> software teams<\/h1>/);
    assert.deepEqual(receipt(result.html).originals["e1"].textNodes.map(x => x.text), ["café teams ", "teams", " teams"]);
  }
});
test("query first request, subsequent cookie request, and unmatched visitor", async () => {
  const first = await run({});
  assert.match(first.html, /software teams/);
  const second = await run({ url: "https://rightmessage.com/pricing", requestHeaders: { cookie: first.headers["set-cookie"].split(";")[0] } });
  assert.match(second.html, /software teams/);
  const unmatched = await run({ url: "https://rightmessage.com/" });
  assert.equal(unmatched.html, '<html><head></head><body><h1 class="rmcloak">teams</h1></body></html>');
  assert.match(unmatched.headers["set-cookie"], /__Host-rm_touch=/);
  assertBypass(unmatched, "cookie-only");
});
test("cookie-only result retains bytes and validators but cannot be shared cached", async () => {
  const html = '<!doctype html>\r\n<html><head></head><body>not a target &amp; café</body></html>';
  const result = await run({ html, headers: { "set-cookie": "origin=yes; Secure" } });
  assert.equal(result.html, html);
  assert.equal(result.headers.etag, '"original"');
  assert.ok(result.setCookies.some(value => value.includes("origin=yes")));
  assert.ok(result.setCookies.some(value => value.includes("__Host-rm_touch=")));
  assert.match(result.headers["cache-control"], /private.*no-store/);
  assertBypass(result, "cookie-only");
});
test("late transform failure returns byte-identical original and independent cookie", async () => {
  const html = '<!doctype html>\r\n<html><head></head><body><h1>café teams &amp; friends</h1></body></html>';
  for (const failure of [{ lateFailure: true }, { lateHandlerFailure: true }]) {
    const result = await run({ html, ...failure });
    assert.equal(result.html, html);
    assert.equal(result.hash, createHash("sha256").update(html).digest("hex"));
    assert.equal(result.headers.etag, '"original"');
    assert.match(result.headers["set-cookie"], /__Host-rm_touch=/);
    assertBypass(result, "transform-failed");
  }
});
test("plan unavailability is observable without dependency guesses", async () => {
  const result = await run({ planFailure: true });
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.headers["cache-control"], "public, max-age=60");
  assertBypass(result, "plan-unavailable");
});
test("a stalled plan fetch fails open at the 300ms deadline", async () => {
  const result = await run({ planStall: true });
  assert.equal(result.html, '<html><head></head><body><h1 class="rmcloak">teams</h1></body></html>');
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.headers["cache-control"], "public, max-age=60");
  assert.ok(result.elapsed >= 250 && result.elapsed < 800, `expected the 300ms deadline, got ${result.elapsed}ms`);
  assertBypass(result, "plan-timeout");
});
test("invalid plan data has its own observable fallback", async () => {
  assertBypass(await run({ invalidPlan: true }), "invalid-plan");
});
test("unknown plan schema preserves origin bytes without recording visitor state", async () => {
  const html = '<html><head></head><body><h1>unchanged</h1></body></html>';
  const result = await run({ html, plan: { ...plan([action("h1", { text: "wrong" })]), version: 2 } });
  assert.equal(result.html, html);
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.headers.etag, '"original"');
  assertBypass(result, "invalid-plan");
});
test("service binding fetches revision data while the browser loader stays public", async () => {
  const result = await run({});
  assert.deepEqual(result.tagRequests, [
    { url: "https://t.rightmessage.com/demo-team/release.json", accept: "application/json" },
    { url: `https://t.rightmessage.com/demo-team/revisions/${revision}/plan.json`, accept: "application/json" },
  ]);
  assert.match(result.html, new RegExp(`https://t.rightmessage.com/demo-team.js\\?revision=${revision}`));
});
test("request-level bypasses emit one reason-only log", async () => {
  for (const [reason, inputs] of [
    ["not-production", { siteEnv: "staging" }],
    ["request-method", { method: "POST" }],
    ["rsc", { requestHeaders: { rsc: "1" } }],
    ["preview", { url: "https://rightmessage.com/?preview=1&biz=saas" }],
    ["unsupported-charset", { contentType: "text/html; charset=iso-8859-1" }],
  ]) {
    assertBypass(await run(inputs), reason);
  }
});
test("touch attribution failure is observable without changing the body", async () => {
  assertBypass(await run({ touchFailure: true }), "attribution-failed");
});
test("an unchanged visitor with no eligible actions reports no-actions", async () => {
  const first = await run({});
  const cookie = first.headers["set-cookie"].split(";")[0];
  const result = await run({ plan: plan([]), requestHeaders: { cookie } });
  assertBypass(result, "no-actions");
  assert.equal(result.headers["set-cookie"], undefined);
});
test("a slow concurrent plan cannot delay an origin bypass", async () => {
  const result = await run({ useWorker: true, planStall: true, status: 404 });
  assertBypass(result, "origin-status");
  assert.equal(result.tagRequests.length, 1);
  assert.ok(result.elapsed < 300, `bypassed response waited ${result.elapsed}ms`);
});
test("receipt pins ordinary metadata loader and baseline only once per target", async () => {
  const result = await run({ plan: plan([action("h1", { findReplace: [{ find: "teams", replace: "software teams" }] }), action("h1", { attr: { title: "Personalized" } }, { id: "second", actionId: "second" })]) });
  const envelope = receipt(result.html);
  assert.equal(envelope.revision, revision);
  assert.equal(envelope.receipts.length, 2);
  assert.equal(Object.keys(envelope.originals).length, 1);
  assert.match(result.html, new RegExp(`https://t.rightmessage.com/demo-team.js\\?revision=${revision}`));
  assert.doesNotMatch(result.html, /revisions\/[a-f0-9]+\/published.js/);
  assert.equal(envelope.originals.e1.attributes.title, null);
});
test("hard cookie, UA, geo and first-referrer inputs are request-decidable", async () => {
  const definitions = [
    [{ $source: "device", $type: "browser", browsers: ["Firefox"] }, { requestHeaders: { "user-agent": "Mozilla Firefox/140" } }],
    [{ $source: "location", $type: "country", operator: "includes any", value: ["US"] }, { cf: { country: "US" } }],
    [{ $source: "referrer", $type: "domain", domain: "example.com" }, { requestHeaders: { referer: "https://example.com/campaign" } }],
  ];
  for (const [definition, inputs] of definitions) assert.match((await run({ plan: plan([action("h1", { text: "matched" })], definition), ...inputs })).html, />matched<\/h1>/);
  const hard = Buffer.from(JSON.stringify({ v: 1, dims: { business: ["saas"] } })).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "~");
  const hardPlan = plan([action("h1", { findReplace: [{ find: "teams", replace: "software teams" }] })]);
  hardPlan.dimensions[0].signals = [];
  const result = await run({ plan: hardPlan, url: "https://rightmessage.com/", requestHeaders: { cookie: `_rm_ctx=${hard}` } });
  assert.match(result.html, /software teams/);
  assert.doesNotMatch(result.headers["set-cookie"] || "", /_rm_ctx=/);
});

test("partial action applies safe text without claiming computed visibility", async () => {
  const result = await run({ plan: plan([action("h1", { findReplace: [{ find: "teams", replace: "software teams" }], visibility: "show" }, { edge: { supported: true, operations: ["findReplace"], deferredOperations: ["visibility"] } })]) });
  assert.match(result.html, /software teams/);
  assert.deepEqual(receipt(result.html).receipts[0].operations, ["findReplace"]);
  assert.equal(receipt(result.html).originals.e1.attributes.style, undefined);
});

test("mixed OR resolves request facts but unknown earlier winners remain unknown", async () => {
  const mixed = plan([action("h1", { text: "matched" })], { or: [{ $source: "partner", $type: "customField", value: "saas" }, { $source: "query", query: "biz", occurrence: "last touch", operator: "equals", value: "saas" }] });
  mixed.dimensions[0].signals[0].edge.supported = false;
  assert.match((await run({ plan: mixed })).html, />matched<\/h1>/);
  mixed.dimensions[0].segments.unshift({ id: "unknown" });
  mixed.dimensions[0].signals.unshift({ indicates: "unknown", definition: { $source: "partner", $type: "customField" }, edge: { supported: false } });
  assert.doesNotMatch((await run({ plan: mixed })).html, /RM_EDGE/);
});

test("sanitized production plan resolves anonymous query branches and defers identified single-winning ambiguity", async () => {
  const rendered = await run({ plan: mixedSignalPlan });
  assert.equal(rendered.headers["x-rm-edge"], "applied");
  assert.match(rendered.html, />SaaS<\/h1>/);
  const anonymousSaas = evaluatePlan(
    mixedSignalPlan,
    new Request("https://rightmessage.com/?biz=saas"),
    { q: { biz: ["saas", "saas"] } },
  );
  assert.deepEqual(anonymousSaas.map(item => item.actionId), ["action_saas"]);

  const anonymousEcommerce = evaluatePlan(
    mixedSignalPlan,
    new Request("https://rightmessage.com/?biz=ecommerce"),
    { q: { biz: ["ecommerce", "ecommerce"] } },
  );
  assert.deepEqual(anonymousEcommerce.map(item => item.actionId), ["action_ecommerce"]);

  const identified = evaluatePlan(
    mixedSignalPlan,
    new Request("https://rightmessage.com/?biz=ecommerce", {
      headers: { cookie: `_rm_ctx=${contextCookie({ cid: "sanitized-contact", pid: "bento" })}` },
    }),
    { q: { biz: ["ecommerce", "ecommerce"] } },
  );
  assert.deepEqual(identified, []);
});

// Compiler keys of the sanitized fixture's Bento business-type leaves.
const KEY = { saas: "Saas0001", ecommerce: "Ecom0001", education: "Educ0001" };
// Builds the tag's `es`: profile outcomes bound to project/connection/contact, landing-page
// outcomes bound to project/origin/contact. `es` overrides individual fields for malformed cases.
const identifiedCookie = ({ outcomes = {}, page = {}, origin = "https://rightmessage.com", cid = "sanitized-contact", project = "demo-team", connection = "conn-a", bindTo = {}, day = Math.floor(Date.now() / 86400000), es: override = {} }) => {
  const bound = { project, connection, cid, origin, ...bindTo };
  const lists = values => { const keys = Object.keys(values).sort(); return [keys.filter(k => values[k]).join(""), keys.filter(k => !values[k]).join("")]; };
  const [t, f] = lists(outcomes);
  const es = { v: 1, d: day, b: edgeSignalBinding(bound.project, bound.connection, bound.cid), t, f };
  if (Object.keys(page).length) { const [ht, hf] = lists(page); Object.assign(es, { h: edgeSignalBinding(bound.project, bound.origin, bound.cid), ht, hf }); }
  return `_rm_ctx=${contextCookie({ cid, pid: "bento", identityScope: { project, connection }, es: { ...es, ...override } })}`;
};
const businessActions = (cookie, biz) => evaluatePlan(
  mixedSignalPlan,
  new Request(`https://rightmessage.com/${biz ? `?biz=${biz}` : ""}`, { headers: { cookie } }),
  biz ? { q: { biz: [biz, biz] } } : { q: {} },
).map(item => item.actionId);

test("the snapshot binding matches the tag codec's pinned value", () => {
  assert.equal(edgeSignalBinding("demo-team", "conn", "contact@example.com"), "1eaf88fb");
});

test("an identified contact's recorded integration outcomes decide single-winning segments with browser precedence", () => {
  const recorded = (saas, ecommerce) => identifiedCookie({ outcomes: { [KEY.saas]: saas, [KEY.ecommerce]: ecommerce, [KEY.education]: false } });
  // The ESP fact alone decides, with no query or referrer touch.
  assert.deepEqual(businessActions(recorded(true, false)), ["action_saas"]);
  assert.deepEqual(businessActions(recorded(false, true)), ["action_ecommerce"]);
  // A current-request branch still combines with the recorded facts: SaaS comes first,
  // so its ESP fact beats a later segment's query, while a false ESP fact lets the query decide.
  assert.deepEqual(businessActions(recorded(true, false), "ecommerce"), ["action_saas"]);
  assert.deepEqual(businessActions(recorded(false, false), "ecommerce"), ["action_ecommerce"]);
  assert.deepEqual(businessActions(recorded(false, false), "saas"), ["action_saas"]);
  // Every segment definitely false: no business action, exactly as the browser decides.
  assert.deepEqual(businessActions(recorded(false, false)), []);
});

test("a snapshot from another identity or connection, an unrecorded or republished rule, or a malformed list stays unknown", () => {
  const outcomes = { [KEY.saas]: false, [KEY.ecommerce]: true, [KEY.education]: false };
  // Each case leaves the first segment unknown, so the edge defers the whole dimension.
  for (const [label, cookie] of [
    ["another contact", identifiedCookie({ outcomes, bindTo: { cid: "other-contact" } })],
    ["binding from another connection", identifiedCookie({ outcomes, bindTo: { connection: "conn-old" } })],
    // Internally consistent, but the plan's active connection was replaced.
    ["replaced connection", identifiedCookie({ outcomes, connection: "conn-old" })],
    ["unrecorded rule", identifiedCookie({ outcomes: { [KEY.ecommerce]: true } })],
    ["conflicting outcomes", identifiedCookie({ outcomes, es: { t: KEY.ecommerce + KEY.saas, f: KEY.saas + KEY.education } })],
    ["unsupported version", identifiedCookie({ outcomes, es: { v: 2 } })],
    ["truncated list", identifiedCookie({ outcomes, es: { f: (KEY.saas + KEY.education).slice(0, -1) } })],
    ["non-string list", identifiedCookie({ outcomes, es: { f: [KEY.saas, KEY.education] } })],
    ["missing binding", identifiedCookie({ outcomes, es: { b: undefined } })],
  ]) assert.deepEqual(businessActions(cookie, "ecommerce"), [], label);

  // A republished SaaS rule gets a new key, which no earlier snapshot holds.
  const republished = structuredClone(mixedSignalPlan);
  republished.dimensions[0].signals[0].definition.or[0].and[0].edge.key = "Nw123456";
  const actions = evaluatePlan(republished, new Request("https://rightmessage.com/?biz=ecommerce", { headers: { cookie: identifiedCookie({ outcomes }) } }), { q: { biz: ["ecommerce", "ecommerce"] } });
  assert.deepEqual(actions, []);
  // A plan without an active connection (compiled before this change) never uses a snapshot.
  const unscoped = structuredClone(mixedSignalPlan);
  delete unscoped.connectionScope;
  assert.deepEqual(evaluatePlan(unscoped, new Request("https://rightmessage.com/?biz=ecommerce", { headers: { cookie: identifiedCookie({ outcomes }) } }), { q: { biz: ["ecommerce", "ecommerce"] } }), []);
  assert.deepEqual(businessActions(identifiedCookie({ outcomes }), "ecommerce"), ["action_ecommerce"]);
});

test("a snapshot written on one subdomain decides profile rules on siblings and the apex, but not landing-page rules", () => {
  // SaaS also matches a landing page, recorded true on www only.
  const withLanding = structuredClone(mixedSignalPlan);
  withLanding.dimensions[0].signals[0].definition.or.push({ and: [{ $source: "pageviews", $type: "landingpage", operator: "equals", value: "/integrations/kit", edge: { supported: false, reason: "browser-signal", key: "Land0001" } }] });
  const written = identifiedCookie({ outcomes: { [KEY.saas]: false, [KEY.ecommerce]: true, [KEY.education]: false }, page: { Land0001: true }, origin: "https://www.rightmessage.com" });
  const actions = (host) => evaluatePlan(withLanding, new Request(`https://${host}/`, { headers: { cookie: written } }), { q: {} }).map(item => item.actionId);
  // On the recording origin the landing page makes SaaS win.
  assert.deepEqual(actions("www.rightmessage.com"), ["action_saas"]);
  // Elsewhere the landing page is unknown, so the earlier SaaS segment defers (it is not misapplied as true or false).
  assert.deepEqual(actions("rightmessage.com"), []);
  assert.deepEqual(actions("blog.rightmessage.com"), []);
  // Without a landing-page rule, the ESP outcomes alone decide on every sibling and the apex.
  const espOnly = identifiedCookie({ outcomes: { [KEY.saas]: false, [KEY.ecommerce]: true, [KEY.education]: false }, page: { Land0001: true }, origin: "https://www.rightmessage.com" });
  for (const host of ["www.rightmessage.com", "rightmessage.com", "blog.rightmessage.com"]) {
    assert.deepEqual(evaluatePlan(mixedSignalPlan, new Request(`https://${host}/`, { headers: { cookie: espOnly } }), { q: {} }).map(item => item.actionId), ["action_ecommerce"], host);
  }
});

test("a snapshot is honored up to 30 days old and ignored when older, future-dated or unstamped", () => {
  const now = "2026-10-02T12:00:00.000Z";
  const today = Math.floor(Date.parse(now) / 86400000);
  const outcomes = { [KEY.saas]: true, [KEY.ecommerce]: false, [KEY.education]: false };
  const actions = (options) => evaluatePlan(mixedSignalPlan, new Request("https://rightmessage.com/", { headers: { cookie: identifiedCookie({ outcomes, ...options }) } }), { q: {} }, now).map(item => item.actionId);
  for (const age of [0, 29, 30]) assert.deepEqual(actions({ day: today - age }), ["action_saas"], `age ${age}`);
  for (const [label, options] of [["31 days", { day: today - 31 }], ["future-dated", { day: today + 1 }], ["unstamped", { es: { d: undefined } }], ["non-integer", { es: { d: String(today) } }]]) {
    assert.deepEqual(actions(options), [], label);
  }
});

test("a recorded landing-page outcome lets an identified contact's later segment win, on its own origin only", () => {
  // SaaS also matches a landing page, which the edge cannot see in the request.
  const withLanding = structuredClone(mixedSignalPlan);
  withLanding.dimensions[0].signals[0].definition.or.push({ and: [{ $source: "pageviews", $type: "landingpage", operator: "equals", value: "/integrations/kit", edge: { supported: false, reason: "browser-signal", key: "Land0001" } }] });
  const actions = (options, biz) => evaluatePlan(withLanding, new Request(`https://rightmessage.com/?biz=${biz}`, { headers: { cookie: identifiedCookie(options) } }), { q: { biz: [biz, biz] } }).map(item => item.actionId);
  const esp = { [KEY.saas]: false, [KEY.ecommerce]: false, [KEY.education]: false };
  assert.deepEqual(actions({ outcomes: esp }, "ecommerce"), []);
  assert.deepEqual(actions({ outcomes: esp, page: { Land0001: false } }, "ecommerce"), ["action_ecommerce"]);
  assert.deepEqual(actions({ outcomes: esp, page: { Land0001: true } }, "ecommerce"), ["action_saas"]);
  // `_rm_ctx` is shared across subdomains, but landing-page history is per origin.
  assert.deepEqual(actions({ outcomes: esp, page: { Land0001: false }, origin: "https://blog.rightmessage.com" }, "ecommerce"), []);
  assert.deepEqual(actions({ outcomes: esp, page: { Land0001: false }, origin: "https://rightmessage.com:8443" }, "ecommerce"), []);
  // Anonymous visitors keep the landing page unknown, exactly as before.
  const anonymous = evaluatePlan(withLanding, new Request("https://rightmessage.com/?biz=ecommerce"), { q: { biz: ["ecommerce", "ecommerce"] } });
  assert.deepEqual(anonymous, []);
});

test("a snapshot never changes anonymous visitors or contacts from another project", () => {
  const outcomes = { [KEY.saas]: true, [KEY.ecommerce]: false, [KEY.education]: false };
  // Another project's identity is not this plan's contact: the anonymous profile applies.
  assert.deepEqual(businessActions(identifiedCookie({ outcomes, project: "999" }), "ecommerce"), ["action_ecommerce"]);
  // Without a contact id the snapshot is ignored and anonymous evaluation is unchanged.
  const anonymous = `_rm_ctx=${contextCookie({ es: { v: 1, b: "00000000", t: KEY.saas, f: "" } })}`;
  assert.deepEqual(businessActions(anonymous, "ecommerce"), ["action_ecommerce"]);
  assert.deepEqual(businessActions(anonymous), []);
});

test("the Worker personalizes an identified contact from the snapshot without any touch", async () => {
  const cookie = identifiedCookie({ outcomes: { [KEY.saas]: true, [KEY.ecommerce]: false, [KEY.education]: false } });
  const rendered = await run({ plan: mixedSignalPlan, url: "https://rightmessage.com/", requestHeaders: { cookie } });
  assert.equal(rendered.headers["x-rm-edge"], "applied");
  assert.match(rendered.html, />SaaS<\/h1>/);
  const withoutSnapshot = await run({ plan: mixedSignalPlan, url: "https://rightmessage.com/", requestHeaders: { cookie: `_rm_ctx=${contextCookie({ cid: "sanitized-contact", pid: "bento", identityScope: { project: "demo-team", connection: "conn-a" } })}` } });
  assert.match(withoutSnapshot.headers["x-rm-edge"], /^bypass:/);
});

test("anonymous integration leaves match the browser's empty profile, including positive negatives", () => {
  const withSaasLeaf = leaf => {
    const copy = structuredClone(mixedSignalPlan);
    copy.dimensions[0].signals[0].definition.or[0].and[0] = { ...leaf, edge: { supported: false, reason: "integration-signal" } };
    return copy;
  };
  const ecommerce = (planValue, cookie) => evaluatePlan(
    planValue,
    new Request("https://rightmessage.com/?biz=ecommerce", cookie ? { headers: { cookie } } : {}),
    { q: { biz: ["ecommerce", "ecommerce"] } },
  ).map(item => item.actionId);

  // Each leaf is true for an anonymous browser profile, so the earlier SaaS segment wins.
  for (const leaf of [
    { $source: "bento", $type: "customField", customFieldId: "f", operator: "is not set" },
    { $source: "klaviyo", $type: "isAnonymous" },
    { $source: "hubspot", $type: "eventHistory", eventName: "purchase", operator: "has_not_fired" },
    { $source: "convertkit", $type: "tags", tagIds: ["vip"], operator: "does not include any" },
  ]) {
    assert.deepEqual(ecommerce(withSaasLeaf(leaf)), ["action_saas"], JSON.stringify(leaf));
    assert.deepEqual(ecommerce(withSaasLeaf(leaf), `_rm_ctx=${contextCookie({ cid: "c", pid: leaf.$source })}`), [], `identified ${leaf.$source}`);
  }

  // A negated always-false anonymous leaf is also definitely true.
  const negated = structuredClone(mixedSignalPlan);
  negated.dimensions[0].signals[0].definition.or[0].and[0] = { not: { $source: "bento", $type: "isSubscriber", edge: { supported: false, reason: "integration-signal" } } };
  assert.deepEqual(ecommerce(negated), ["action_saas"]);

  // Unrecognized integration types stay unknown, so the earlier segment still defers.
  assert.deepEqual(ecommerce(withSaasLeaf({ $source: "bento", $type: "futureType" })), []);

  // partner.js compares the raw count: strict for equals, coercing for gte/lt.
  const event = (operator, count) => ({ $source: "drip", $type: "eventHistory", eventName: "purchase", operator, count });
  assert.deepEqual(ecommerce(withSaasLeaf(event("equals", "0"))), ["action_ecommerce"]);
  assert.deepEqual(ecommerce(withSaasLeaf(event("equals", 0))), ["action_saas"]);
  assert.deepEqual(ecommerce(withSaasLeaf(event("gte", "0"))), ["action_saas"]);
  assert.deepEqual(ecommerce(withSaasLeaf(event("lt", "2"))), ["action_saas"]);
});

test("weekday uses the visitor timezone across a Sunday-to-Monday boundary", () => {
  const definition = { $source: "date", $type: "weekday", operator: "includes any", value: ["1"] };
  const now = "2026-09-07T00:30:00.000Z";
  assert.equal(evaluateDate(definition, "UTC", now).length, 1);
  assert.equal(evaluateDate(definition, "America/Los_Angeles", now).length, 0);
});

test("month uses zero-based local months across a month boundary", () => {
  const definition = { $source: "date", $type: "month", operator: "includes any", value: ["8"] };
  const now = "2026-09-01T00:30:00.000Z";
  assert.equal(evaluateDate(definition, "UTC", now).length, 1);
  assert.equal(evaluateDate(definition, "America/Los_Angeles", now).length, 0);
});

test("date between includes both timestamp bounds", () => {
  const definition = {
    $source: "date",
    $type: "date",
    operator: "between",
    value: "2026-09-10T00:00:00.000Z",
    dateEnd: "2026-09-15T12:00:00.000Z",
  };
  assert.equal(evaluateDate(definition, "UTC", "2026-09-10T00:00:00.000Z").length, 1);
  assert.equal(evaluateDate(definition, "UTC", "2026-09-15T12:00:00.000Z").length, 1);
  assert.equal(evaluateDate(definition, "UTC", "2026-09-15T12:00:01.000Z").length, 0);
});

test("date rules stay unknown without a valid visitor timezone", () => {
  const definition = { $source: "date", $type: "weekday", operator: "includes any", value: ["1"] };
  const now = "2026-09-07T00:30:00.000Z";
  assert.equal(evaluateDate(definition, undefined, now).length, 0);
  assert.equal(evaluateDate(definition, "not/a-timezone", now).length, 0);
});

test("a missing hard answer is unanswered, while an answered earlier segment still wins", async () => {
  const answerable = plan([action("h1", { text: "matched" })]);
  answerable.dimensions[0].segments.unshift({ id: "answered" });
  assert.match((await run({ plan: answerable })).html, />matched<\/h1>/);
  const cookie = `_rm_ctx=${contextCookie({ dims: { business: ["answered"] } })}`;
  assert.doesNotMatch((await run({ plan: answerable, requestHeaders: { cookie } })).html, /RM_EDGE/);
});

test("an unobserved touch query has no pageview on first and later requests", async () => {
  const negated = plan(
    [action("h1", { text: "matched" })],
    { not: { $source: "query", query: "missing", occurrence: "first touch", operator: "is set" } },
  );
  negated.queryNames = ["missing"];
  const first = await run({ url: "https://rightmessage.com/", plan: negated });
  assert.match(first.html, />matched<\/h1>/);
  const cookie = first.headers["set-cookie"].split(";")[0];
  assert.match(cookie, /^__Host-rm_touch=/);
  assert.match((await run({ url: "https://rightmessage.com/pricing", plan: negated, requestHeaders: { cookie } })).html, />matched<\/h1>/);
});

test("a cookieless referrer-only visitor resolves Creator on the first and following pages", async () => {
  const referer = "https://smartpassiveincome.com/podcast";
  const first = await run({ plan: mixedSignalPlan, url: "https://rightmessage.com/", requestHeaders: { referer } });
  assert.equal(first.headers["x-rm-edge"], "applied");
  assert.match(first.html, />Creator<\/h1>/);
  const cookie = first.headers["set-cookie"].split(";")[0];
  const next = await run({ plan: mixedSignalPlan, url: "https://rightmessage.com/pricing", requestHeaders: { cookie, referer: "https://rightmessage.com/" } });
  assert.match(next.html, />Creator<\/h1>/);
  // An identified contact may hold an earlier Bento business type, so it defers.
  const identified = `${cookie}; _rm_ctx=${contextCookie({ cid: "sanitized-contact", pid: "bento" })}`;
  assert.doesNotMatch((await run({ plan: mixedSignalPlan, url: "https://rightmessage.com/pricing", requestHeaders: { cookie: identified } })).html, /RM_EDGE/);
});

test("entity text is decoded once, nested markup retained, empty text has restorable children", async () => {
  const html = '<html><head></head><body><h1>teams &amp; caf&#xe9;<span>teams</span></h1></body></html>';
  const result = await run({ html, plan: plan([action("h1", { findReplace: [{ find: "teams & café", replace: "" }, { find: "teams", replace: "A & B" }] })]) });
  assert.match(result.html, /<span>A &amp; B<\/span><\/h1>/);
  assert.equal(receipt(result.html).originals.e1.html, "teams &amp; caf&#xe9;<span>teams</span>");
  assert.deepEqual(receipt(result.html).originals.e1.textNodes, []);
});

test("oversize source and missing bootstrap return exact original bytes", async () => {
  for (const [html, reason] of [
    ["<h1>teams</h1>", "transform-failed"],
    [`<html><head></head><body><h1>teams</h1>${"x".repeat(1024 * 1024)}</body></html>`, "oversized"],
  ]) {
    const result = await run({ html });
    assert.equal(result.html, html);
    assert.equal(result.headers.etag, '"original"');
    assertBypass(result, reason);
  }
});

test("document passes stay constant as the number of actions grows", async () => {
  const count = 30;
  const html = `<html><head></head><body>${Array.from({ length: count }, (_, i) => `<p data-n="${i}" title="t${i}">teams ${i}</p>`).join("")}</body></html>`;
  const mixed = i => [
    { findReplace: [{ find: "teams", replace: "software teams" }] },
    { text: `<b>copy ${i}</b>` },
    { attr: { title: `new ${i}` } },
    { visibility: "hide" },
  ][i % 4];
  const actions = n => Array.from({ length: n }, (_, i) => action(`[data-n="${i}"]`, mixed(i), { id: `a${i}`, actionId: `a${i}` }));
  const one = await run({ html, plan: plan(actions(1)) });
  const many = await run({ html, plan: plan(actions(count)) });
  assert.equal(one.headers["x-rm-edge"], "applied");
  assert.equal(many.headers["x-rm-edge"], "applied");
  assert.equal(receipt(many.html).receipts.length, count);
  assert.equal(many.transforms, one.transforms, "passes must not depend on the action count");
  assert.ok(many.transforms <= 2, `expected at most 2 document passes, got ${many.transforms}`);
  // Emptying a text node needs original inner HTML: the only case with a second, read-only pass.
  const emptied = await run({ html, plan: plan([...actions(count), action('[data-n="0"]', { findReplace: [{ find: "/.+/", replace: "" }] }, { id: "empty", actionId: "empty" })]) });
  assert.equal(emptied.transforms, 2);
  assert.equal(receipt(emptied.html).originals.e1.html, "teams 0");
});

test("distinct actions compose parent and child text in browser order", async () => {
  const result = await run({
    html: '<html><head></head><body><h1>A<span>A</span></h1></body></html>',
    plan: plan([
      action("h1", { findReplace: [{ find: "A", replace: "AA" }] }),
      action("h1 span", { findReplace: [{ find: "AA", replace: "B" }] }, { id: "second", actionId: "second" }),
    ]),
  });
  assert.match(result.html, />AA<span[^>]*>B<\/span><\/h1>/);
  assert.deepEqual(receipt(result.html).receipts.map(x => x.actionId), ["action", "second"]);
});

test("nested text structure changes fail open before browser adoption can double-apply", async () => {
  const html = "<html><head></head><body><h1>A<span>A</span></h1></body></html>";
  const result = await run({
    html,
    plan: plan([
      action("h1", { findReplace: [{ find: "A", replace: "AA" }] }),
      action("h1 span", { text: "<strong>B</strong>, friend" }, { id: "second", actionId: "second" }),
    ]),
  });
  assert.equal(result.html, html);
  assert.equal(result.headers.etag, '"original"');
  assert.doesNotMatch(result.html, /RM_EDGE/);
  assertBypass(result, "transform-failed");
});

test("query duplicates use last decoded value and inherited names are not observations", async () => {
  const duplicate = await run({ url: "https://rightmessage.com/?biz=other&biz=saas" });
  assert.match(duplicate.html, /software teams/);
  const inherited = plan([action("h1", { text: "wrong" })], { $source: "query", query: "toString", occurrence: "last touch", operator: "is set" });
  inherited.queryNames = ["toString"];
  assert.doesNotMatch((await run({ url: "https://rightmessage.com/", plan: inherited })).html, /RM_EDGE/);
});

test("attributes, classes, static style and hide retain the original affected slots", async () => {
  const html = '<html><head></head><body><img id="image" src="/old.png" srcset="/old-2x.png 2x" class="old keep" style="color: red !important; background-image: url(&quot;data:image/svg+xml;a;b&quot;)"></body></html>';
  const result = await run({ html, plan: plan([action("#image", { attr: { src: "/new.png" }, style: { color: "blue" }, classes: { add: ["new"], remove: ["old"] }, visibility: "hide" })]) });
  assert.match(result.html, /src="\/new.png"/);
  assert.doesNotMatch(result.html.split('<body>')[1], /srcset=/);
  assert.match(result.html, /class="keep new"/);
  assert.match(result.html, /color: blue/);
  assert.match(result.html, /display: none/);
  const original = receipt(result.html).originals.e1;
  assert.equal(original.attributes.src, "/old.png");
  assert.equal(original.attributes.srcset, "/old-2x.png 2x");
  assert.equal(original.attributes.class, "old keep");
  assert.equal(original.attributes.style, 'color: red !important; background-image: url("data:image/svg+xml;a;b")');
});

test("a matched selector with no replacement match never claims success", async () => {
  const html = '<html><head></head><body><h1>default copy</h1></body></html>';
  const result = await run({ html });
  assert.equal(result.html, html);
  assert.doesNotMatch(result.html, /data-rm-personalized|RM_EDGE/);
  assert.equal(result.headers.etag, '"original"');
});

test("first-touch and last-touch remain distinct after a later live query observation", async () => {
  const first = await run({});
  const firstTouchPlan = plan([action("h1", { text: "first SaaS" })], { $source: "query", query: "biz", occurrence: "first touch", operator: "equals", value: "saas" });
  const second = await run({ url: "https://rightmessage.com/?biz=services", requestHeaders: { cookie: first.headers["set-cookie"].split(";")[0] }, plan: firstTouchPlan });
  assert.match(second.html, />first SaaS<\/h1>/);
  const last = await run({ url: "https://rightmessage.com/pricing", requestHeaders: { cookie: second.headers["set-cookie"].split(";")[0] } });
  assert.doesNotMatch(last.html, /RM_EDGE/);
});

test("native attribute operators and first-child families are not browser-deferred", async () => {
  const html = '<html><head></head><body><main><h1 data-copy="hero primary" lang="en-US">teams</h1><p>other</p></main></body></html>';
  for (const selector of ['[data-copy]', '[data-copy~="primary"]', '[lang|="en"]', '[data-copy^="hero"]', '[data-copy$="primary"]', '[data-copy*="ro pri"]', 'h1:first-child', 'h1:first-of-type']) {
    const result = await run({ html, plan: plan([action(selector, { text: "native" })]) });
    assert.match(result.html, />native<\/h1>/);
    assert.match(result.html, /<p>other<\/p>/);
  }
});

test("raw-text descendants use browser Text.data rather than HTML entity decoding", async () => {
  const html = '<html><head></head><body><h1><script type="application/json">{"label":"teams &amp;"}</script></h1></body></html>';
  const result = await run({ html, plan: plan([action("h1", { findReplace: [{ find: "&amp;", replace: "literal" }] })]) });
  assert.match(result.html, /<script type="application\/json">\{"label":"teams literal"\}<\/script><\/h1>/);
  assert.equal(receipt(result.html).originals.e1.textNodes[0].text, '{"label":"teams &amp;"}');
});

test("image source receipts retain an absent srcset baseline for browser restoration", async () => {
  const html = '<html><head></head><body><img id="image" src="/old.png"></body></html>';
  const result = await run({ html, plan: plan([action("#image", { attr: { src: "/new.png" } })]) });
  assert.match(result.html, /src="\/new.png"/);
  const envelope = receipt(result.html);
  assert.deepEqual(envelope.receipts[0].operations, ["attr:src"]);
  assert.equal(envelope.originals.e1.attributes.src, "/old.png");
  assert.equal(envelope.originals.e1.attributes.srcset, null);
});

test("the exact preview query parameter bypasses published changes and cookie observations", async () => {
  const html = '<!doctype html>\r\n<html><head></head><body><h1>café teams &amp; friends</h1></body></html>';
  for (const query of ["preview=1&biz=saas", "preview=&biz=saas", "preview&biz=saas"]) {
    const result = await run({ html, url: `https://rightmessage.com/?${query}`, headers: { "set-cookie": "origin=yes; Secure" } });
    assert.equal(result.html, html);
    assert.equal(result.hash, createHash("sha256").update(html).digest("hex"));
    assert.equal(result.headers.etag, '"original"');
    assert.equal(result.headers["cache-control"], "public, max-age=60");
    assert.deepEqual(result.setCookies, ["origin=yes; Secure"]);
    assertBypass(result, "preview");
  }
  const ordinary = await run({ url: "https://rightmessage.com/?notpreview=1&biz=saas" });
  assert.match(ordinary.html, /software teams/);
  assert.equal(ordinary.headers["x-rm-edge"], "applied");
});

test("the tag's draft-preview session cookie bypasses the published plan", async () => {
  const html = '<html><head></head><body><h1>café teams &amp; friends</h1></body></html>';
  for (const cookie of ["rm_preview=1", "a=b; rm_preview=1", "rm_preview=1; a=b"]) {
    const result = await run({ html, url: "https://rightmessage.com/?biz=saas", requestHeaders: { cookie } });
    assert.equal(result.html, html, cookie);
    assertBypass(result, "preview");
  }
  for (const cookie of ["rm_preview=0", "xrm_preview=1", "rm_preview=10"]) {
    const result = await run({ html, url: "https://rightmessage.com/?biz=saas", requestHeaders: { cookie } });
    assert.equal(result.headers["x-rm-edge"], "applied", cookie);
  }
});

test("a direct first request stays direct on pricing with a same-site Referer", async () => {
  const directPlan = plan([action("h1", { text: "direct visitor" })], { $source: "referrer", $type: "direct" });
  const first = await run({ plan: directPlan });
  assert.match(first.html, />direct visitor<\/h1>/);
  const requestHeaders = { cookie: first.headers["set-cookie"].split(";")[0], referer: "https://rightmessage.com/?biz=saas" };
  const second = await run({ plan: directPlan, url: "https://rightmessage.com/pricing", requestHeaders });
  assert.match(second.html, />direct visitor<\/h1>/);
  const referral = await run({ plan: plan([action("h1", { text: "referral visitor" })], { $source: "referrer", $type: "referral" }), url: "https://rightmessage.com/pricing", requestHeaders });
  assert.doesNotMatch(referral.html, /RM_EDGE|referral visitor/);
});

test("an unobserved referrer cannot select direct or negated referral winners", () => {
  const target = action("h1", { text: "direct visitor" });
  const request = new Request("https://rightmessage.com/pricing", { headers: { referer: "https://rightmessage.com/" } });
  for (const definition of [{ $source: "referrer", $type: "direct" }, { not: { $source: "referrer", $type: "referral" } }]) {
    assert.deepEqual(evaluatePlan(plan([target], definition), request, { v: 1, q: {} }), []);
    assert.deepEqual(evaluatePlan(plan([target], definition), request, { v: 1, q: {}, r: "" }), [target]);
  }
});

test("first-referrer domain rules match the host and its subdomains but not look-alikes", () => {
  const target = action("h1", { text: "referred" });
  const request = new Request("https://rightmessage.com/");
  const cases = [
    ["smartpassiveincome.com", "smartpassiveincome.com", true],
    ["www.smartpassiveincome.com", "smartpassiveincome.com", true],
    ["l.facebook.com", "facebook.com", true],
    ["m.facebook.com", "Facebook.com", true],
    ["notfacebook.com", "facebook.com", false],
    ["facebook.com.evil.net", "facebook.com", false],
    ["www.linkedin.com", "facebook.com, linkedin.com", true],
    ["twitter.com", "facebook.com,linkedin.com,", false],
    ["l.facebook.com", "*facebook.com", true],
    ["facebook.com", "*.facebook.com", false],
    ["www.facebook.com", "*.facebook.com", true],
    ["", "facebook.com", false],
    ["facebook.com", "", false],
  ];
  for (const [r, domain, expected] of cases) {
    const result = evaluatePlan(plan([target], { $source: "referrer", $type: "domain", domain }), request, { v: 1, q: {}, r });
    assert.deepEqual(result, expected ? [target] : [], `${JSON.stringify(r)} against ${JSON.stringify(domain)}`);
  }
});

test("negative touch-query rules distinguish absent observations from observed empty values", () => {
  const target = action("h1", { text: "matched observation" });
  const request = new Request("https://rightmessage.com/pricing");
  for (const occurrence of ["first touch", "last touch"]) {
    for (const operator of ["does not equal", "does not contain", "is not set"]) {
      const queryPlan = plan([target], { $source: "query", query: "biz", occurrence, operator, value: "saas" });
      assert.deepEqual(evaluatePlan(queryPlan, request, { v: 1, q: {} }), []);
      assert.deepEqual(evaluatePlan(queryPlan, request, { v: 1, q: { biz: ["", ""] } }), [target]);
    }
  }
});

test("a first request mints the holdout unit it assigns with; a returning browser's request does not", async () => {
  const experiment = (withhold) => {
    const value = plan([action("h1", { text: "Treatment" }, { edge: { supported: false, reason: "campaign-experiment", operations: ["text"], deferredOperations: [] } })]);
    value.campaigns[0].testing = { is_enabled: true, withhold };
    return value;
  };
  const unitOf = (result) => decodeURIComponent(result.setCookies.find(value => value.startsWith("__Host-rm_touch=")).split(";")[0].slice(16)).match(/"u":"([^"]+)"/)?.[1];
  for (const withhold of [30, 70]) {
    const result = await run({ html: "<html><head></head><body><h1>Default</h1></body></html>", plan: experiment(withhold) });
    const unit = unitOf(result);
    assert.match(unit, /^[A-Za-z0-9_-]{22}$/);
    const held = holdoutPoint(unit, "campaign") < withhold;
    assert.equal(result.headers["x-rm-edge"], held ? "bypass:cookie-only" : "applied");
    assert.equal(result.html.includes(">Treatment</h1>"), !held);
  }
  for (const cookie of [`_rm_ctx=${contextCookie({ vid: "v" })}`, "__Host-rm_touch=%7B%22v%22%3A1%2C%22q%22%3A%7B%7D%2C%22r%22%3A%22%22%7D"]) {
    const result = await run({ html: "<html><head></head><body><h1>Default</h1></body></html>", plan: experiment(1), requestHeaders: { cookie } });
    assert.equal(result.html.includes(">Treatment</h1>"), false);
    assert.equal(result.setCookies.some(value => value.includes("%22u%22")), false);
  }
});
