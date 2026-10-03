# Cookie wire contracts

These cookies are best-effort first-party display inputs, not authentication, an authorization boundary, a consent policy, or a synchronized visitor ledger. The browser remains authoritative and can replace an edge result when its own current evaluation disagrees.

## `_rm_ctx`: browser context

`decodeContextCookie(cookieHeader)` reads the first `_rm_ctx` entry, URI-decodes it, reverses the browser's base64 substitutions (`-` → `+`, `_` → `/`, `~` → `=`), strictly decodes UTF-8, and parses JSON. Missing, malformed, invalid UTF-8, or non-version-1 payloads return `{}`. The decoder preserves version-1 fields rather than imposing a second browser schema.

Relevant fields are `v: 1`, `dims` (dimension IDs to answered segment arrays), `cid` (contact identity), `identityScope: {project, connection}`, and optional `es` (recorded outcomes). A dimension absent from `dims` is unanswered. The browser writes answers synchronously and flushes pending context writes before navigation.

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

## `__Host-rm_touch`: observed attribution

`decodeTouchCookie(header, queryNames)` and `observeTouchCookie(header, queryNames, location, referrer, firstPage?, pages?)` share this URI-encoded JSON contract:

```json
{"v":1,"q":{"source":["first value","last value"]},"r":"search.example"}
```

Only allowlisted query names are retained. Names are deduplicated and sorted; `_rm_ctx` is always excluded. Each retained value is a pair of strings. Duplicate current query parameters use their last decoded value. An observed empty string is a value, not absence. A first/last-touch name absent from the cookie has no observed pageview and matches no operator, including negative operators.

Optional retained browser pageviews seed missing names from their first and last observed values before the current URL is observed. Legacy query values normalize `+` and decode percent escapes once; pageviews marked `_queryValuesDecoded` are already decoded. Existing first-touch values are not replaced.

`r` contains only the first observed referrer hostname, never its path, query, or fragment. An own `r: ""` explicitly records a direct or same-host first touch and survives later referrers. Missing `r` means unobserved or evicted, so referrer rules remain unknown. Referrer URLs must be HTTP(S), and retained hostnames must be canonical valid hostnames. Same-host comparison is exact, not registrable-domain-wide.

The full encoded cookie name/value is bounded to **1,024 UTF-8 bytes**. Oversized incoming cookies are discarded. Writers evict whole query fields in reverse lexicographic name order, then the referrer if necessary. URI encoding makes written values ASCII, so this bound also holds for Unicode inputs. Retired allowlist names disappear on the next observation.

The returned observation is `{state, value, cookie, changed}`. `cookie` includes exactly `Secure; Path=/; SameSite=Lax`, with no Domain, HttpOnly, or persistent expiry. Its `__Host-` prefix makes it host-only, unlike `_rm_ctx`. A changed cookie is appended by the response integration; unchanged observations need no Set-Cookie. Responses carrying a new touch observation are private/no-store. Failed plan loads do not guess an allowlist or update the cookie.

The 1 KiB bound and pre-cookie history can cause temporary edge/browser disagreement. The browser corrects its own display using the ordinary personalization lifecycle.
