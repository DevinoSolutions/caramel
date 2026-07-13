# caramel-extension

Plain-JS Manifest V3 browser extension (Chrome/Edge/Firefox; Safari wrapper in `apple-extension/`, see the root README's Project layout) — **no bundler**, every file loads verbatim as listed in `manifest.json` (Chrome/Edge) / `manifest-firefox.json` (Firefox).

**Setup:** root [README.md](../../README.md)'s Getting Started. This extension has no `.env` of its own.

Commands (from `apps/caramel-extension`, or prefix with `pnpm --filter caramel-extension` from the repo root):

| Command                       | Does                                                                  |
| ----------------------------- | --------------------------------------------------------------------- |
| `pnpm dev`                    | Loads the extension into a `web-ext`-managed Chromium, live-reloading |
| `pnpm build`                  | Rsyncs source into `dist/` (excludes tests/tooling)                   |
| `pnpm package`                | Zips `dist/` into `extension.zip`                                     |
| `pnpm test` / `pnpm test:e2e` | Unit tests (vitest) / e2e (`scripts/test-extension.mjs`)              |

**Manual load-unpacked** (no `web-ext`): `chrome://extensions` → enable Developer mode → **Load unpacked** → select `apps/caramel-extension`.

Content-script constants shared with `caramel-app` are generated — regenerate via `pnpm --filter caramel-app generate:coupon-constants`, never hand-edit `coupon-constants.generated.js`. Safari icon generation is CI-only — see the root README's Safari Extension Icons section.
