# caramel-extension

Plain-JS Manifest V3 browser extension (Chrome/Edge/Firefox; Safari is packaged in release CI from `dist/` via `safari-web-extension-converter` — no in-repo Xcode project, see `.github/workflows/release-extension.yml`) — **no bundler**, every file loads verbatim as listed in `manifest.json` (Chrome/Edge) / `manifest-firefox.json` (Firefox).

**Setup:** root [README.md](../../README.md)'s Getting Started. This extension has no `.env` of its own.

Commands (from `apps/caramel-extension`, or prefix with `pnpm --filter caramel-extension` from the repo root):

| Command            | Does                                                                      |
| ------------------ | ------------------------------------------------------------------------- |
| `pnpm dev`         | Loads the extension into a `web-ext`-managed Chromium, live-reloading     |
| `pnpm build`       | Copies the allowlist in `scripts/build-dist.mjs` into `dist/` — see below |
| `pnpm package`     | Zips `dist/` into `extension.zip`                                         |
| `pnpm test`        | Unit tests (vitest)                                                       |
| `pnpm test:e2e`    | Real Chromium + the local app (`scripts/test-extension.mjs`)              |
| `pnpm test:guards` | Real Chromium + a production store config (`scripts/test-guards.mjs`)     |
| `pnpm size`        | Per-bundle byte budgets (`.size-limit.json`)                              |

## What ships

`pnpm build` copies an explicit **allowlist** (`scripts/build-dist.mjs`), not "everything minus a few excludes". The old rsync blacklist put `package.json`, the lint/knip/size configs, `tests/`, `scripts/` and ~400 KB of unreferenced brand art into the store package. `tests/package-contents.test.mjs` derives the requirement from the manifests and `index.html`, so adding a file to the extension and forgetting the allowlist is a red test rather than a broken release.

Firefox ships that **same** `dist/`: release CI copies it to `dist-firefox/` and swaps `manifest-firefox.json` in as `manifest.json`. The allowlist deliberately keeps the Firefox manifest out of `dist/` (it is in `NEVER_SHIP`), so the two manifests can never ship in one package. `release-extension.yml`'s `publish_firefox` job then signs that directory with `web-ext sign --channel=listed` and submits it to addons.mozilla.org — the version is queued for Mozilla review, which is the one manual step left. That job stays dormant, loudly and green, until the `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` repository secrets exist.

To check the packaged output rather than the source tree:

```sh
pnpm build && CARAMEL_EXT_DIR=./dist pnpm test:guards
```

## How the extension gets tested

Three tiers, deliberately not overlapping:

| Tier                 | Covers                                                                                                    | Cannot cover                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm test` (vitest) | Pure logic, DOM helpers, verdict/savings math, manifest and package invariants                            | Anything needing layout, a service worker, OAuth |
| `pnpm test:guards`   | The real content-script bundle in real Chromium: apply loop, both strategies, the injected UI, the guards | Real sign-in, a real store's live markup         |
| `pnpm test:e2e`      | The extension against a locally-booted `caramel-app` with a real Postgres                                 | Store-side behaviour                             |

The guards suite runs **both** apply strategies, which are genuinely different code paths: the DOM form (config selectors, Magento-class) and the discount-link capability path (`/cart.js` + `/discount/{code}`, Shopify-class — the one most supported stores take, and the only path that reloads the page mid-flow). It also pins late-reveal re-detection (S8): a checkout whose promo entry is inserted only after a user action must stay dark until then and prompt the moment the field appears — the exact shape of Shopify Checkout One's collapsed order summary, where this flow won a store-confirmed $9.00 live on 100percentpure.com (2026-08-05).

### Interactive debugging with an agent

For anything the suites structurally can't reach — real Google/Apple sign-in, `chrome.identity.launchWebAuthFlow`, clicking the actual toolbar icon, poking at a live store — use the **`chrome-devtools` MCP server**, registered at user scope:

```
npx -y chrome-devtools-mcp@1.6.0 --categoryExtensions=true --experimentalIncludeAllPages=true
```

`--categoryExtensions` is **off by default**; it unlocks `install_extension`, `list_extensions`, `reload_extension`, `trigger_extension_action` and `uninstall_extension`. Two constraints worth knowing before you plan around it:

- It only works over a **pipe connection**, so the server launches its own Chrome. `--browserUrl` / `--wsEndpoint` / `--autoConnect` are unsupported until Chrome 149. That is a feature here: it uses its own profile (`~/.cache/chrome-devtools-mcp/chrome-profile`) and can never touch your personal Chrome or the shared Stealth master profile.
- OAuth needs headed mode (the default) and a **stable extension ID**, since the callback lands on `https://<extension-id>.chromiumapp.org/*`.

Anything you discover that way belongs back in `scripts/test-guards.mjs` as a scenario — the MCP is for exploration, not for coverage.

## Byte budgets

`.size-limit.json` caps each bundle. The injected content-script budget moved 106 → 124 → **126 KB** on 2026-08-04: first for the bad-config safety guards (`4c7466a..4660064`), then for the multi-price post-apply total read and the shadow-CSS fetch timeout. All of it is correctness code proved necessary in a real browser — raise the budget rather than trim it, and say why here.

**Manual load-unpacked** (no `web-ext`): `chrome://extensions` → enable Developer mode → **Load unpacked** → select `apps/caramel-extension`.

Content-script constants shared with `caramel-app` are generated — regenerate via `pnpm --filter caramel-app generate:coupon-constants`, never hand-edit `coupon-constants.generated.js`. Safari icon generation is CI-only — see the root README's Safari Extension Icons section.
