# Contributing

Use Node.js 20 or newer. Clone the repository, run `npm ci`, then `npm run typecheck`, `npm run lint`, `npm test` and `npm run build`. Tests execute native Workers HTMLRewriter under Miniflare as well as the optional Node WASM adapter. Keep CI changes compatible with Node 20, 22 and 24.

Open an issue before changing the public plan, cookie or receipt contracts. Preserve published action order, unknown rule outcomes and exact original bytes on failure. Include a regression test for a consumer-visible behavioral change and update CHANGELOG.md. Use synthetic fixtures without personal data or credentials.

## Publishing (maintainers)

The release workflow is intentionally gated by the repository variable `NPM_PUBLISH_ENABLED=true`. To publish after the npm organization exists:

1. Create or claim the public `@rightmessage/edge` package and configure an npm trusted publisher for GitHub organization `rightmessage`, repository `edge`, workflow `release.yml` (no environment). For a first publication requiring a token, set the repository secret `NPM_TOKEN` to a narrowly scoped npm automation/granular token with publish access.
2. Set `NPM_PUBLISH_ENABLED` to `true` only when publication is authorized.
3. Run the Release workflow manually against tag `v0.1.0`; later `v*` tags trigger it automatically. Keep package.json and tag versions aligned.
4. Confirm the public package and provenance on npm. OIDC is preferred; `NPM_TOKEN` is the fallback.

The workflow uses npm 11.5 or newer and `npm publish --provenance --access public`. Do not publish from local development.
