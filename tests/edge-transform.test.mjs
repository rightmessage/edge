import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { personalizeResponse } from "../src/personalize.ts";
import { transformHTML } from "../src/transform.ts";
import { HTMLRewriter } from "../src/wasm.ts";

// Source: design test plan "Probe" (edge-tests.md, P1 to P8); no app fixture rows. Every case runs on
// native HTMLRewriter (Miniflare) and the WASM adapter and must produce identical bytes.
const revision = "b".repeat(64);
const release = { version: 1, teamPid: "demo-team", revision, planUrl: `https://tags.example/demo-team/revisions/${revision}/plan.json`, loaderUrl: `https://tags.example/demo-team.js?revision=${revision}` };
const page = body => `<html><head></head><body>${body}</body></html>`;
const operationsOf = modifications => Object.keys(modifications).flatMap(key => ["attr", "style"].includes(key) ? Object.keys(modifications[key]).map(name => `${key}:${name}`) : [key]);
const action = (id, selector, modifications, deferredOperations = []) => ({ $type: "MODIFY_ELEMENT", id, actionId: id, campaignId: "cpn_probe", variantId: `var_${id}`, page: [{ domain: "*", path: "*" }], selector, modifications, edge: { supported: true, reason: null, operations: operationsOf(modifications), deferredOperations } });
const apply = (...args) => ({ kind: "apply", action: action(...args) });
const claim = (selector, slots) => ({ kind: "claim", selector, slots });
const envelope = html => JSON.parse(html.match(/<script type="application\/json" id="RM_EDGE">([\s\S]*?)<\/script>/)[1]);
const receipts = html => envelope(html).receipts.map(({ actionId, targetId, operations }) => ({ actionId, targetId, operations }));

let native;
beforeAll(async () => {
  const bundled = await build({ stdin: { contents: `import { transformHTML } from './src/transform.ts';
import { personalizeResponse } from './src/personalize.ts';
export default { async fetch(request) {
 const { html, steps, plan, url, release } = await request.json();
 try {
  if (plan) {
   const response = await personalizeResponse(new Request(url), new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }), { promise: Promise.resolve({ loaded: { plan, release } }), abort() {} }, { HTMLRewriter, log() {} });
   return Response.json({ output: await response.text(), edge: response.headers.get('x-rm-edge') });
  }
  const output = await transformHTML(new TextEncoder().encode(html), steps, release, HTMLRewriter);
  return Response.json({ output: output === null ? null : new TextDecoder().decode(output) });
 } catch (error) { return Response.json({ error: error.message }); }
}};`, resolveDir: fileURLToPath(new URL("..", import.meta.url)) }, bundle: true, write: false, format: "esm", platform: "browser" });
  native = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-08-31" }));
});
afterAll(async () => native?.dispose());

/** Transforms on both runtimes, asserts byte parity, and returns the output HTML or null. */
const transformBoth = async (html, steps) => {
  const expected = await (await native.dispatchFetch("https://test.example/", { method: "POST", body: JSON.stringify({ html, steps, release }) })).json();
  assert.equal(expected.error, undefined);
  const actual = await transformHTML(new TextEncoder().encode(html), steps, release, HTMLRewriter);
  assert.equal(actual === null ? null : new TextDecoder().decode(actual), expected.output);
  return expected.output;
};

test("P1: a claim on the same element and slot vetoes a lower apply", async () => {
  assert.equal(await transformBoth(page("<h1>Hi</h1>"), [apply("a1", "h1", { text: "X" }), claim("h1", ["children"])]), null);
});

test("P2: a claim on an ancestor's children vetoes a lower apply inside it", async () => {
  assert.equal(await transformBoth(page('<div class="hero"><h1>Hi</h1></div>'), [apply("a1", ".hero h1", { text: "X" }), claim(".hero", ["children"])]), null);
});

test("P3: a claimed descendant vetoes a lower children write on its ancestor", async () => {
  assert.equal(await transformBoth(page('<div class="hero"><span class="badge">1</span></div>'), [apply("a1", ".hero", { text: "<p>New</p>" }), claim(".badge", ["class"])]), null);
});

test("P4: a claimed descendant does not veto an attribute write on its ancestor", async () => {
  const html = await transformBoth(page('<div class="hero"><span class="badge">1</span></div>'), [apply("a1", ".hero", { attr: { "data-x": "1" } }), claim(".badge", ["class"])]);
  assert.deepEqual(receipts(html), [{ actionId: "a1", targetId: "e1", operations: ["attr:data-x"] }]);
});

