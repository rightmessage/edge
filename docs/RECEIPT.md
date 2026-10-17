# Edge receipt and browser adoption

The receipt is restoration/adoption metadata, **not an analytics event**. The edge transforms the first HTML response; the ordinary RightMessage browser tag still owns later personalization, restoration, deferred operations, impressions, and conversions.

## Committed document

A successful transform prepends these nodes to the document's single `<head>`:

```html
<meta name="rm-edge-loader" content="https://tags.example/demo-team.js?revision=…">
<script type="application/json" id="RM_EDGE">…</script>
```

The metadata contains the validated release's revision-pinned ordinary public loader URL, not an immutable script artifact URL. A tracking bootstrap must read `meta[name="rm-edge-loader"]` before loading the tag. Merely inserting this metadata does not execute a loader. The matching browser tag compares the receipt revision with `window.RM_RELEASE_REVISION` before adopting it; do not combine an edge plan with an unrelated browser release.

Only changed targets receive the canonical attributes:

```html
<h1 data-rm-edge-target="e1" data-rm-personalized="true" data-rm-variant="variant-example">Personalized content</h1>
```

Target IDs are request-local identities assigned in first-match document order. They are not selectors or durable visitor IDs. If multiple actions change a target, its variant stamp is the last successful action's variant in action order. A selector match or an unchanged find/replace alone does not produce a receipt or stamp.

## Envelope version 1

The JSON envelope has this shape (the revision is abbreviated here only):

```json
{
  "version": 1,
  "revision": "release-revision",
  "receipts": [
    {
      "campaignId": "campaign-example",
      "variantId": "variant-example",
      "actionId": "action-example",
      "targetId": "e1",
      "operations": ["findReplace"],
      "versions": ["A"]
    }
  ],
  "originals": {
    "e1": {
      "attributes": {
        "data-rm-personalized": null,
        "data-rm-variant": null
      },
      "textNodes": [{ "index": 0, "text": "Original text" }]
    }
  }
}
```

- `receipts` contains one entry per changed action/target pair, ordered by action and then target document order. `operations` lists only operations that actually changed that pair: `findReplace`, `text`, `attr:<name>`, `style:<name>`, `classes`, or `visibility`. Unsupported, deferred, and unchanged operations are not claimed as successful.
- `versions` is present exactly when the applied form carried `versions`: the form occurs only in those versions of the node's running test. Within one revision `[campaignId, variantId]` names exactly one node and its test, so no test key is needed. The envelope stays version 1: an older revision's tag must still be able to restore what a newer edge wrote for its plan.
- `originals[targetId]` is shared by all receipts for that target. It retains original values, not intermediate values from preceding actions. Entries for targets with no successful operation are removed.
- `attributes` contains touched attribute slots; `null` means the attribute was absent and restoration should remove it. This can include touched-but-unchanged slots when another operation succeeded. An image `src` edit also retains the original `srcset` slot, even when absent, because changing `src` removes an existing `srcset`.
- `textNodes` contains zero-based descendant text-node baselines for find/replace. Ordinary text is entity-decoded; HTML raw-text element contents use their literal text. Nested matches compose in action order.
- Optional `html` holds original inner HTML when complete content restoration is needed. A full `text` replacement captures it from the original content region. A find/replace that empties a text node triggers a second, read-only capture pass over the original document. In these cases `textNodes` is empty. A committed envelope never leaves `html` as its temporary internal `null` placeholder.

The JSON encoder escapes `<`, U+2028, and U+2029 so original HTML cannot close the inert script element. Attribute insertion is escaped independently. Receipts contain original page content and action identifiers; they should not be treated as secret storage or authoritative visitor identity.

## Browser verification

The matching tag validates every receipt against its own candidate for the same identity. A candidate of a node whose test is running knows its version and whether the action is in the test's footprint. A receipt agrees when the identity exists, its `versions` includes the browser's version (required when either side is versioned), and its operations partition the candidate's. A disagreeing receipt rejects its target component: the target plus every edge target nested in it or containing it. The tag restores each rejected target from `originals`, innermost first, removes `data-rm-edge-target`, and writes the component from its own candidates. An envelope that parses with valid `originals` but cannot be adopted, for example after a revision mismatch, has every component restored. Only malformed JSON, a non-version-1 envelope, duplicate target ids or invalid `originals` are ignored wholesale.

