import assert from "node:assert/strict";
import { test } from "vitest";
import { decodeTouchCookie, observeTouchCookie, TOUCH_COOKIE_NAME } from "../src/touch-cookie.ts";

const header = (state) => `${TOUCH_COOKIE_NAME}=${encodeURIComponent(JSON.stringify(state))}`;
const bytes = (cookie) => new TextEncoder().encode(cookie.split(";")[0]).length;

test("edge and browser use the same versioned host-only touch-cookie wire contract", () => {
  const result = observeTouchCookie("", ["biz"], "https://example.com/?biz=saas", "https://www.search.example/path?q=private");
  assert.deepEqual(result.state, { v: 1, q: { biz: ["saas", "saas"] }, r: "www.search.example" });
  assert.equal(result.value, "%7B%22v%22%3A1%2C%22q%22%3A%7B%22biz%22%3A%5B%22saas%22%2C%22saas%22%5D%7D%2C%22r%22%3A%22www.search.example%22%7D");
  assert.equal(result.cookie, `${TOUCH_COOKIE_NAME}=${result.value}; Secure; Path=/; SameSite=Lax`);
  assert.deepEqual(decodeTouchCookie(`other=1; ${result.cookie}`, ["biz"]), result.state);
  const second = observeTouchCookie(result.cookie, ["biz"], "https://example.com/pricing?biz=services", "https://second.example/");
  assert.deepEqual(second.state, { v: 1, q: { biz: ["saas", "services"] }, r: "www.search.example" });
  assert.equal(observeTouchCookie(second.cookie, ["biz"], "https://example.com/pricing", "").changed, false);
});

test("encoded name and value retain 1024 bytes and evict whole fields at 1025", () => {
  const original = header({ v: 1, q: { biz: ["first", "old"] } });
  const empty = observeTouchCookie(original, ["biz"], "https://example.com/?biz=", "");
  const length = 1024 - bytes(empty.cookie);
  const fit = observeTouchCookie(original, ["biz"], `https://example.com/?biz=${"a".repeat(length)}`, "");
  assert.equal(bytes(fit.cookie), 1024);
  assert.deepEqual(decodeTouchCookie(fit.cookie, ["biz"]).q.biz, ["first", "a".repeat(length)]);
  const over = observeTouchCookie(original, ["biz"], `https://example.com/?biz=${"a".repeat(length + 1)}`, "");
  assert.deepEqual(over.state, { v: 1, q: {}, r: "" });
  assert.ok(bytes(over.cookie) <= 1024);
});

test("live dependencies, Unicode eviction, and excluded hard context are deterministic", () => {
  const url = `https://example.com/?a=keep&z=${encodeURIComponent("🙂".repeat(200))}&_rm_ctx=private`;
  const first = observeTouchCookie("", ["z", "_rm_ctx", "a"], url, "https://first.example/");
  const second = observeTouchCookie("", ["a", "z", "a"], url, "https://first.example/");
  assert.equal(first.value, second.value);
  assert.deepEqual(first.state, { v: 1, q: { a: ["keep", "keep"] }, r: "first.example" });
  const retired = observeTouchCookie(first.cookie, [], "https://example.com/", "");
  assert.deepEqual(retired.state, { v: 1, q: {}, r: "first.example" });
  assert.equal(retired.changed, true);
});

test("invalid state is discarded", () => {
  for (const cookie of ["__Host-rm_touch=%", header({ v: 2, q: { biz: ["x", "y"] } }), header({ v: 1, q: { biz: "wrong" }, r: "/not-a-host" })]) {
    assert.deepEqual(decodeTouchCookie(cookie, ["biz"]), { v: 1, q: {} });
  }
});

test("repeated query parameters match browser last-value semantics", () => {
  const result = observeTouchCookie("", ["biz"], "https://example.com/?biz=saas&biz=services", "");
  assert.deepEqual(result.state.q.biz, ["services", "services"]);
});

test("direct first touch remains explicit after same-site and external navigation", () => {
  const direct = observeTouchCookie("", ["biz"], "https://example.com/", "");
  assert.equal(direct.changed, true);
  assert.deepEqual(direct.state, { v: 1, q: {}, r: "" });
  assert.equal(direct.value, "%7B%22v%22%3A1%2C%22q%22%3A%7B%7D%2C%22r%22%3A%22%22%7D");
  assert.deepEqual(decodeTouchCookie(direct.cookie, ["biz"]), direct.state);
  for (const referrer of ["https://example.com/", "https://search.example/"]) {
    const next = observeTouchCookie(direct.cookie, ["biz"], "https://example.com/pricing", referrer);
    assert.equal(next.state.r, "");
    assert.equal(next.changed, false);
  }
});

test("a same-site navigation without an existing cookie records a direct first touch", () => {
  const result = observeTouchCookie("", [], "https://example.com/pricing", "https://example.com/");
  assert.deepEqual(result.state, { v: 1, q: {}, r: "" });
});

test("stored pageview history seeds first-touch values before current observations", () => {
  const result = observeTouchCookie(
    "",
    ["biz"],
    "https://example.com/pricing?biz=services",
    "https://example.com/",
    { query: { biz: "saas" }, referrer: "https://search.example/landing" },
  );
  assert.deepEqual(result.state, { v: 1, q: { biz: ["saas", "services"] }, r: "search.example" });
});

test("stored history seeds first and last touch from every retained pageview", () => {
  const result = observeTouchCookie(
    "",
    ["biz"],
    "https://example.com/about",
    "https://example.com/",
    { query: {}, referrer: "https://search.example/landing" },
    [{ query: { biz: "saas" } }, { query: {} }, { query: { biz: "creator" } }],
  );
  assert.deepEqual(result.state, { v: 1, q: { biz: ["saas", "creator"] }, r: "search.example" });
});

test("legacy retained values decode once and marked pageviews are not double-decoded", () => {
  const seed = pages => observeTouchCookie("", ["plan"], "https://example.com/", "", { query: {} }, pages).state.q.plan;
  assert.deepEqual(seed([{ query: { plan: "Quiz%20Results" } }]), ["Quiz Results", "Quiz Results"]);
  assert.deepEqual(seed([{ query: { plan: "Quiz+Results" } }]), ["Quiz Results", "Quiz Results"]);
  assert.deepEqual(seed([{ _queryValuesDecoded: true, query: { plan: "100%" } }]), ["100%", "100%"]);
});