test("P5: claims never veto higher ranks", async () => {
  const html = await transformBoth(page("<h1>Hi</h1>"), [claim("h1", ["children"]), apply("a1", "h1", { text: "X" })]);
  assert.match(html, /<h1[^>]*>X<\/h1>/);
  assert.deepEqual(receipts(html), [{ actionId: "a1", targetId: "e1", operations: ["text"] }]);
});

test("P6: text and find/replace on one target are both left to the browser", async () => {
  const body = page("<h1>Hi there</h1><p>Keep</p>");
  const steps = [apply("a1", "h1", { text: "X" }), apply("a2", "h1", { findReplace: [{ find: "there", replace: "you" }] }), apply("a3", "p", { attr: { "data-y": "1" } })];
  const html = await transformBoth(body, steps);
  assert.match(html, /<h1>Hi there<\/h1>/);
  assert.deepEqual(receipts(html), [{ actionId: "a3", targetId: "e1", operations: ["attr:data-y"] }]);
  const plan = { version: 1, teamPid: "demo-team", queryNames: [], dimensions: [], campaigns: [{ id: "cpn_probe", is_active: true, variants: [{ id: "var_probe", rules: { all: [] }, actions: steps.map(step => step.action) }] }] };
  const url = "https://example.com/";
  const loaded = { promise: Promise.resolve({ loaded: { plan, release } }), abort() {} };
  const wasm = await personalizeResponse(new Request(url), new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }), loaded, { HTMLRewriter, log() {} });
  const nativeResult = await (await native.dispatchFetch("https://test.example/", { method: "POST", body: JSON.stringify({ html: body, plan, url, release }) })).json();
  assert.equal(wasm.headers.get("x-rm-edge"), "applied");
  assert.equal(nativeResult.edge, "applied");
  assert.equal(await wasm.text(), nativeResult.output);
});

test("P7: a cut vetoes every lower apply without a DOM", async () => {
  const html = await transformBoth(page("<h1>A</h1><p>B</p>"), [apply("a1", "h1", { text: "X" }), apply("a2", "p", { text: "Y" }), { kind: "cut" }, apply("a3", "p", { attr: { "data-z": "1" } })]);
  assert.match(html, /<h1>A<\/h1>/);
  assert.deepEqual(receipts(html), [{ actionId: "a3", targetId: "e1", operations: ["attr:data-z"] }]);
});

test("P8: disjoint slot families on one element do not veto", async () => {
  const html = await transformBoth(page('<a class="cta" href="/t">Go</a>'), [apply("a1", "a.cta", { text: "X" }), claim("a.cta", ["attr:href"])]);
  assert.deepEqual(receipts(html), [{ actionId: "a1", targetId: "e1", operations: ["text"] }]);
});

test("an apply's deferred operations hold their slots against lower applies only", async () => {
  const html = await transformBoth(page('<h1 style="color: red">Hi</h1>'), [apply("a1", "h1", { style: { color: "blue" } }), apply("a2", "h1", { text: "X" }, ["visibility"])]);
  assert.match(html, /style="color: red"/);
  assert.deepEqual(receipts(html), [{ actionId: "a2", targetId: "e1", operations: ["text"] }]);
});

test("an apply whose selector reads an attribute a claim writes stays with the browser", async () => {
  assert.equal(await transformBoth(page('<h1 class="x">Hi</h1>'), [claim("h1", ["class"]), apply("a1", ".x", { text: "X" })]), null);
  assert.equal(await transformBoth(page('<h1 class="x">Hi</h1>'), [{ kind: "cut" }, apply("a1", ".x", { text: "X" })]), null);
  const html = await transformBoth(page('<h1 class="x">Hi</h1>'), [claim("h1", ["children"]), apply("a1", ".x", { attr: { title: "t" } })]);
  assert.deepEqual(receipts(html), [{ actionId: "a1", targetId: "e1", operations: ["attr:title"] }]);
});

test("target ids follow document order over the pairs that apply", async () => {
  const html = await transformBoth(page("<h1>A</h1><p>B</p><span>C</span>"), [apply("a1", "h1", { text: "X" }), apply("a2", "span", { text: "Z" }), claim("h1", ["element"]), apply("a3", "p", { text: "Y" })]);
  assert.match(html, /<h1>A<\/h1>/);
  assert.deepEqual(receipts(html), [{ actionId: "a2", targetId: "e2", operations: ["text"] }, { actionId: "a3", targetId: "e1", operations: ["text"] }]);
});