## Ordering and conservative fallback

`transformHTML(bytes, steps, release, HTMLRewriter)` takes the walk's ordered steps (see [The walk](PLAN_SCHEMA.md#the-walk)). Claims and cuts are writers the edge does not perform; they never veto higher ranks, because the browser marks a slot unknown only for candidates beneath a later undecided writer. An apply's own `deferredOperations` act as a claim at its rank. Slot families are `children` (`text`, `findReplace`), `style` (`attr:style`, `style:*`, `visibility`), `class` (`attr:class`, `classes`), `attr:NAME`, and `element`, which intersects every family.

- A cut drops every lower apply without inspecting the document.
- Otherwise, when a claim sits above an apply, a read-only probe pass over the original bytes vetoes apply *i* on element *E* when a higher claim matches *E* with an intersecting family, matches an ancestor of *E* and claims `children` or `element`, or matches a descendant of *E* while *i* writes `children`.
- Text and find/replace on one target cannot both be reproduced, so both pairs are vetoed instead of failing the response. The probe runs for this only when the rewriting pass meets that conflict.

Vetoed pairs get no target id, stamp or receipt. Target ids stay first-match document order over the pairs that apply.

The transform preserves the production algorithm: one HTMLRewriter pass for ordinary edits, followed by an exact marker substitution over its buffered output. Besides the probe above, only emptying a text node requires another read-only pass, the original-HTML capture. Temporary markers use a random per-transform nonce and never appear in committed output.

Selectors match the original document, not a successively mutated DOM. An action that reads an attribute a preceding step writes, including a claim's attribute families, remains browser-owned. A cut or an `element` claim may write any attribute. Within a target, declared `findReplace` takes precedence over declared `text`. A `text` value is replacement **HTML**, not escaped plain text; descendants inside that replaced region are not separately personalized. Find/replace preserves child elements, buffers complete text nodes across stream chunks, and applies each enclosing target's replacements in action order. Unchanged text keeps its original serialized bytes.

Inline style edits retain declaration order. Comments, duplicate properties, unsafe values, and conflicting shorthand/longhand families stay browser-owned rather than producing an inaccurate success receipt. Hiding applies `display: none` and `visibility: hidden` together only when supported.

Unsafe raw-text closing tags, incompatible text-node structure changes, preexisting receipts/stamps/target identities, missing or multiple document heads, incomplete targets, invalid UTF-8, marker mismatches, and buffer overflows throw rather than partially committing. `transformHTML` is a low-level API: it returns `null` when there is no successful change and rejects on transform failure. `personalizeResponse` owns fail-open behavior and preserves the original response body on failure.

The response pipeline caps source HTML at 1 MiB. The transform independently caps collected baselines at 2 MiB and each intermediate/final output at 2 MiB, including receipt and loader metadata. Successful transformed responses must not be shared-cached; the response helper applies private/no-store policy and removes stale body validators.

## Verification and benchmark

`tests/wasm-parity.test.mjs` compares exact committed UTF-8 bytes between Miniflare's native HTMLRewriter and the optional Node WASM adapter. Fixtures exercise overlapping ordered replacements, Unicode/entities, text-node removal and restoration, styles/attributes/classes, `srcset` removal, raw script/style text, content regions, selector dependencies, and failure/no-change outcomes. `tests/edge-transform.test.mjs` checks every probe veto rule, and `tests/edge-tests.test.mjs` checks every walk case of the shared `edge-tests.json` fixture, on both runtimes. The adapter also exercises byte-at-a-time UTF-8 input and asynchronous handlers.

After building, run the portable benchmark:

```sh
npm run bench:edge-transform -- --runtime both --iterations 10 --blocks 40
```

Use `--runtime native` or `--runtime wasm` to select one implementation. `--fixture file.json` accepts `{ "html": "…", "steps": [], "release": {} }` with real public API input shapes (supply a complete release). Defaults are synthetic public fixtures, including ordinary replacement, content regions, empty-node capture, and no match. The benchmark excludes one warmup per fixture/runtime and reports median/max transform time, byte counts, and document passes. Running both runtimes checks exact output equality. Native workerd timers can have coarse resolution; these numbers are local transform measurements, not network latency or a production capacity claim. No production snapshots, private git refs, or network refresh are required.
