# caramel-extension

Manifest V3 browser extension (Chrome/Edge/Firefox; Safari is packaged in release CI via `safari-web-extension-converter` — no in-repo Xcode project, see `.github/workflows/release-extension.yml`), built with **WXT**. The manifest is generated from `wxt.config.ts`; the source modules are plain-JS ESM composed by the entrypoints under `entrypoints/`.

**Setup:** root [README.md](../../README.md)'s Getting Started. This extension has no `.env` of its own.

Commands (from `apps/caramel-extension`, or prefix with `pnpm --filter caramel-extension` from the repo root):

| Command              | Does                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `pnpm dev`           | WXT dev mode: loads the extension into its own Chromium, live-reloading   |
| `pnpm build`         | `wxt build` → `.output/chrome-mv3/` (production stamp — the default)      |
| `pnpm build:dev`     | `wxt build --mode development` → `.output/chrome-mv3-dev/` (dev stamp)    |
| `pnpm build:firefox` | `wxt build -b firefox --mv3` → `.output/firefox-mv3/`                     |
| `pnpm package`       | `wxt zip` — zips the production build for store upload                    |
| `pnpm test`          | Unit tests (vitest)                                                       |
| `pnpm test:parity`   | Manifest/inventory/env-stamp gate vs the frozen 1.3.1 goldens (see below) |
| `pnpm test:smoke`    | Static checks on a built package (`scripts/smoke-package.mjs`)            |
| `pnpm test:e2e`      | Real Chromium + the local app (`scripts/test-extension.mjs`)              |
| `pnpm test:guards`   | Real Chromium + a production store config (`scripts/test-guards.mjs`)     |
| `pnpm size`          | Per-bundle byte budgets (`.size-limit.json`)                              |

## What ships

WXT packages exactly what the entrypoints import plus `public/` (icons, popup/​shadow-UI assets) — there is no hand-maintained allowlist anymore. The two incident classes the old allowlist build existed to prevent are pinned by `scripts/parity-harness.mjs` instead:

- **Tooling files in the store package** — the harness walks every `.output` build and fails if any `NEVER_SHIP` name (package.json, tests/, scripts/, configs, `manifest-firefox.json`, …) reaches a package.
- **A store build stamped dev** — see below.

The harness also diffs each generated manifest against the **frozen 1.3.1 golden manifests** (`scripts/parity-golden-*.json`): every difference must be listed in `scripts/parity-expected-diffs.json` with a reason, unlisted diffs fail, and stale allowlist entries fail too.

Firefox is its own WXT target (`pnpm build:firefox`) — the old copy-dist-and-swap-manifests step died with the hand-rolled build. `release-extension.yml`'s `publish_firefox` job signs the built directory with `web-ext sign --channel=listed` and submits it to addons.mozilla.org — the version is queued for Mozilla review, which is the one manual step left.

### Which deployment a build talks to

Decided at **build time** by the `__CARAMEL_ENV__` define (`wxt.config.ts` and `vitest.config.mjs`, both fed by `scripts/environments.mjs` — the single environment table), inlined into `caramel-env.js`, the first module every context imports. Default is **production**; `--mode development` stamps the dev deployment. The asymmetry is deliberate: the failure being prevented is a shipped build quietly talking to dev, whereas a local build talking to prod is a thing a developer chose with the flag right there in the command.

This replaced a runtime guess — "no `update_url` in the manifest means an unpacked dev install" — which only Chrome Web Store installs satisfy. Firefox/AMO uploads and the converted Safari build carry no `update_url` either, so both **shipped** pointing real users at dev. `tests/env-stamp.test.mjs` pins the module contract; `scripts/parity-harness.mjs` pins the built output: a production build carries the production baseUrl and zero dev origins in any shipped `.js`, and no shipped code branches on `update_url`/`_isDevInstall`.

To check a packaged output rather than the source tree:

```sh
pnpm build:dev
pnpm test:guards   # defaults to .output/chrome-mv3-dev (auto-builds if absent)
```

Development-stamped on purpose: several guard checks assert on the extension's own diagnostic markers (`AUTO_INSERT_*`), and a production build prints nothing anywhere. Point the suite at a production package and it says so and exits rather than failing three checks for an unexplained reason.

## How the extension gets tested

Three tiers, deliberately not overlapping:

| Tier                 | Covers                                                                                                    | Cannot cover                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm test` (vitest) | Pure logic, DOM helpers, verdict/savings math, env-stamp module contract                                  | Anything needing layout, a service worker, OAuth |
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

**Manual load-unpacked** (no WXT dev server): `pnpm build:dev`, then `chrome://extensions` → enable Developer mode → **Load unpacked** → select `apps/caramel-extension/.output/chrome-mv3-dev`.

Content-script constants shared with `caramel-app` are generated — regenerate via `pnpm --filter caramel-app generate:coupon-constants`, never hand-edit `coupon-constants.generated.js`. Safari icon generation is CI-only — see the root README's Safari Extension Icons section.
