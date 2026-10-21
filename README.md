# @rightmessage/edge

Flicker-free RightMessage personalization before HTML reaches the browser. This portable engine evaluates published plans, changes supported HTML targets, and gives the ordinary browser tag a revision-pinned receipt so it adopts the result without applying it twice.

Use [@rightmessage/cloudflare](https://github.com/rightmessage/edge-cloudflare) for a ready-made Worker, or [@rightmessage/next](https://github.com/rightmessage/edge-nextjs) for Next.js. This package is the framework-independent engine.

## Install

Requires Node.js 20+ or a Web-standard runtime with Request, Response, streams, fetch and Intl.

```sh
# Available now, before the npm release:
npm install github:rightmessage/edge#v0.1.0

# After the public npm release:
npm install @rightmessage/edge
```

Git installs run `prepare` to build ESM JavaScript and TypeScript declarations. The main entry point has only one runtime dependency, `entities`. No Workers globals are imported.

## Quick start: native HTMLRewriter

Start the plan request before rendering the origin page. Keep the same cache instance across requests, and inject a service binding fetch when the public tag URL is on your Cloudflare zone.

```ts
import { createPlanCache, startPlanLoad, personalizeResponse } from '@rightmessage/edge';

const planCache = createPlanCache();
const config = { teamPid: '1213277114', tagOrigin: 'https://t.rightmessage.com' };

export default {
  async fetch(request, env, ctx) {
    const planLoad = startPlanLoad(request, config, {
      planCache,
      fetch: request => env.TAG_ROUTER.fetch(request),
    }, ctx);
    let origin;
    try {
      origin = await env.ORIGIN.fetch(request);
    } catch (error) {
      planLoad.abort();
      throw error;
    }
    return personalizeResponse(request, origin, planLoad, { HTMLRewriter });
  },
};
```

Without a service binding, omit `fetch` to use global fetch. `enabled: false` in the config bypasses published personalization in preview/staging. GET requests with `rsc` headers, the exact `preview`, `rmpreview`, `__rm_test`, or `rmeditor` query keys, or the tag's `rm_preview=1` draft-preview session cookie bypass automatically. The integration owns other routing policy such as API paths and prefetch exclusion. Non-HTML responses pass through unchanged.

### Node and other non-Workers hosts

```sh
npm install html-rewriter-wasm
```

```ts
import { startPlanLoad, personalizeResponse } from '@rightmessage/edge';
import { HTMLRewriter } from '@rightmessage/edge/wasm';

const planLoad = startPlanLoad(request, { teamPid: '1213277114' });
const origin = await render(request);
const response = await personalizeResponse(request, origin, planLoad, { HTMLRewriter });
```

The optional `/wasm` entry adapts `html-rewriter-wasm` (lol-html) to the same streaming constructor contract as native Workers HTMLRewriter. It is not imported by the main entry. Hosts must support WebAssembly and the package's WASM loading mechanism; Node is verified. `npm test` compares exact native/WASM output bytes and verifies receipt contents on the parity fixtures. The benchmark also checks byte equality before reporting timings.

## Pure decisions for server rendering

```ts
import { admitRequest, decide, startPlanLoad } from '@rightmessage/edge';

const load = startPlanLoad(request, {
  teamPid: '1213277114',
  allowRsc: true, // only when the framework renders the decisions itself
});
const outcome = await load.promise;
if (outcome.loaded) {
  // Consent, rm_exclude, unit minting and touch observation in one call.
  const admission = admitRequest(outcome.loaded.plan, request);
  if ('bypass' in admission) {
    // 'consent': the project waits for cookie consent and the URL carries no usable `_rm`. Write no cookie and render nothing.
  } else {
    const decisions = decide(outcome.loaded.plan, request, admission.touch);
    // Decision[]: { campaignId, variantId, layer: 'original' | 'audience', versionId?, actions }
    // in browser layer order: every Original layer, then every audience.
    // Append admission.cookie as Set-Cookie when it is not null.
  }
}
```

`decide` never touches HTML or mutates request/plan/touch state. It includes only page-matching actions from definitely eligible, decided nodes. With no DOM to check overlap, it also drops any action beneath a writer the edge does not perform. `evaluatePlan` returns the full ordered steps that `transformHTML` consumes. Unknown rules stay unknown: they do not accidentally select a lower-priority single-winning segment. A cookieless request records its pathname as touch field `l` and can decide landing-page rules from it, so a later segment can win when an earlier segment's landing pages do not match. A cookie without `l` leaves those rules unknown. Decisions are personalization hints, not authentication or authorization.

Campaigns with a holdout share are decided per visitor arm, and running A/B tests per version. The edge assigns the arm and version the browser tag assigns from the same cookies: a recorded arm in `_rm_ctx.ca` or version in `_rm_ctx.ab`, else a shared hash of the visitor's unit. The edge personalizes only the treatment arm. Deployed winners and each campaign's Original layer render first, for every arm, then audiences, as in the browser. When the edge cannot know a rule, arm or version, it leaves that writer to the browser and stays out of the elements it may touch. A debugger request (`?debug=true` or `?debug=yes`) takes the treatment arm and leaves every tested layer to the browser. See [the walk](docs/PLAN_SCHEMA.md#the-walk).

A project that waits for cookie consent publishes a version 2 plan with `consent: "required"`. Until the tag sets `rm_consent=1`, the edge writes no cookie and personalizes nothing, unless the URL carries a RightMessage link's `_rm` answers (below). A browser opted out with `rm_exclude=1` sees the treatment arm and version A everywhere, and the edge writes no cookie for it. See [cookies](docs/COOKIES.md).

A RightMessage link (a flow redirect or offer link, for example) can carry the visitor's answered segments in the `_rm` query parameter, encoded like `_rm_ctx`. The edge accepts a carried dimension as the tag does: a dimension with signals counts only when a question answers it (plan field `asked`), and segments outside the dimension are dropped. Each accepted dimension replaces that dimension's `_rm_ctx` answers. Before consent, accepted `_rm` answers are personalized with the tag's assignment off: every test shows version A, holdback campaigns render their treatment, no cookie is read or written, and a personalized response is private/no-store. Without an accepted dimension the request still bypasses as `consent`. See [`_rm`](docs/COOKIES.md#_rm-link-context).

## API

- `startPlanLoad(request, config, dependencies?, ctx?)` → `PlanLoad` with `promise` and `abort()`. Outcomes are `{ loaded: { plan, release } }` or `{ reason }`. Config: `teamPid`, optional `tagOrigin`, `enabled`, `allowRsc`. Dependencies: `fetch`, `planCache`, `planTimeoutMs`.
- `personalizeResponse(request, origin, planLoad, dependencies)` → `Promise<Response>`. Supply `HTMLRewriter`; optional `observeTouchCookie` injection and a reason-only `log` callback.
- `admitRequest(plan, request, observeTouchCookie?)` → `{ bypass: 'consent' }` or `{ touch, cookie }`. It owns the consent gate, `rm_exclude`, unit minting and touch observation for every adapter. Before consent, a request carrying accepted `_rm` dimensions is admitted with a cookieless first-page-view `touch` and `cookie: null`.
- `transformHTML(bytes, steps, release, HTMLRewriter)` performs the buffered transform and returns `null` when no operation succeeds. Prefer `personalizeResponse` for fail-open orchestration.
- `createPlanCache({ now? })`, `PLAN_TIMEOUT_MS`, `RELEASE_FRESH_MS`, `NEGATIVE_TTL_MS`, `SUPPORTED_PLAN_VERSIONS`, `requestBypassReason`.
- `evaluatePlan` (ordered `apply`, `claim` and `cut` steps), `decide`, `abTestVersionPoint`, `assignAbTestVersion`, `decodeTestVersions`, `assignmentUnit`, `decodeUrlContext`, `carriedDimensions`, `URL_CONTEXT_PARAM`, touch/context/snapshot codec functions and their named TypeScript models.

## Failure and caching policy

Any release, plan, selector, handler, decoding, buffer or serialization problem leaves origin HTML unchanged. HTML responses expose `x-rm-edge: applied` or `x-rm-edge: bypass:<reason>`. A successful touch observation can still set its cookie after a transform failure. Non-HTML responses retain their original headers and body.

The shared release-plus-plan deadline defaults to **300 ms**. Cold concurrent requests share one load; its independent 5-second ceiling lets it warm the cache after an individual request times out. Releases are fresh for **20 seconds**, then served stale while `ctx.waitUntil` refreshes. Failed loads back off for 3 seconds. The current and previous immutable plans are retained. The revision-pinned loader keeps stale plans and browser behavior aligned. Use a cache per project for long-lived multi-tenant servers.

Personalized and cookie-setting responses are private/no-store, including CDN controls. Changed HTML loses stale content-length, encoding and validators. Unchanged bodies retain validators. Never place personalized responses in a shared cache.

## Limits and browser integration

- Source HTML and plan documents: **1 MiB**; each transform output and collected restoration baselines: **2 MiB**; release pointer: **8 KiB**.
- Only compiler-approved selectors/operations are claimed. Browser-only work, ambiguous rules, unsupported style shapes and unsafe selector dependencies stay browser-owned.
- One rewriting pass handles normal actions. A read-only probe pass runs only when a writer the edge does not perform sits above an edge write, or when text and find/replace meet on one target. Removing an entire text node requires a read-only capture pass for restoration metadata.
- Keep the ordinary RightMessage tag installed. The bootstrap must use `meta[name="rm-edge-loader"]` when present so it loads the pinned public loader, not an immutable script directly.
- In React, place `suppressHydrationWarning` on each exact personalized element. Cloaking should exclude successfully stamped targets. Soft navigation requires the framework adapter's route lifecycle integration.
- Cookies are best-effort first-party history. The engine honors the tag's `rm_consent` gate for projects that wait for consent, but integrations remain responsible for consent and appropriate data handling.

See [plan schema](docs/PLAN_SCHEMA.md), [receipt contract](docs/RECEIPT.md), [cookies](docs/COOKIES.md), and the shared [conformance vectors](tests/fixtures/conformance.json).

### Revision-aware browser bootstrap

Replace the ordinary loader insertion with this script in the document head, using your team ID. Do not install a second copy of the tag. Keep any existing consent gate around the bootstrap. The edge inserts its validated pin before head scripts; without a committed transform this loads the ordinary unpinned public loader.

```html
<script>
  (function (teamPid, document) {
    window.RM = window.RM || [];
    var script = document.createElement('script');
    var pin = document.querySelector('meta[name="rm-edge-loader"]');
    script.async = true;
    script.src = pin ? pin.content : 'https://t.rightmessage.com/' + teamPid + '.js';
    script.onerror = function () {
      var cloak = document.getElementById('rmcloak');
      if (cloak) cloak.remove();
      document.documentElement.classList.remove('rm-loading');
    };
    document.head.appendChild(script);
  })('1213277114', document);
</script>
```

This minimal bootstrap does not add a cloak. If you already cloak targets, use the selector below instead of hiding every `.rmcloak` element: successful edge targets and their groups must remain visible. Preserve your existing tag-completion reveal and `<noscript>` fallback.

```css
.rmcloak:not([data-rm-edge-target][data-rm-personalized="true"]):not(:has([data-rm-edge-target][data-rm-personalized="true"])) {
  visibility: hidden !important;
}
```

For React, install the bootstrap before hydration and apply `suppressHydrationWarning` to the exact personalized text/attribute target, not only its parent. The [Next.js adapter](https://github.com/rightmessage/edge-nextjs) includes the soft-navigation integration.

## Development and support

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run bench:edge-transform
```

File reproducible bugs or feature requests in [GitHub issues](https://github.com/rightmessage/edge/issues). Use synthetic plans and remove cookies, contact details and credentials. Report vulnerabilities privately to **security@rightmessage.com**. See [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), and [CHANGELOG](CHANGELOG.md).

MIT © 2026 RightMessage.
