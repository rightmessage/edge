# Changelog

## 0.4.0

- A RightMessage link's `_rm` query parameter is read. It carries the visitor's answered segments as `_rm_ctx` does, and only `dims` is used. A carried dimension counts as the tag counts it from a URL: one with signals only when a question answers it, and only segments of that dimension. Each accepted dimension replaces that dimension's `_rm_ctx` answers.
- Projects that wait for cookie consent personalize `_rm` landings before consent. When `_rm` carries an accepted dimension, the walk mirrors the tag's pre-consent assignment `off`: every test renders version A, so an Original test leaves the page unchanged, and campaigns with a holdback render their treatment. No cookie is read, the request is evaluated as a first page view, nothing is minted or written, and a personalized response is private/no-store. Without an accepted dimension the request still bypasses as `consent`.
- Plans mark each dimension a question answers with `asked: true`. The plan version is unchanged; older evaluators ignore the field and `_rm`.
- `_rm` is never a touch-cookie query name, like `_rm_ctx`.
- New exports: `decodeUrlContext`, `carriedDimensions`, `URL_CONTEXT_PARAM`. `admitRequest` admits a pre-consent `_rm` request with a cookieless touch and `cookie: null`.
- `tests/fixtures/edge-tests.json` gains cases S10 and S10b for pre-consent `_rm` landings.

## 0.3.0

Breaking within 0.x: `evaluatePlan` returns and `transformHTML` takes `Step[]` instead of `Action[]`, `holdoutUnit` is now `assignmentUnit`, and `campaignHoldback` and `debugForcesTreatment` are internal. There are no compatibility aliases.

- A/B tests and deployed winners render at the edge. The walk visits every campaign's Original layer, then every audience, in the browser's candidate order, and returns ordered `apply`, `claim` and `cut` steps. A running test draws its version exactly as the browser does (`rm-abtest-v1`): a version recorded in `_rm_ctx.ab` wins, and a recorded version the weights lack, invalid weights or a missing unit leave it unknown. Setup tests render untested, and a setup Original test renders nothing. Deployments render for every arm.
- Every writer the edge does not perform is a claim or a cut at its own rank: undecided rules, unknown arms and versions, browser-owned stubs and deferred operations. A read-only probe pass vetoes any lower apply such a claim may overlap, by element and slot family, including ancestors and descendants. Text and find/replace on one target are left to the browser instead of failing the response. `decide` drops any apply beneath a claim or cut, and its decisions gain `layer` and `versionId`.
- Receipts carry `versions` when the applied form occurs only in some versions of a running test. The envelope stays version 1.
- New `admitRequest(plan, request, observe?)` owns the consent gate, `rm_exclude`, unit minting and touch observation for every adapter. A plan with `consent: "required"` personalizes nothing and writes no cookie until the request carries `rm_consent=1`, and responds `bypass:consent`. `rm_exclude=1` renders treatment and version A everywhere and writes no cookie.
- `SUPPORTED_PLAN_VERSIONS` is `[1, 2]`. Version 2 must carry `consent: "required"`; one without it is `invalid-plan`.
- `assignmentUnit` also accepts `_rm_ctx.vid` beside an `ab` ledger. New exports: `admitRequest`, `abTestVersionPoint`, `assignAbTestVersion`, `decodeTestVersions`, `assignmentUnit`, `ORIGINAL_ID`, and the `Step`, `Admission`, `PlanAbTest`, `PlanEntry`, `BrowserOwnedAction`, `OriginalLayer`, `Slot` and `VersionId` types.
- `tests/fixtures/edge-tests.json` and `tests/fixtures/audience-test-assignment.json` are byte-identical copies of the RightMessage application's shared fixtures.

## 0.2.2

- Anonymous `pageviews` / `landingpage` rules are decided from the first observed pathname. A request with no `__Host-rm_touch` cookie records that pathname as `l` and compares it with the same path rules as the current page, so a later single-winning segment can win when an earlier segment's landing pages do not match. A cookie without `l` still leaves those leaves unknown. Identified contacts keep using recorded snapshot outcomes and do not fall back to `l`.
- `__Host-rm_touch` key order is `v, q, r, l, u`. `l` is omitted when unknown, so a browser rewrite that does not know `l` stays byte-identical with the previous contract.

## 0.2.1

- A debugger request (last `debug` query value `true` or `yes`) takes the treatment arm of every tested campaign, including over a recorded or assigned holdout, matching the browser debugger. New export: `debugForcesTreatment`.
- `requestBypassReason` treats the tag's `rm_preview=1` draft-preview session cookie like the preview query keys, so previews that navigated away from `?preview` no longer receive the published plan.

## 0.2.0

- Campaigns with A/B testing run at the edge. Plans publish their operations behind `edge.reason: "campaign-experiment"`, which 0.1.x skips. `decide` assigns the visitor's arm exactly as the browser tag does: a recorded arm in `_rm_ctx.ca`, else `holdoutPoint(unit, campaignId) < withhold || 10`. It personalizes only the treatment arm. A recorded holdout also suppresses campaigns that no longer test.
- `__Host-rm_touch` carries an optional holdout unit `u`. `personalizeResponse` mints it for requests without RightMessage cookies, and `firstRequestHoldoutUnit` exposes the same rule for server rendering. `observeTouchCookie` accepts the unit as a seventh argument, never replaces an existing one, and writes keys in `v, q, r, u` order.
- New exports: `holdoutPoint`, `mintHoldoutUnit`, `decodeCampaignArms`, `holdoutUnit`, `campaignHoldback`, `HOLDOUT_UNIT_PATTERN`, `firstRequestHoldoutUnit`.

## 0.1.0

- Portable strict-TypeScript plan evaluation and pure campaign/variant decisions.
- Versioned release loading, shared deadline, in-isolate cache and fail-open response handling.
- Single-pass HTML transformation with revision-pinned browser receipts.
- Host touch-cookie and integration snapshot codecs.
- Optional Node WASM HTMLRewriter adapter, native/WASM parity fixtures and benchmark.
- Public plan, receipt and cookie contracts plus conformance vectors.
