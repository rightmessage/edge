# Changelog

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
