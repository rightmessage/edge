import assert from "node:assert/strict";
import { test } from "vitest";
import { JSDOM } from "jsdom";
import { createElement, act } from "react";
import { hydrateRoot } from "react-dom/client";
import { rightMessageTrackingScript } from "./fixtures/rightmessage-bootstrap.js";

const revision = "a".repeat(64);
test("bootstrap pins metadata loader, keeps edge target/group ready and fallback cloaked", () => {
  const dom = new JSDOM(`<html class="rm-loading"><head><meta name="rm-edge-loader" content="https://t.rightmessage.com/demo-team.js?revision=${revision}"><script type="application/json" id="RM_EDGE">${JSON.stringify({ version: 1, revision, receipts: [{ campaignId: "c", variantId: "v", actionId: "a", targetId: "e1", operations: ["findReplace"] }], originals: { e1: { attributes: {}, textNodes: [{ index: 0, text: "teams" }] } } })}</script></head><body><section id="group" class="rmcloak"><h1 class="rmcloak" data-rm-edge-target="e1" data-rm-personalized="true">software teams</h1></section><p id="fallback" class="rmcloak">default</p></body></html>`, { url: "https://rightmessage.com/", runScripts: "outside-only" });
  try {
    dom.window.eval(rightMessageTrackingScript);
    const script = dom.window.document.querySelector('script[src]');
    assert.equal(script.src, `https://t.rightmessage.com/demo-team.js?revision=${revision}`);
    const stylesheet = dom.window.document.getElementById("rmcloak").sheet;
    const hiddenSelector = stylesheet.cssRules[0].selectorText;
    assert.equal(dom.window.document.querySelector("h1").matches(hiddenSelector), false);
    assert.equal(dom.window.document.getElementById("group").matches(hiddenSelector), false);
    assert.equal(dom.window.document.getElementById("fallback").matches(hiddenSelector), true);
    script.dispatchEvent(new dom.window.Event("error"));
    assert.equal(dom.window.document.documentElement.classList.contains("rm-loading"), false);
    assert.equal(dom.window.document.getElementById("rmcloak"), null);
  } finally { dom.window.close(); }
});

test("hydration keeps server-adopted non-idempotent text and exact node without a second write", async () => {
  const dom = new JSDOM('<html><head></head><body><div id="root"><h1 data-rm-edge-target="e1" data-rm-personalized="true" data-rm-variant="v">software teams</h1></div></body></html>', { url: "https://rightmessage.com/" });
  const saved = Object.fromEntries(["window", "document", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let root;
  try {
    Object.defineProperties(globalThis, { window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document }, MutationObserver: { configurable: true, value: dom.window.MutationObserver }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true } });
    const container = dom.window.document.getElementById("root");
    const target = container.firstChild;
    const mutations = [];
    const observer = new dom.window.MutationObserver(records => mutations.push(...records));
    observer.observe(container, { subtree: true, characterData: true, childList: true, attributes: true });
    const errors = [];
    await act(async () => { root = hydrateRoot(container, createElement("h1", { suppressHydrationWarning: true }, "teams"), { onRecoverableError: error => errors.push(error) }); });
    assert.equal(container.firstChild, target);
    assert.equal(target.textContent, "software teams");
    assert.equal(target.getAttribute("data-rm-personalized"), "true");
    assert.deepEqual(errors, []);
    assert.deepEqual(mutations, []);
    observer.disconnect();
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
