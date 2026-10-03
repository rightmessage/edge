// Portable transform benchmark: no production snapshots, network calls, or git history.
// npm run build && npm run bench:edge-transform -- --runtime both --iterations 10
// Optional --fixture file.json: { html, actions, release } with public transform inputs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { transformHTML } from "../dist/transform.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const runtime = option("--runtime", "both");
const iterations = Number(option("--iterations", "10"));
const blocks = Number(option("--blocks", "40"));
const fixturePath = option("--fixture", null);
if (!["both", "native", "wasm"].includes(runtime)) throw new Error("--runtime must be both, native, or wasm");
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("--iterations must be a positive integer");
if (!Number.isSafeInteger(blocks) || blocks < 1) throw new Error("--blocks must be a positive integer");
const revision = "a".repeat(64);
const release = { version: 1, teamPid: "demo-team", revision, planUrl: `https://tags.example/demo-team/revisions/${revision}/plan.json`, loaderUrl: `https://tags.example/demo-team.js?revision=${revision}` };
const action = (selector, modifications, operations) => ({ campaignId: "campaign", variantId: "variant", actionId: "action", selector, modifications, edge: { operations } });
const html = `<!doctype html><html><head><title>Public benchmark</title></head><body>${'<section><h2 class="copy">Hello teams &amp; creators 雪</h2><p>Unchanged supporting content.</p></section>'.repeat(blocks)}</body></html>`;
const fixtures = fixturePath ? [{ name: "custom", ...JSON.parse(readFileSync(fixturePath, "utf8")) }] : [
  { name: "find-replace", html, release, actions: [action(".copy", { findReplace: [{ find: "teams", replace: "software teams" }] }, ["findReplace"])] },
  { name: "text-regions", html, release, actions: [action(".copy", { text: "Welcome <em>software teams</em> 雪" }, ["text"])] },
  { name: "removed-text", html, release, actions: [action(".copy", { findReplace: [{ find: "/.*/s", replace: "" }] }, ["findReplace"])] },
  { name: "unmatched", html, release, actions: [action(".missing", { text: "Never inserted" }, ["text"])] },
];
let native;
const rows = [];
try {
  if (runtime !== "wasm") {
    const bundle = await build({ stdin: { contents: `import { transformHTML } from './dist/transform.js';
export default { async fetch(request) {
 const { fixture, iterations } = await request.json();
 let passes = 0;
 class CountingRewriter extends HTMLRewriter {
  transform(response) { passes++; return super.transform(response); }
 }
 const bytes = new TextEncoder().encode(fixture.html);
 const times = []; let output;
 for (let i = 0; i <= iterations; i++) {
  passes = 0;
  const start = performance.now();
  output = await transformHTML(bytes, fixture.actions, fixture.release, CountingRewriter);
  if (i > 0) times.push(performance.now() - start);
 }
 return Response.json({ times, passes, output: output === null ? null : new TextDecoder().decode(output) });
}};`, resolveDir: fileURLToPath(new URL("..", import.meta.url)) }, bundle: true, write: false, format: "esm", platform: "browser" });
    native = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-08-31" }));
  }
  for (const fixture of fixtures) {
    const results = {};
    if (native) results.native = await (await native.dispatchFetch("https://bench.example/", { method: "POST", body: JSON.stringify({ fixture, iterations }) })).json();
    if (runtime !== "native") {
      const { HTMLRewriter } = await import("../dist/wasm.js");
      let passes = 0;
      class CountingRewriter extends HTMLRewriter {
        transform(response) { passes++; return super.transform(response); }
      }
      const bytes = new TextEncoder().encode(fixture.html);
      const times = [];
      let output;
      for (let i = 0; i <= iterations; i++) {
        passes = 0;
        const start = performance.now();
        output = await transformHTML(bytes, fixture.actions, fixture.release, CountingRewriter);
        if (i > 0) times.push(performance.now() - start);
      }
      results.wasm = { times, passes, output: output === null ? null : new TextDecoder().decode(output) };
    }
    if (results.native && results.wasm) assert.equal(results.wasm.output, results.native.output, `${fixture.name}: runtime output differs`);
    for (const [engine, result] of Object.entries(results)) {
      const sorted = [...result.times].sort((a, b) => a - b);
      rows.push({ fixture: fixture.name, runtime: engine, "input bytes": Buffer.byteLength(fixture.html), "output bytes": result.output === null ? 0 : Buffer.byteLength(result.output), "median ms": Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)), "max ms": Number(Math.max(...result.times).toFixed(3)), passes: result.passes, result: result.output === null ? "unchanged" : "applied" });
    }
  }
} finally {
  await native?.dispose();
}
console.table(rows);
if (runtime === "both") console.log("Native and WASM output bytes match for every fixture.");
console.log("One warmup per fixture/runtime excluded; native workerd timers may have coarse resolution. This measures buffered transform time, not plan fetch or network latency.");
