import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "vitest";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { campaignHoldback, requestAssignment } from "../src/assignment.ts";
import { decodeContextCookie } from "../src/context.ts";
import { decide, evaluatePlan } from "../src/edge-plan.ts";
import { personalizeResponse } from "../src/personalize.ts";
import { admitRequest } from "../src/request.ts";
import { TOUCH_COOKIE_NAME } from "../src/touch-cookie.ts";
import { HTMLRewriter } from "../src/wasm.ts";

// Source fixture: RightMessage app tests/Fixtures/edge-tests.json#hosted (copied byte for byte). The app compiles
// `config` into exactly `plan`, and `html` is its hosted-page renderer's Live document for team 4242.
const { hosted } = JSON.parse(readFileSync(new URL("./fixtures/edge-tests.json", import.meta.url), "utf8"));
const revision = "c".repeat(64);
const release = { version: 1, teamPid: "4242", revision, planUrl: `https://t.rightmessage.com/4242/revisions/${revision}/plan.json`, loaderUrl: `https://t.rightmessage.com/4242.js?revision=${revision}` };
const requestOf = entry => new Request(entry.url, { headers: { cookie: entry.cookie } });
const setCookieOf = value => `${TOUCH_COOKIE_NAME}=${value}; Secure; Path=/; SameSite=Lax`;
const wireStep = step => step.kind === "apply" ? { kind: "apply", actionId: step.action.actionId, ...(step.versions ? { versions: step.versions } : {}) } : step;
const wireDecision = ({ campaignId, variantId, layer, versionId, actions }) => ({ campaignId, variantId, layer, ...(versionId ? { versionId } : {}), actionIds: actions.map(action => action.actionId) });
const variantOf = new Map(hosted.plan.campaigns.flatMap(campaign => campaign.variants.flatMap(variant => variant.actions)).map(action => [action.actionId, action.variantId]));
const BOOTSTRAP = `<script>(function(d){window.RM=window.RM||[];var s=d.createElement('script'),m=d.querySelector('meta[name="rm-edge-loader"]');s.async=true;s.src=m?m.content:"https://t.rightmessage.com/4242.js";d.head.appendChild(s)})(document)</script>`;

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
  const origin = new Response(hosted.html, { headers: { "content-type": "text/html; charset=utf-8" } });
  const response = await personalizeResponse(requestOf(entry), origin, { promise: Promise.resolve({ loaded: { plan: hosted.plan, release } }), abort() {} }, { HTMLRewriter, log() {} });
  return { html: await response.text(), headers: Object.fromEntries(response.headers), setCookies: response.headers.getSetCookie() };
};
const assertMinted = (setCookies, entry) => {
  assert.equal(setCookies.length, 1);
  const match = setCookies[0].match(new RegExp(`^${TOUCH_COOKIE_NAME}=([^;]+); Secure; Path=/; SameSite=Lax$`));
  const { u, ...touch } = JSON.parse(decodeURIComponent(match[1]));
  assert.match(u, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(touch, entry.mintedTouch);
};

test("the fixture carries every hosted-page case", () => {
  assert.deepEqual(hosted.cases.map(entry => entry.name), ["H1", "H2", "H3", "H4", "H5", "H6"]);
  assert.equal(hosted.plan.teamPid, "4242");
  assert.equal(hosted.html.split("\n").filter(line => line === BOOTSTRAP).length, 1);
});

for (const entry of hosted.cases) {
  // Source fixture: edge-tests.json#hosted.cases (arms, steps, decisions, setCookie)
  test(`${entry.name}: admission, arm, walk and decisions`, () => {
    const request = requestOf(entry);
    const admission = admitRequest(hosted.plan, request);
    if (entry.mintsUnit) assertMinted([admission.cookie], entry);
    else assert.equal(admission.cookie, entry.setCookie === null ? null : setCookieOf(entry.setCookie));
    if (entry.arms) {
      const assignment = requestAssignment("normal", decodeContextCookie(entry.cookie), admission.touch.u);
      assert.deepEqual(Object.fromEntries(hosted.plan.campaigns.map(campaign => [campaign.id, campaignHoldback(campaign, assignment) ? "holdback" : "treatment"])), entry.arms);
    }
    assert.deepEqual(evaluatePlan(hosted.plan, request, admission.touch).map(wireStep), entry.steps);
    assert.deepEqual(decide(hosted.plan, request, admission.touch).map(wireDecision), entry.decisions);
  });

  // Source fixture: edge-tests.json#hosted.cases (edge, setCookie, receipts, text, bodyUnchanged)
  test(`${entry.name}: hosted document personalizes alike on native and WASM`, async () => {
    const wasm = await personalizeWASM(entry);
    const nativeResult = await (await native.dispatchFetch("https://test.example/", { method: "POST", body: JSON.stringify({ plan: hosted.plan, url: entry.url, cookie: entry.cookie, html: hosted.html, release }) })).json();
    assert.equal(wasm.headers["x-rm-edge"], entry.edge);
    assert.equal(nativeResult.headers["x-rm-edge"], entry.edge);
    if (entry.mintsUnit) {
      // Each side mints its own unit; everything else is identical.
      assertMinted(wasm.setCookies, entry);
      assertMinted(nativeResult.setCookies, entry);
    } else {
      assert.deepEqual(wasm.setCookies, nativeResult.setCookies);
      assert.deepEqual(wasm.setCookies, entry.setCookie === null ? [] : [setCookieOf(entry.setCookie)]);
    }
    assert.equal(wasm.html, nativeResult.html);
    const document = new JSDOM(wasm.html).window.document;
    const envelope = document.querySelector('script#RM_EDGE[type="application/json"]');
    assert.deepEqual(envelope ? JSON.parse(envelope.textContent).receipts.map(({ actionId, targetId, versions }) => ({ actionId, targetId, ...(versions ? { versions } : {}) })) : [], entry.receipts);
    for (const [selector, text] of Object.entries(entry.text)) assert.equal(document.querySelector(selector).textContent, text, selector);
    if (entry.bodyUnchanged) {
      assert.equal(wasm.html, hosted.html);
      assert.equal(document.querySelector('meta[name="rm-edge-loader"]'), null);
      return;
    }
    // The bootstrap loads the release's loader: its meta leads <head>, ahead of the bootstrap script.
    const head = [...document.head.children];
    const loader = head.findIndex(element => element.matches('meta[name="rm-edge-loader"]'));
    const bootstrap = head.findIndex(element => element.outerHTML === BOOTSTRAP);
    assert.equal(loader, 0);
    assert.equal(head[loader].getAttribute("content"), release.loaderUrl);
    assert.equal(head.indexOf(envelope), 1);
    assert.ok(bootstrap > loader, "bootstrap follows the loader meta");
    // Apart from the prepended loader meta and envelope, the renderer's head is untouched.
    const headOf = html => html.slice(0, html.indexOf("</head>"));
    assert.equal(headOf(wasm.html).replace(/^(<!doctype html>\n<html lang="en">\n<head>)<meta name="rm-edge-loader"[^>]*><script type="application\/json" id="RM_EDGE">[\s\S]*?<\/script>/, "$1"), headOf(hosted.html));
    const last = new Map(entry.receipts.map(({ actionId, targetId }) => [targetId, actionId]));
    for (const [targetId, actionId] of last) assert.equal(document.querySelector(`[data-rm-edge-target="${targetId}"]`).getAttribute("data-rm-variant"), variantOf.get(actionId), targetId);
  });
}
