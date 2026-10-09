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
import { decide, firstRequestHoldoutUnit, observeTouchCookie, startPlanLoad } from '@rightmessage/edge';

const load = startPlanLoad(request, {
  teamPid: '1213277114',
  allowRsc: true, // only when the framework renders the decisions itself
});
const outcome = await load.promise;
if (outcome.loaded) {
  const cookie = request.headers.get('cookie') ?? '';
  const observation = observeTouchCookie(
    cookie,
    outcome.loaded.plan.queryNames,
    request.url,
    request.headers.get('referer') ?? '',
    null,
    [],
    firstRequestHoldoutUnit(cookie), // lets a first request run A/B-tested campaigns
  );
  const decisions = decide(outcome.loaded.plan, request, observation.state);
  // Decision[]: { campaignId, variantId, actions } in published order.
  // Persist observation.cookie as Set-Cookie only when observation.changed.
}
```

`decide` never touches HTML or mutates request/plan/touch state. It includes only supported, page-matching actions from definitely eligible variants. `evaluatePlan` returns the same actions flattened in order. Unknown rules stay unknown: they do not accidentally select a lower-priority single-winning segment. Decisions are personalization hints, not authentication or authorization.

Campaigns with A/B testing (a holdout share) are decided per visitor arm. The arm the edge assigns is the one the browser tag assigns from the same cookies: a recorded arm in `_rm_ctx`, else a shared hash of the visitor's unit. The edge personalizes only the treatment arm. The browser keeps the default content for the holdout and records exposures for both arms. A debugger request (`?debug=true` or `?debug=yes`) always takes the treatment arm, matching the browser debugger. See [holdout arms](docs/PLAN_SCHEMA.md#holdout-arms).

## API

- `startPlanLoad(request, config, dependencies?, ctx?)` → `PlanLoad` with `promise` and `abort()`. Outcomes are `{ loaded: { plan, release } }` or `{ reason }`. Config: `teamPid`, optional `tagOrigin`, `enabled`, `allowRsc`. Dependencies: `fetch`, `planCache`, `planTimeoutMs`.
- `personalizeResponse(request, origin, planLoad, dependencies)` → `Promise<Response>`. Supply `HTMLRewriter`; optional `observeTouchCookie` injection and a reason-only `log` callback.
- `transformHTML(bytes, actions, release, HTMLRewriter)` performs the buffered transform and returns `null` when no operation succeeds. Prefer `personalizeResponse` for fail-open orchestration.
- `createPlanCache({ now? })`, `PLAN_TIMEOUT_MS`, `RELEASE_FRESH_MS`, `NEGATIVE_TTL_MS`, `SUPPORTED_PLAN_VERSIONS`, `requestBypassReason`.
- `evaluatePlan`, `decide`, touch/context/snapshot codec functions and their named TypeScript models.

## Failure and caching policy

Any release, plan, selector, handler, decoding, buffer or serialization problem leaves origin HTML unchanged. HTML responses expose `x-rm-edge: applied` or `x-rm-edge: bypass:<reason>`. A successful touch observation can still set its cookie after a transform failure. Non-HTML responses retain their original headers and body.

The shared release-plus-plan deadline defaults to **300 ms**. Cold concurrent requests share one load; its independent 5-second ceiling lets it warm the cache after an individual request times out. Releases are fresh for **20 seconds**, then served stale while `ctx.waitUntil` refreshes. Failed loads back off for 3 seconds. The current and previous immutable plans are retained. The revision-pinned loader keeps stale plans and browser behavior aligned. Use a cache per project for long-lived multi-tenant servers.

Personalized and cookie-setting responses are private/no-store, including CDN controls. Changed HTML loses stale content-length, encoding and validators. Unchanged bodies retain validators. Never place personalized responses in a shared cache.

## Limits and browser integration

- Source HTML and plan documents: **1 MiB**; each transform output and collected restoration baselines: **2 MiB**; release pointer: **8 KiB**.
- Only compiler-approved selectors/operations are claimed. Browser-only work, ambiguous rules, unsupported style shapes and unsafe selector dependencies stay browser-owned.
- One rewriting pass handles normal actions. Removing an entire text node requires a read-only capture pass for restoration metadata.
- Keep the ordinary RightMessage tag installed. The bootstrap must use `meta[name="rm-edge-loader"]` when present so it loads the pinned public loader, not an immutable script directly.
- In React, place `suppressHydrationWarning` on each exact personalized element. Cloaking should exclude successfully stamped targets. Soft navigation requires the framework adapter's route lifecycle integration.
- Cookies are best-effort first-party history and are not a consent mechanism. Integrations remain responsible for consent and appropriate data handling.

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
