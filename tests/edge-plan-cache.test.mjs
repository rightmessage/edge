import assert from "node:assert/strict";
import { test } from "vitest";
import { createPlanCache, NEGATIVE_TTL_MS, RELEASE_FRESH_MS, startPlanLoad } from "../src/index.ts";

const PID = "demo-team";
const rev = (c) => c.repeat(64);

function router() {
  const state = { revision: rev("a"), calls: [], failRelease: false, failPlan: false, stall: null };
  const release = (r) => ({ version: 1, teamPid: PID, revision: r, planUrl: `https://t.rightmessage.com/${PID}/revisions/${r}/plan.json`, loaderUrl: `https://t.rightmessage.com/${PID}.js?revision=${r}` });
  state.fetch = async (request) => {
    const path = new URL(request.url).pathname;
    state.calls.push(path);
    if (state.stall) await state.stall;
    if (path.endsWith("/release.json")) {
      if (state.failRelease) return new Response("", { status: 503 });
      return Response.json(release(state.revision));
    }
    if (state.failPlan) return new Response("", { status: 503 });
    const planRevision = path.split("/")[3];
    return Response.json({ version: 1, teamPid: PID, queryNames: [planRevision.slice(0, 1)], dimensions: [], campaigns: [] });
  };
  return state;
}

function setup() {
  const clock = { t: 1_000_000 };
  const tag = router();
  const options = { tagOrigin: "https://t.rightmessage.com", teamPid: PID };
  const cache = createPlanCache({ now: () => clock.t });
  const background = [];
  const ctx = { waitUntil: (p) => background.push(p) };
  const load = () => startPlanLoad(new Request("https://rightmessage.com/?biz=saas"), options, { planCache: cache, fetch: (request) => tag.fetch(request) }, ctx).promise;
  return { clock, tag, cache, background, load, settle: () => Promise.all(background.splice(0)) };
}

test("cold path loads release then plan within the request deadline", async () => {
  const s = setup();
  const outcome = await s.load();
  assert.equal(outcome.loaded.release.revision, rev("a"));
  assert.deepEqual(s.tag.calls, [`/${PID}/release.json`, `/${PID}/revisions/${rev("a")}/plan.json`]);
});

test("a cold stall still fails open at the request deadline", async () => {
  const s = setup();
  let release;
  s.tag.stall = new Promise((resolve) => { release = resolve; });
  const started = Date.now();
  const outcome = await startPlanLoad(new Request("https://rightmessage.com/"), { tagOrigin: "https://t.rightmessage.com", teamPid: PID }, { planCache: s.cache, planTimeoutMs: 50, fetch: (request) => s.tag.fetch(request) }).promise;
  assert.equal(outcome.reason, "plan-timeout");
  assert.ok(Date.now() - started < 300);
  release();
});

test("concurrent cold requests share one in-flight load", async () => {
  const s = setup();
  const outcomes = await Promise.all([s.load(), s.load(), s.load()]);
  assert.ok(outcomes.every((o) => o.loaded.release.revision === rev("a")));
  assert.equal(s.tag.calls.length, 2);
});

test("a warm hit makes no binding call", async () => {
  const s = setup();
  await s.load();
  await s.settle();
  s.tag.calls.length = 0;
  const outcome = await s.load();
  assert.equal(outcome.loaded.release.revision, rev("a"));
  assert.deepEqual(s.tag.calls, []);
  assert.equal(s.background.length, 0);
});

test("a stale release is served immediately while the refresh runs in waitUntil", async () => {
  const s = setup();
  await s.load();
  await s.settle();
  s.clock.t += RELEASE_FRESH_MS;
  s.tag.calls.length = 0;
  let release;
  s.tag.stall = new Promise((resolve) => { release = resolve; });
  const outcome = await s.load();
  assert.equal(outcome.loaded.release.revision, rev("a"));
  assert.equal(s.background.length, 1, "refresh handed to waitUntil");
  assert.equal((await s.load()).loaded.release.revision, rev("a"), "one refresh at a time");
  assert.equal(s.background.length, 1);
  s.tag.stall = null;
  release();
  await s.settle();
  assert.deepEqual(s.tag.calls, [`/${PID}/release.json`], "same revision reuses the cached plan");
});

test("a refresh failure keeps the good release and backs off for the negative TTL", async () => {
  const s = setup();
  await s.load();
  await s.settle();
  s.clock.t += RELEASE_FRESH_MS;
  s.tag.failRelease = true;
  assert.equal((await s.load()).loaded.release.revision, rev("a"));
  await s.settle();
  s.tag.calls.length = 0;
  assert.equal((await s.load()).loaded.release.revision, rev("a"), "old entry kept");
  assert.equal(s.background.length, 0, "no retry within the negative TTL");
  s.clock.t += NEGATIVE_TTL_MS;
  s.tag.failRelease = false;
  await s.load();
  assert.equal(s.background.length, 1, "retries after the negative TTL");
  await s.settle();
});

test("a revision change swaps the plan only after the new plan loads, keeping current and previous", async () => {
  const s = setup();
  await s.load();
  s.clock.t += RELEASE_FRESH_MS;
  s.tag.revision = rev("b");
  s.tag.failPlan = true;
  await s.load();
  await s.settle();
  assert.equal((await s.load()).loaded.release.revision, rev("a"), "failed new plan keeps old revision");
  s.clock.t += NEGATIVE_TTL_MS + RELEASE_FRESH_MS;
  s.tag.failPlan = false;
  assert.equal((await s.load()).loaded.release.revision, rev("a"), "stale entry served during swap");
  await s.settle();
  const swapped = await s.load();
  assert.equal(swapped.loaded.release.revision, rev("b"));
  assert.deepEqual(swapped.loaded.plan.queryNames, ["b"]);
  assert.deepEqual(s.cache.revisions(), [rev("a"), rev("b")]);
  s.clock.t += RELEASE_FRESH_MS;
  s.tag.revision = rev("c");
  await s.load();
  await s.settle();
  assert.deepEqual(s.cache.revisions(), [rev("b"), rev("c")], "bounded to current + previous");
});

test("a cold failure is cached only for the negative TTL", async () => {
  const s = setup();
  s.tag.failRelease = true;
  assert.equal((await s.load()).reason, "plan-unavailable");
  s.tag.calls.length = 0;
  assert.equal((await s.load()).reason, "plan-unavailable");
  assert.deepEqual(s.tag.calls, []);
  s.clock.t += NEGATIVE_TTL_MS;
  s.tag.failRelease = false;
  assert.equal((await s.load()).loaded.release.revision, rev("a"));
});
