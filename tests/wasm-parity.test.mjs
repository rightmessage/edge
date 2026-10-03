import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { transformHTML } from "../src/transform.ts";
import { HTMLRewriter } from "../src/wasm.ts";

const revision = "a".repeat(64);
const release = { version: 1, teamPid: "demo-team", revision, planUrl: `https://tags.example/demo-team/revisions/${revision}/plan.json`, loaderUrl: `https://tags.example/demo-team.js?revision=${revision}` };
const action = (selector, modifications, id = "one") => ({ campaignId: "campaign", variantId: `variant-${id}`, actionId: id, selector, modifications, edge: { operations: Object.keys(modifications).flatMap(key => ["attr", "style"].includes(key) ? Object.keys(modifications[key]).map(name => `${key}:${name}`) : [key]) } });
const page = body => `<!doctype html><html><head><title>Unchanged &amp; exact</title></head><body>${body}</body></html>`;
const receipt = html => JSON.parse(html.match(/<script type="application\/json" id="RM_EDGE">([\s\S]*?)<\/script>/)[1]);
let native;
beforeAll(async () => {
  const bundled = await build({ stdin: { contents: `import { transformHTML } from './src/transform.ts';
export default { async fetch(request) {
 const { html, actions, release } = await request.json();
 try {
  const output = await transformHTML(new TextEncoder().encode(html), actions, release, HTMLRewriter);
  return Response.json({ output: output === null ? null : new TextDecoder().decode(output) });
 } catch (error) { return Response.json({ error: error.message }); }
}};`, resolveDir: fileURLToPath(new URL("..", import.meta.url)) }, bundle: true, write: false, format: "esm", platform: "browser" });
  native = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-08-31" }));
});
afterAll(async () => native?.dispose());

const fixtures = [
  {
    name: "nested replacement-major action ordering and entity baselines",
    html: page('<main><div class="copy">alpha &amp; <span class="copy">alpha</span></div></main>'),
    actions: [action(".copy", { findReplace: [{ find: "alpha", replace: "beta" }, { find: "beta", replace: "gamma" }, { find: "gamma", replace: "gamma!" }] }), action("span", { findReplace: [{ find: "gamma!!", replace: "delta" }] }, "two")],
    verify(html, envelope) {
      assert.match(html, />gamma! &amp; <span[^>]*>delta<\/span>/);
      assert.deepEqual(envelope.receipts.map(row => [row.actionId, row.targetId]), [["one", "e1"], ["one", "e2"], ["two", "e2"]]);
      assert.deepEqual(envelope.originals.e1.textNodes, [{ index: 0, text: "alpha & " }, { index: 1, text: "alpha" }]);
      assert.deepEqual(envelope.originals.e2.textNodes, [{ index: 0, text: "alpha" }]);
    },
  },
  {
    name: "Unicode replacements preserve untouched bytes and JSON escaping",
    html: page('<h1 title="café &amp; tea">雪 👩🏽‍💻 café &amp; tea</h1><p>untouched &copy;\r\n雪</p>'),
    actions: [action("h1", { findReplace: [{ find: "café", replace: "東京 <team>" }] })],
    verify(html, envelope) {
      assert.match(html, /雪 👩🏽‍💻 東京 &lt;team&gt; &amp; tea<\/h1>/);
      assert.ok(html.includes('<p>untouched &copy;\r\n雪</p>'));
      assert.equal(envelope.originals.e1.textNodes[0].text, "雪 👩🏽‍💻 café & tea");
    },
  },
  {
    name: "emptying text nodes captures original nested HTML",
    html: page('<section>erase<b title="a&amp;b">keep</b>erase</section>'),
    actions: [action("section", { findReplace: [{ find: "erase", replace: "" }] })],
    verify(html, envelope) {
      assert.match(html, /<section[^>]*><b title="a&amp;b">keep<\/b><\/section>/);
      assert.equal(envelope.originals.e1.html, 'erase<b title="a&amp;b">keep</b>erase');
      assert.deepEqual(envelope.originals.e1.textNodes, []);
    },
  },
  {
    name: "attributes, srcset removal, ordered style edits, visibility and classes",
    html: page('<img class="old keep" src="old.png" srcset="old@2x.png 2x" style="color: red; opacity: 1"><p style="margin: 1px;">keep</p>'),
    actions: [action("img", { attr: { src: "new.png?a=1&b=2", alt: 'A "quote" & snow 雪' }, style: { color: "blue" }, visibility: "hide", classes: { add: ["new"], remove: ["old"] } }), action("p", { style: { marginTop: "2px" } }, "unsupported")],
    verify(html, envelope) {
      assert.ok(html.includes('src="new.png?a=1&amp;b=2"'));
      assert.ok(html.includes('style="color: blue; opacity: 1; display: none; visibility: hidden;"'));
      assert.ok(html.includes('class="keep new"'));
      assert.ok(html.includes('<p style="margin: 1px;">keep</p>'));
      assert.equal(envelope.originals.e1.attributes.srcset, "old@2x.png 2x");
      assert.deepEqual(envelope.receipts[0].operations, ["attr:src", "attr:alt", "style:color", "visibility", "classes"]);
      assert.equal(envelope.receipts.length, 1);
    },
  },
  {
    name: "raw script/style text and content replacement regions",
    html: page('<script>const value = "old &amp; <literal>";</script><style>.old::after{content:"&amp;"}</style><h1>Original <em>children</em></h1>'),
    actions: [action("script,style", { findReplace: [{ find: "old", replace: "fresh" }] }), action("h1", { text: '<strong>New 雪 &amp; content</strong>' }, "two"), action("h1 em", { text: "must not run" }, "three")],
    verify(html, envelope) {
      assert.ok(html.includes('const value = "fresh &amp; <literal>";'));
      assert.ok(html.includes('.fresh::after{content:"&amp;"}'));
      assert.match(html, /<h1[^>]*><strong>New 雪 &amp; content<\/strong><\/h1>/);
      assert.equal(envelope.originals.e3.html, "Original <em>children</em>");
      assert.deepEqual(envelope.receipts.map(row => row.actionId), ["one", "one", "two"]);
      assert.ok(html.includes('\\u003cem>children\\u003c/em>'));
    },
  },
  {
    name: "selectors depending on earlier writes stay browser-owned",
    html: page('<p class="before">old</p>'),
    actions: [action("p", { classes: { add: ["after"] } }), action(".after", { text: "must not run" }, "two")],
    verify(html, envelope) {
      assert.match(html, /class="before after"[^>]*>old<\/p>/);
      assert.equal(envelope.receipts.length, 1);
    },
  },
];

