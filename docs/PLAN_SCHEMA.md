# Published plan schema, version 1

This describes the public JSON consumed by `@rightmessage/edge`, not an alternative authoring format. A published plan preserves the browser's rule vocabulary but carries only actions the edge may execute at least in part; wholly browser-owned actions are omitted and stay with the browser tag. The edge executes only decisions it can establish and operations the compiler explicitly permits; the browser remains authoritative.

## Live reference

The public [release pointer](https://t.rightmessage.com/1213277114/release.json) was fetched, then its exact immutable `planUrl` was fetched. The observed release was:

```json
{
  "version": 1,
  "teamPid": "1213277114",
  "revision": "51b52557fc249f2e25d816cee65b38b2f8ec92129d45ecede76351df0bd583fa",
  "planUrl": "https://t.rightmessage.com/1213277114/revisions/51b52557fc249f2e25d816cee65b38b2f8ec92129d45ecede76351df0bd583fa/plan.json",
  "loaderUrl": "https://t.rightmessage.com/1213277114.js?revision=51b52557fc249f2e25d816cee65b38b2f8ec92129d45ecede76351df0bd583fa"
}
```

The [observed immutable plan](https://t.rightmessage.com/1213277114/revisions/51b52557fc249f2e25d816cee65b38b2f8ec92129d45ecede76351df0bd583fa/plan.json) has exactly these root fields: `campaigns`, `connectionScope`, `dimensions`, `queryNames`, `teamPid`, `version`. It contains three dimensions and five campaigns. This is an observation of that revision, not a fixed inventory or a requirement that every plan have `connectionScope`. The examples below use synthetic names, IDs, selectors, and values rather than copying published campaign content.

## Release validation and loading

For configured HTTPS tag origin `O` and team PID `P`, the core fetches `O/P/release.json`, then the validated immutable plan URL. The default origin is `https://t.rightmessage.com`.

The release is accepted only when:

- `version` is the number `1` and `teamPid` exactly equals the configured PID string.
- `revision` is 64 lowercase hexadecimal characters.
- `planUrl` exactly equals `O/P/revisions/REVISION/plan.json`.
- `loaderUrl` exactly equals `O/P.js?revision=REVISION`.

The URLs are not arbitrary redirect destinations supplied by a plan: their strings must match those derived from the configured origin, team, and revision. The configured origin must be an HTTPS origin with `/` as its path and no query or fragment; the PID allows only ASCII letters, digits, `_`, and `-`. The release response is bounded to 8 KiB. The plan response is bounded to 1 MiB. Non-successful responses and fetch failures produce `plan-unavailable`; invalid JSON, invalid release fields, unsupported plan versions, or invalid required plan root fields produce `invalid-plan`.

The loader validates the plan's `version`, exact `teamPid`, `queryNames` array of strings excluding `_rm_ctx`, and `dimensions` and `campaigns` arrays. This is root validation, **not** exhaustive validation of every nested rule or action. Preserve compiler output rather than treating arbitrary JSON that passes those checks as a supported plan.

`SUPPORTED_PLAN_VERSIONS` is `[1]`. Release version and plan version are separate fields, both currently `1`. The revision belongs to the release; there is no required root `revision` in the plan. Treat the revision as an opaque publication identifier. The core does not recompute it from the plan body.

```ts
const load = startPlanLoad(
  request,
  { teamPid: "1213277114", tagOrigin, enabled, allowRsc },
  { fetch, planCache, planTimeoutMs },
  ctx,
);
// Always a PlanLoad, including immediate bypasses:
// { promise: Promise<{ loaded: { plan, release } } | { reason: string }>,
//   abort(): void, bypassReason?: string }
```

All configuration/dependency fields above except `teamPid` are optional. Start the load before awaiting the origin response, then pass that same handle to `personalizeResponse(request, origin, load, { HTMLRewriter, observeTouchCookie?, log? })`.

The default per-request deadline is 300 ms. The in-memory cache retains up to two immutable revisions, shares an in-flight load, and treats a release as fresh for 20 seconds. A stale good pair is served immediately while refresh runs; a replacement becomes current only after its plan validates. Failures are remembered for 3 seconds without evicting a good pair. A shared load has a 5-second ceiling and can continue after an individual request's deadline. `ctx.waitUntil`, when available, keeps this background work alive.

## Plan root

| Field | Shape | Meaning |
| --- | --- | --- |
| `version` | `1` | Supported plan schema version. |
| `teamPid` | string | Public project identifier; must match the release/configuration. |
| `queryNames` | string array | Compiler-discovered query names needed by published rules. Sorted by the compiler; `_rm_ctx` is excluded. This is the touch-history allowlist, not visitor query values. |
| `dimensions` | dimension array | Referenced dimensions, including transitive dependencies through signals. Not necessarily every dimension in the project. |
| `campaigns` | campaign array | Ordered live campaigns, limited to variants and actions with at least one edge-permitted operation. Holdout-tested campaigns are included behind `campaign-experiment`. There is no root `actions` array. |
| `connectionScope` | optional string | Opaque active integration-connection scope used to reject recorded outcomes from another connection. It is not a contact ID, credential, or revision. |

Object key order is not semantic, except that attribute/style modification ordering must be preserved. Array order is significant, including segment priority and action order. Do not reorder or strip what the plan carries.

## Dimensions and signals

A dimension contains `id`, `isMultiWinning`, `segments`, and `signals`. Each published segment is an object with an `id`; segment display names are not needed by this execution plan.

A signal contains:

- `indicates`: the segment ID it can select.
- `weight`: retained compiler metadata, for example `"strong"`. The current edge evaluator does not calculate a numeric score from it.
- `definition`: the complete rule tree.
- `edge`: `{ supported: boolean, reason: string | null }`, summarizing whether all of the signal is request-decidable.

**Do not reject a whole signal just because its summary says `supported: false`.** The compiler annotates its leaves separately. A request-decidable branch may settle a mixed tree even while another branch remains unknown.

Dimension evaluation uses hard answers from `_rm_ctx.dims[dimensionId]` before signal inference. A missing dimension answer is unanswered, not an unknown answer. Signals indicating the same segment combine with OR.

- For a single-winning dimension (`isMultiWinning: false`), segment array order is priority order. Answers are considered before signals. An earlier unknown signal can block a later true signal from becoming a definite winner; it must not be treated as a non-match.
- For a multi-winning dimension, segments can independently be true, false, or unknown.
- Recursive dimension dependencies are guarded: a cycle leaves affected segment results unknown. Unknown segment references do not become matches.

## Rules and three-valued evaluation

A general rule is a boolean or an object. Groups use `and`/`all`, `or`/`any`, or `not`. Leaves retain `$source`, `$type`, and source-specific fields such as `operator`, `value`, `query`, `occurrence`, `timeframe`, `domain`, `segmentId`, and integration-specific field identifiers. Compiler annotations are under `edge`, not replacements for the original leaf.

The three outcomes are `true`, `false`, and unknown (internally `null`):

| Expression | Result |
| --- | --- |
| `false AND unknown` | `false` |
| `true AND unknown` | unknown |
| `true OR unknown` | `true` |
| `false OR unknown` | unknown |
| `NOT unknown` | unknown |

Only a definite `true` makes a variant eligible. Missing browser state, unsupported rules, and unrecognized operators must not be coerced into false to choose another audience.

Variant `rules` commonly use `{ "all": [{ "dimensionId": "dim_example", "segment": "seg_example" }] }` or the corresponding `any` form. These immediate `segment` entries are membership references resolved against the plan's dimensions, not ordinary `$source` leaves. General segment-rule leaves instead use `$source: "segments"`, `$type: dimensionId`, `operator`, and `segmentId`.

There is an intentional evaluator distinction for empty groups: generic rule-tree `and`/`all` and `or`/`any` arrays evaluate false when empty, while a variant's top-level `rules.all: []` **or** `rules.any: []` is unrestricted/true. Missing variant rules are false. Do not normalize these shapes into one another.

### Request-decidable vocabulary

| `$source` | Supported facts and boundaries |
| --- | --- |
| `segments` | Dimension membership. Compare known and possible memberships; disagreement means unknown. |
| `query`, `utm` | Named query values (`query` for `query`, `$type` for `utm`); occurrences `current`, `last`, `first touch`, `last touch`. |
| `currentpage` | `$type: "path"` against the current pathname. |
| `pageviews` | Current/last path or query; first/last-touch query. Other pageview history remains browser work. |
| `referrer` | `domain`, `direct`, or `referral` using the first observed referrer hostname. Referrer paths are not retained. |
| `location` | `country` and `city` from adapter-supplied `request.cf` facts. |
| `date` | `date`, `weekday`, and zero-based `month` using `request.cf.timezone`; missing/invalid timezone means unknown. |
| `device` | `browser` and `os` from the request User-Agent. |

A finite `timeframe` other than `ever` is browser history, not reconstructed request history. Do not infer that a compiler-supported source means every operator or every missing input is decidable.

Scalar comparisons include `equals`, `does not equal`, `is set`, `is not set`, `gt`, `gte`, `lt`, `lte`, `contains`, `does not contain`, `starts with`, `ends with`, and `glob`. Array comparisons include singular/plural `include`/`includes`, their negative forms, `include any`/`includes any`, their negative forms, and set/unset checks. Date rules also have date-specific operators such as `before`, `after`, `between`, `ever`, and relative windows. Comparisons follow the published browser vocabulary rather than JavaScript truthiness.

Current query values are URL-decoded; duplicate names use their last value. First/last-touch values come from `__Host-rm_touch`, retaining only `queryNames`. An absent first/last-touch query name means no observed pageview and evaluates false even for negative operators; an observed empty value is still compared. An own empty referrer value records direct traffic, whereas an absent referrer is unknown.

### Browser-backed leaves and snapshots

Leaf `edge` metadata contains `supported`, `reason`, and sometimes `key`. Signal reasons are `integration-signal`, `browser-history`, and `browser-signal`; supported leaves have `reason: null`.

- Without a scoped contact identity, an `integration-signal` leaf is evaluated against the browser's anonymous empty profile where supported: no custom fields, tags, lists, purchases, or events, revenue zero, anonymous true, subscriber false. Negative membership/unset checks can therefore be true. Unrecognized integration types remain unknown.
- For an identified contact, unsupported leaves can use the browser's recorded boolean in `_rm_ctx.es` under `edge.key`. Missing or invalid recorded state stays unknown.
- Keys are eight-character, URL-safe, content-derived strings, **not** eight hexadecimal digits. Eligible integration leaves without finite history windows and landing-page leaves can carry them. Changed leaves get new keys; compiler-detected key collisions lose their keys rather than share ambiguous outcomes.
- Snapshot version `1` records profile true/false key lists (`t`/`f`) bound by `b` to project, connection, and contact. Landing-page lists (`ht`/`hf`) additionally require `h` to match the request origin. `d` is the UTC day of the profile read; future, missing, or more-than-30-day-old dates are invalid. Conflicting true/false entries are unknown.
- The cookie's project/connection identity must agree with the plan and `connectionScope`. An absent scope cannot authorize snapshot-backed decisions. These cookies are personalization hints, not authentication or authorization evidence.

## Campaigns, variants, and actions

The live campaign shape includes `id`, `name`, `is_active`, `base_url`, `condition`, `dimension_id`, `goal_ids`, `recipe_code`, `testing`, and `variants`. Variants contain `id`, `name`, `rules`, and `actions`.

The evaluator considers active campaigns, eligible variants, and page-matching actions in published order. It does not evaluate campaign display metadata as another rule tree or stop after the first eligible campaign. Before a campaign's variants, it resolves the visitor's holdout arm exactly as the browser does (see [Holdout arms](#holdout-arms)) and considers only the treatment arm. For the holdout arm, or when the arm is unknown, the browser keeps the default content and records the exposure. The edge action boundary is `edge.supported === true` plus page eligibility, followed by successful transformation of actual matching elements. In a campaign resolved to its treatment arm, an action with `edge.reason === "campaign-experiment"` and a non-empty `edge.operations` also crosses that boundary.

### Holdout arms

A campaign whose `testing.is_enabled` is truthy publishes every retained action as `{"supported": false, "reason": "campaign-experiment", "operations": [...], "deferredOperations": [...]}`. Evaluators that cannot assign arms (0.1.x) skip such actions and never personalize the holdout arm. A publisher may omit tested campaigns to keep the plan within the 1 MiB limit; omitted campaigns stay browser-applied.

The arm (`campaignHoldback`) is chosen in this order. A request whose last `debug` query value is `true` or `yes` (`debugForcesTreatment`) skips it and takes the treatment arm, matching the browser debugger, which neither reads nor records arms.

1. A record for the campaign in `_rm_ctx.ca`. It wins for every campaign, including a non-experiment campaign that still holds a sticky holdout.
2. For a campaign without testing enabled, the treatment arm.
3. `holdoutPoint(unit, campaignId) < Number(testing.withhold || 10)` holds the visitor out. The point is FNV-1a over the UTF-16 code units of `rm-holdout-v1 NUL unit NUL campaignId`, finalized with murmur3 `fmix32` and scaled to [0, 100).
4. With no unit, the arm is unknown.

The unit is the touch cookie's `u`, else `_rm_ctx.vid` when `_rm_ctx.ca` is present. The browser hashes the same unit. `personalizeResponse` mints `u` only for a request carrying neither `__Host-rm_touch` nor `_rm_ctx`. See [COOKIES.md](COOKIES.md).

`evaluatePlan(plan, request, touch, now?)` returns the eligible actions in that order. `decide(plan, request, touch, now?)` returns the same selections grouped as `{ campaignId, variantId, actions }[]`, omitting groups with no eligible actions. Neither API performs HTML rewriting; selectors and operation success are resolved by the transform.

An element action has:

| Field | Meaning |
| --- | --- |
| `$type` | Published action kind; edge element modifications are `"MODIFY_ELEMENT"`. This is `$type`, not a required `type` field. |
| `id`, `actionId` | Original action ID and compiler-added receipt ID; the compiler copies `id` into `actionId`. |
| `campaignId`, `variantId` | Compiler-added owning IDs for decisions/receipts. |
| `page` | Array of `{ domain, path }` criteria; any matching criterion is sufficient. |
| `selector` | CSS selector for the original document. |
| `modifications` | Original operation values, including browser-deferred values. |
| `edge` | Exact compiler operation permissions and deferrals, described below. |

Page domains are exact hosts after stripping a leading `www.`, or `"*"`. Paths are compared case-insensitively with leading/trailing slashes removed; published wildcard paths such as `"/*"` and `"/guides/*"` match using the evaluator's wildcard handling. `base_url` is not a substitute for the action's `page` criteria. A selector also has to match a rendered element; a matching audience alone does not guarantee a DOM change.

### Exact operation and deferred metadata

Action metadata is:

```json
{
  "supported": true,
  "reason": "browser-visibility",
  "operations": ["text"],
  "deferredOperations": ["visibility"]
}
```

`operations` is an exact allowlist, not a list to reconstruct from modification keys. `deferredOperations` names work retained for the browser. `supported` is true exactly when the compiler emitted at least one permitted operation; it does **not** mean every modification can run at the edge. `reason` is null when no deferral reason applies, otherwise an action-level reason or the first applicable operation reason, not an exhaustive per-operation error map. A supported mixed action can have a non-null reason.

| Operation token | Value in `modifications` | Edge boundary |
| --- | --- | --- |
| `text` | `text` | Static nonempty whole-content replacement. |
| `findReplace` | `findReplace: [{ find, replace }]` | Ordered text replacements preserving nested elements. Takes precedence over `text`; the compiler does not emit both candidates for the same action. |
| `attr:NAME` | `attr[NAME]` | Exact named attribute write. `value`, `checked`, `selected`, and `style` attribute writes are browser properties/work. |
| `style:NAME` | `style[NAME]` | Exact named inline-style edit, subject to runtime safety checks. |
| `classes` | `classes: { add: [...], remove: [...] }` | Static class additions/removals. |
| `visibility` | `visibility` | `"hide"` only; computed-style `"show"` remains browser-owned. |

Null/empty attribute and style values are not compiler candidates. Empty text is not a text candidate. Unknown modification keys are retained as deferred tokens with `browser-modification`, rather than silently implemented by the edge. Strings containing `{{` or `{%` anywhere in an operation's values are dynamic and deferred.

Actions the edge cannot execute at all are omitted from the plan: non-`MODIFY_ELEMENT` actions, unsupported selectors, browser targeting, and actions whose every operation is deferred. Variants and campaigns left without actions are omitted too, so plan size tracks edge work rather than campaign content. Operation reasons on retained actions include `dynamic-value`, `browser-property`, `browser-visibility`, `browser-modification`, and `browser-operation-order`. The last prevents partial execution from reordering overlapping writes:

- If either `attr:src` or `attr:srcset` is deferred, both present candidates are deferred.
- Deferred `attr:style` or any deferred `style:*` write defers all present `style:*` candidates.
- A deferred `attr:class` also defers a present `classes` operation.
- Deferred writes to `attr:style`, `style:display`, `style:visibility`, `style:all`, or `style:cssText` also defer an otherwise permitted hide operation.

The selector capability gate permits ordinary tag/class/ID/attribute selectors, descendant and child combinators, `nth-child`, `nth-of-type`, `first-child`, `first-of-type`, and `not`. Sibling combinators, pseudo-elements, `has`, and last-child families remain browser work. This gate is not a CSS parser; native HTMLRewriter still validates syntax.

Compiler permission is necessary, not proof of runtime success. Ambiguous inline-style edits, selectors dependent on attributes earlier actions write, and targets replaced by enclosing content can remain browser-owned. Receipts claim only operations that actually succeeded on a target, never every declared or deferred operation.

## Synthetic version-1 example

This compact example follows the fetched plan's nesting and compiler metadata. IDs, content, and query values are illustrative; it is not a real release or a generated content hash.

```json
{
  "version": 1,
  "teamPid": "1213277114",
  "queryNames": ["audience"],
  "dimensions": [{
    "id": "dim_audience",
    "isMultiWinning": false,
    "segments": [{ "id": "seg_reader" }],
    "signals": [{
      "indicates": "seg_reader",
      "weight": "strong",
      "definition": { "or": [{ "and": [{
        "$source": "query",
        "$type": "custom",
        "query": "audience",
        "occurrence": "last touch",
        "operator": "equals",
        "value": "reader",
        "edge": { "supported": true, "reason": null }
      }] }] },
      "edge": { "supported": true, "reason": null }
    }]
  }],
  "campaigns": [{
    "id": "cpn_welcome",
    "name": "Welcome message",
    "is_active": true,
    "base_url": "https://*/*",
    "condition": true,
    "dimension_id": null,
    "goal_ids": [],
    "recipe_code": null,
    "testing": { "is_enabled": false, "withhold": 0 },
    "variants": [{
      "id": "var_reader",
      "name": "Reader",
      "rules": { "all": [{ "dimensionId": "dim_audience", "segment": "seg_reader" }] },
      "actions": [{
        "$type": "MODIFY_ELEMENT",
        "id": "act_heading",
        "actionId": "act_heading",
        "campaignId": "cpn_welcome",
        "variantId": "var_reader",
        "page": [{ "domain": "*", "path": "/guides/*" }],
        "selector": "h1",
        "modifications": { "text": "Your next great read", "visibility": "show" },
        "edge": {
          "supported": true,
          "reason": "browser-visibility",
          "operations": ["text"],
          "deferredOperations": ["visibility"]
        }
      }]
    }]
  }]
}
```

## Pinned browser handoff and fail-open behavior

A successful transform emits `meta[name="rm-edge-loader"]` containing the **validated public `release.loaderUrl`** and `script#RM_EDGE[type="application/json"]` with `{ version: 1, revision, receipts, originals }`. Each receipt names `campaignId`, `variantId`, `actionId`, `targetId`, and exact successful `operations`. `originals` retains the touched baselines needed for browser restoration.

The browser loader must use the pinned URL from the same release as the plan, not the latest unpinned tag URL. The browser's `window.RM_RELEASE_REVISION` must agree with the receipt revision before adoption. Deferred operations, unmatched/later targets, restoration, and analytics remain browser-owned; a definite eligibility disagreement is corrected by the browser. This pairing is why serving an old cached plan is safe only with its corresponding old pinned loader. Never combine a plan from one release with a loader fetched from a later release pointer.

`requestBypassReason` excludes disabled execution (`not-production`), non-GET requests (`request-method`), RSC requests unless `allowRsc` is enabled (`rsc`), URLs containing `preview`, `rmpreview`, `__rm_test`, or `rmeditor` (`preview`), and requests carrying the tag's draft-preview session cookie `rm_preview=1` (`preview`). The query keys are presence checks, not truthy-value checks.

Non-HTML responses pass through. HTML with a non-200 origin status or unsupported declared charset bypasses. Load failures, timeouts, unsupported versions, and invalid plans preserve the origin body; without a validated plan there is no guessed query allowlist or touch-cookie update. No eligible/successful actions yield `no-actions`, or `cookie-only` when attribution alone changed. Attribution, transform, selector, serialization, and buffer failures fail open rather than deliver partial personalization.

HTML responses expose `x-rm-edge: applied` or `x-rm-edge: bypass:<reason>`. A successful touch observation can survive a later transform failure. Cookie-only or personalized responses become private/no-store; committed body changes remove stale body validators, length, and encoding headers. Request bypasses preserve the body and do not observe touch history.
