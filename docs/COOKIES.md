# Cookie wire contracts

These cookies are best-effort first-party display inputs, not authentication, an authorization boundary, or a synchronized visitor ledger. The engine honors the tag's consent and opt-out flags (see [`rm_consent` and `rm_exclude`](#rm_consent-and-rm_exclude)) but is not itself a consent policy. The browser remains authoritative and can replace an edge result when its own current evaluation disagrees.

## `_rm_ctx`: browser context

`decodeContextCookie(cookieHeader)` reads the first `_rm_ctx` entry, URI-decodes it, reverses the browser's base64 substitutions (`-` → `+`, `_` → `/`, `~` → `=`), strictly decodes UTF-8, and parses JSON. Missing, malformed, invalid UTF-8, or non-version-1 payloads return `{}`. The decoder preserves version-1 fields rather than imposing a second browser schema.

Relevant fields are `v: 1`, `dims` (dimension IDs to answered segment arrays), `cid` (contact identity), `identityScope: {project, connection}`, optional `es` (recorded outcomes), `vid` (the browser's visitor ID), optional `ca` (the campaign arm ledger), and optional `ab` (the test version ledger). A dimension absent from `dims` is unanswered. The browser writes answers synchronously and flushes pending context writes before navigation.

The browser writes `_rm_ctx` across the registrable domain. Profile outcomes can therefore be used on the apex and sibling subdomains. Pageview history is per origin, so landing-page outcomes require an additional origin binding. This package only decodes `_rm_ctx`; it does not set its Domain or rewrite it.

### Recorded outcome snapshot

```json
{
  "v": 1,
  "d": 20000,
  "b": "12345678",
  "t": "aaaaaaaa",
  "f": "bbbbbbbb",
  "h": "87654321",
  "ht": "cccccccc",
  "hf": ""
}
```

The binding values above are illustrative. Use `edgeSignalBinding(project, scope, contactId)` for actual bindings.

- `d` is an integer UTC day since the Unix epoch, stamped by a fully loaded profile read after the contact's last email-platform write. A snapshot is fresh from day `d` through day `d + 30`, inclusive. Missing, fractional, future, and older stamps are absent.
- `t` and `f` concatenate fixed-width eight-character compiler rule keys for true and false integration-profile outcomes. Empty lists are valid. The decoder validates length, not a hexadecimal alphabet.
- `b` binds the project, connection, and contact. Binding is FNV-1a over UTF-16 code units in `project + NUL + scope + NUL + contactId`, rendered as eight lowercase hexadecimal characters. It detects mismatched identity; it is not a signature.
- `h` binds the project, request origin, and contact for optional `ht`/`hf` landing-page lists. A missing or mismatched origin binding omits those lists but does not discard valid profile outcomes.
- A key recorded both true and false is removed, including conflicts between profile and page lists. It stays unknown rather than being guessed.
- Evaluation additionally requires the cookie's project to match the plan and its connection to match `plan.connectionScope`. A missing scope, changed connection, missing key, republished rule key, malformed profile list, or absent snapshot leaves identified-contact leaves unknown. An unknown higher-priority segment prevents an incorrect lower-priority single winner.

The browser omits `es` whenever including it would push `_rm_ctx` beyond 3,500 encoded characters. This is the browser writer's bound, not an extra truncation policy in `decodeContextCookie`. The browser never reads `es` as a hard answer or uses it for its own evaluation, syncing, or email-platform writes. Successful fresh profile reads refresh outcomes; cached or failed reads do not. The decoder and constants follow the browser codec and must change with that contract.

### Campaign arm ledger

`ca` is `{"v": 1, "r": [[campaignId, exposed, holdback], ...]}`, with at most 128 records. `decodeCampaignArms(context)` returns campaign ID → `holdback`. It skips malformed records and drops campaign IDs that are recorded more than once, as the browser does. The browser adds records only while they fit its cookie budget, so an absent record may still be an arm the browser holds. ### Test version ledger

`ab` is `{"v": 1, "r": [[testId:run, exposed, versionId], ...]}`, with at most 128 records; a longer ledger is ignored. `decodeTestVersions(context)` returns `testId:run` → version, with the tag's validity rules: a record needs exactly three items, a key matching `abt_[A-Za-z0-9]+:abr_[A-Za-z0-9]+` of at most 256 characters, a boolean exposed flag, and a version in `A`..`D`. A key recorded twice is dropped. The browser writes `ab` on exposure, inside the 1,200-character budget it shares with `ca`, so an absent record may still be a version the browser holds in local storage. A recorded version beats the hash; one the running test's weights lack leaves the version unknown.

### Assignment unit

`assignmentUnit(touchUnit, context)` returns the touch cookie's valid `u`, else `vid` when `ca` or `ab` decodes as a ledger, else null. Only a tag that mirrors ledgers writes either one, and it hashes the same visitor id it writes as `vid`. A context without a ledger may predate the mirror, so its `vid` is not used.

## `_rm`: link context

`_rm` is a query parameter, not a cookie, but it carries the same payload. A RightMessage link (a flow redirect or an offer link) adds it when the visitor leaves for another site. `decodeUrlContext(url)` decodes the first `_rm` value, which `URLSearchParams` has already URL-decoded, exactly as `_rm_ctx`: base64 substitutions reversed, strict UTF-8, JSON, `v: 1`. Anything else decodes as `{}`.

The edge reads only `dims`. Links sent before consent carry only `v`, `dims` and `vars` (data variables, which only the browser uses); `vid`, `cid`, `ca`, `ab` and the rest stay with the browser. `carriedDimensions(plan.dimensions, url)` accepts each carried dimension as the tag accepts one from a URL:

- A dimension the plan lacks is ignored. The plan carries every dimension a published rule references.
- A dimension with signals is accepted only when a question answers it (`asked: true`); otherwise its signals are evaluated fresh.
- Segment IDs outside the dimension are dropped. A non-array value leaves the dimension accepted with no segments.

With consent, each accepted dimension replaces that dimension's `_rm_ctx.dims` answers; every other `_rm_ctx` field and dimension is unchanged. Without required consent (below), a request with at least one accepted dimension is personalized from those answers alone.

## `__Host-rm_touch`: observed attribution

`decodeTouchCookie(header, queryNames)` and `observeTouchCookie(header, queryNames, location, referrer, firstPage?, pages?)` share this URI-encoded JSON contract:

```json
{"v":1,"q":{"source":["first value","last value"]},"r":"search.example","l":"/pricing","u":"AAAAAAAAAAAAAAAAAAAAAA"}
```

`u` is a 22-character base64url assignment unit (128 random bits), hashed for both arms and test versions. `admitRequest` (and so `personalizeResponse`) mints it with `mintHoldoutUnit()` only when the request has neither this cookie nor `_rm_ctx`, which identifies a visitor whose browser holds no arms or versions yet. It never mints one for a browser with `rm_exclude=1`, or without required consent. `observeTouchCookie(..., unit)` records it only when the cookie has no valid `u`, and never replaces one. The browser preserves `u` but never mints it. Writers serialize keys in `v, q, r, l, u` order. `l` is omitted when unknown, so a cookie without it stays byte-identical with the browser's `v, q, r, u` order. Invalid units are dropped on decode.

`l` is the first observed pathname, used to decide `pageviews` / `landingpage` rules. It is set only when the request has no `__Host-rm_touch` cookie: that pathname is the landing page. A cookie that already exists but has no `l` is not backfilled from the current URL. The value must be a pathname of at most 256 characters, starting with `/`, with no `?`, `#`, backslash, or control character; anything else is dropped and the landing page stays unknown. Browser tags before the field-preservation rule below rewrote this cookie from the keys they knew (`v`, `q`, `r`, `u`) and dropped `l`. After such a rewrite, landing-page leaves are unknown again until a cookieless request records a new `l`.

Only allowlisted query names are retained. Names are deduplicated and sorted; `_rm_ctx` and `_rm` are always excluded. Each retained value is a pair of strings. Duplicate current query parameters use their last decoded value. An observed empty string is a value, not absence. A first/last-touch name absent from the cookie has no observed pageview and matches no operator, including negative operators.

Optional retained browser pageviews seed missing names from their first and last observed values before the current URL is observed. Legacy query values normalize `+` and decode percent escapes once; pageviews marked `_queryValuesDecoded` are already decoded. Existing first-touch values are not replaced.

`r` contains only the first observed referrer hostname, never its path, query, or fragment. An own `r: ""` explicitly records a direct or same-host first touch and survives later referrers. Missing `r` means unobserved or evicted, so referrer rules remain unknown. Referrer URLs must be HTTP(S), and retained hostnames must be canonical valid hostnames. Same-host comparison is exact, not registrable-domain-wide.

The full encoded cookie name/value is bounded to **1,024 UTF-8 bytes**. Oversized incoming cookies are discarded. Writers evict whole query fields in reverse lexicographic name order, then the referrer, then the landing path, if necessary. The unit is not evicted.

**Field preservation.** The browser keeps every top-level field other than `v`, `q`, `r` and `u` as an opaque extra, in received order, and encodes `v, q, r, ...extras, u`. It evicts extras after `r`, last first, and never creates them. So an edge-only field must sit between `r` and `u` and tolerate eviction after `r`; then the browser preserves it without a lockstep release. `l` is the first such field, and `v, q, r, l, u` is byte-identical on both writers. The edge itself writes only the fields it owns. URI encoding makes written values ASCII, so this bound also holds for Unicode inputs. Retired allowlist names disappear on the next observation.

The returned observation is `{state, value, cookie, changed}`. `cookie` includes exactly `Secure; Path=/; SameSite=Lax`, with no Domain, HttpOnly, or persistent expiry. Its `__Host-` prefix makes it host-only, unlike `_rm_ctx`. A changed cookie is appended by the response integration; unchanged observations need no Set-Cookie. Responses carrying a new touch observation are private/no-store. Failed plan loads do not guess an allowlist or update the cookie.

The 1 KiB bound and pre-cookie history can cause temporary edge/browser disagreement. The browser corrects its own display using the ordinary personalization lifecycle.

## `rm_consent` and `rm_exclude`

The browser tag writes both on the registrable domain; the edge only reads them. A flag is set when the `Cookie` header has at least one `name=` entry and every such entry is exactly `1`. An empty value, any other value, or conflicting duplicates read as absent.

- **`rm_consent=1`** records the visitor's consent grant. A plan with `consent: "required"` (always `version: 2`) personalizes nothing without it: `admitRequest` returns `{ bypass: "consent" }`, no unit is minted, `observeTouchCookie` is not called, no Set-Cookie or private headers are added, and the response carries `x-rm-edge: bypass:consent`. `evaluatePlan` and `decide` also return nothing, for a caller that skips `admitRequest`. 0.1.x and 0.2.x reject a version 2 plan as `invalid-plan`, which also writes nothing.
  The one exception is a request whose [`_rm`](#_rm-link-context) carries an accepted dimension. The browser applies those answers before consent too, so the edge personalizes them with the tag's assignment off: every test renders version `A` (an Original test renders Control), every campaign renders its treatment arm, and deployed winners render. No cookie is read: `_rm_ctx`, `__Host-rm_touch` and `rm_exclude` are ignored, and the request is evaluated as a first page view from its URL and referrer. `admitRequest` returns that touch with `cookie: null`, no unit is minted, nothing is written, and a personalized response is private/no-store.
- **`rm_exclude=1`** marks a browser the site owner excluded from tests and stats. Consent is checked first, and a debug request takes precedence. Every campaign renders its treatment arm, every test renders version `A`, and deployed winners render. The touch cookie is observed for rule facts only: no unit is minted, and no cookie is written even when the observation changed.