for (const fixture of fixtures) test(`native/WASM byte parity: ${fixture.name}`, async () => {
  const expected = await (await native.dispatchFetch("https://test.example/", { method: "POST", body: JSON.stringify({ ...fixture, release }) })).json();
  assert.equal(expected.error, undefined);
  const actual = await transformHTML(new TextEncoder().encode(fixture.html), fixture.actions, release, HTMLRewriter);
  assert.notEqual(actual, null);
  assert.deepEqual(Buffer.from(actual), Buffer.from(expected.output));
  const html = new TextDecoder().decode(actual);
  fixture.verify(html, receipt(html));
});

for (const fixture of [
  { name: "unchanged operations", html: page("<p>same</p>"), actions: [action("p", { findReplace: [{ find: "missing", replace: "different" }] })], output: null },
  { name: "unsafe raw closing tag", html: page("<script>old</script>"), actions: [action("script", { findReplace: [{ find: "old", replace: "</script>" }] })], error: "Raw text cannot be safely serialized" },
  { name: "missing head", html: "<h1>old</h1>", actions: [action("h1", { text: "new" })], error: "Missing bootstrap insertion point" },
]) test(`native/WASM failure parity: ${fixture.name}`, async () => {
  const expected = await (await native.dispatchFetch("https://test.example/", { method: "POST", body: JSON.stringify({ ...fixture, release }) })).json();
  if (fixture.error) {
    assert.equal(expected.error, fixture.error);
    await assert.rejects(transformHTML(new TextEncoder().encode(fixture.html), fixture.actions, release, HTMLRewriter), { message: fixture.error });
  } else {
    assert.equal(expected.output, null);
    assert.equal(await transformHTML(new TextEncoder().encode(fixture.html), fixture.actions, release, HTMLRewriter), null);
  }
});

test("WASM streams split UTF-8, async handlers, and preserves response metadata", async () => {
  const bytes = new TextEncoder().encode('<p>雪 👩🏽‍💻 &amp; café</p>');
  const input = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const rewriter = new HTMLRewriter().on("p", { async element(element) { await Promise.resolve(); element.setAttribute("title", "changed"); } });
  const output = rewriter.transform(new Response(input, { status: 201, headers: { "x-source": "kept" } }));
  assert.equal(await output.text(), '<p title="changed">雪 👩🏽‍💻 &amp; café</p>');
  assert.equal(output.status, 201);
  assert.equal(output.headers.get("x-source"), "kept");
});
