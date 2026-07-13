# PLAN-F-004 — No test suite exists; `pnpm test` is false-green

**Finding:** F-004 (High, testing) · **Effort:** L · **Wave:** 1 · **Sequence:** 1 (nothing lands before this) · **Depends-on:** none.

## Executive summary

Stand up a real **Vitest 4** unit baseline in both packages, wire `test` into each package + turbo + CI, and write characterization pins that lock CURRENT behavior (warts included) on exactly the surfaces later fixes touch. ~11 files (2 configs, 5–6 test files, 2 package.json, 2 workflows). **Breaking: N** (tooling only; no src runtime change). Riskiest step: getting `next/server` (`NextRequest`) + the extension's read+eval-in-jsdom trick to run identically on Windows dev and CI ubuntu.

Premises verified in-code: root `test`→`turbo run test`, `turbo.json:15` `test:{}`, and **no package defines `test`** → true no-op (false-green confirmed). Vitest 4 default `passWithNoTests`=disabled → **`vitest run` exits 1 on zero test files** (satisfies "fail when zero tests"). Playwright is isolated in `apps/caramel-app/e2e/*.spec.ts` (`playwright.config.ts` testDir `./e2e`) — vitest must not grab it.

## Scope

**Create:**

- `apps/caramel-app/vitest.config.ts` — `environment:'node'`, `plugins:[tsconfigPaths()]`, `include:['tests/unit/**/*.test.ts']`, `exclude:[...configDefaults.exclude,'e2e/**','**/*.eval.*']`.
- `apps/caramel-app/tests/unit/decryptJsonData.test.ts`
- `apps/caramel-app/tests/unit/rateLimit.test.ts`
- `apps/caramel-app/tests/unit/coupons-visibility.test.ts`
- `apps/caramel-extension/vitest.config.mjs` — `environment:'jsdom'`, `include:['tests/**/*.test.mjs']`.
- `apps/caramel-extension/tests/_load.mjs` (shared: chrome stub + read+eval of a source file) and `apps/caramel-extension/tests/shared-utils.test.mjs`.
- (optional/stretch) `apps/caramel-extension/tests/background.test.mjs`.

**Modify:**

- `apps/caramel-app/package.json` — add `"test":"vitest run"`, `"test:watch":"vitest"`; devDeps `vitest ^4.1`, `vite-tsconfig-paths ^5` (caret — repo convention; F-014 pins later).
- `apps/caramel-extension/package.json` — add `"test":"vitest run"`, devDep `vitest ^4.1` (jsdom `^29.0.2` already present); add `--exclude='tests'` `--exclude='vitest.config.*'` to the `build` rsync so the new files don't ship.
- `.github/workflows/checks-app.yml` — add `"unit"` to `test-matrix` `task` array + case branch `unit) pnpm test ;;`.
- `.github/workflows/checks-extension.yml` — add step `- name: Run unit tests` / `run: pnpm run test` after prettier-check.
- `turbo.json` (`test:{}`) and root `package.json` (`test:"turbo run test"`) already correct — **no edit**; they light up once packages define `test`.

**Out of scope:** husky/oxlint/knip/size-limit (F-009); branch protection (F-009); fixing ANY pinned wart (F-002/F-003/F-006/F-008); `*.eval.ts` eval files (F-012); package rename `caramel-landing`→`caramel-app` — use CURRENT name `caramel-landing` in all configs/filters (F-015); dep pinning caret→exact (F-014); React-component/coverage expansion; DD2-12 build-glob hygiene beyond the two files created here.

## Approach (alternatives rejected)

Vitest 4, one testing tool, per-package configs (fits turbo's existing per-package fan-out; v4 `projects` unneeded since app=`node`, ext=`jsdom` split cleanly by package). `@/*` alias via **vite-tsconfig-paths** (reads the existing tsconfig `paths` — single source, one way).

- **Convert shared-utils.js/background.js to ESM `import`** — rejected: bundler/module conversion is F-008's territory and even F-008 stays bundler-free. Reuse the shipped **read-file + `(0,eval)` in jsdom** trick (`test-extension.mjs:209-250`).
- **happy-dom** — rejected: jsdom already a devDep and the working reference is jsdom-shaped.
- **jest** — rejected: no jest in repo; Vitest is Vite-native, ESM/TS OOTB.
- **Export `isExtensionClient` to test directly** — rejected: keep it private, pin via public `checkRateLimit` (behavior not internals).
- **Pin composed SQL via a live coupons DB** — rejected: no coupons DB in unit/CI. Mock `couponsSql` as a **recording tagged-template spy** (driver-independent); assert the literal predicate strings each route composes.

## Sequencing (each step ends with its check)

1. Add app devDeps + `vitest.config.ts` + `"test"` script. **Check:** `pnpm --filter caramel-landing test` exits **1** with "No test files found" (proves wiring + zero-tests-fails).
2. Write the 3 app pins (below). **Check:** `pnpm --filter caramel-landing test` green; each asserts current (warty) behavior.
3. Extension `vitest.config.mjs` + `tests/_load.mjs` + `"test"` script + `shared-utils.test.mjs`. **Check:** `pnpm --filter caramel-extension test` green (`_isXPath`, `getPrice`).
4. (optional) `background.test.mjs`. **Check:** green, OR documented-skip if top-level load throws despite stubs (defer that one pin to F-002).
5. Root `pnpm test`. **Check:** turbo executes **2** tasks — the "No tasks were executed" no-op is gone.
6. CI edits. **Check:** both workflows parse; `unit` matrix leg + extension step render.
7. **Gate-bites proof:** flip one pin's expected value → confirm `pnpm test` goes **red**; revert. (Local only; not committed.)

## Test strategy — characterization pins FIRST (the pins ARE the deliverable)

App (`environment:'node'`; `NextRequest` from `next/server` works on Node 20 web globals):

- **decryptJsonData** (`securityHelpers/decryptJsonData.ts:20-22`): `vi.mock('./cryptoHelpers')`. Pin (a) `NEXT_PUBLIC_API_ENCRYPTION_ENABLED!=='true'` → returns unwrapped `pageData??response??raw`; (b) enabled + no keys → returns raw; (c) **enabled + `decryptJsonClient` throws → returns raw ciphertext** (the wart F-002 flips).
- **rateLimit** (`rateLimit.ts:56-63,91`): set `EXTENSION_API_KEY`, use unique `x-real-ip` per test (module-singleton limiters). Pin (a) matching `x-api-key` stays `null` across **25 rapid calls** (extension exemption bypasses the 20/2s burst); (b) same header via `x-extension-api-key` also `null` (back-compat); (c) **no key, same IP, >20 calls/2s → returns a 429 NextResponse** (contrast that F-003 changes).
- **coupons-visibility** (`coupons/route.ts:48`, `filters/route.ts:20,28`, `stats/route.ts:15`): `vi.mock('@/lib/couponsDb')` → `couponsSql` = recording tag returning a thenable `[]` (records `strings.join('?')` per call); `vi.mock('@/lib/rateLimit',()=>({checkRateLimit:async()=>null}))`. `await GET(new NextRequest(url))` → 200; assert captured strings **contain the exact current (drifted) predicates**: coupons = 7-status `status IN ('valid','valid_with_warning','product_restriction','category_restricted','seller_specific','pending','retry') AND expired = FALSE`; filters = `'valid'`-only `... AND expired = FALSE AND site IS NOT NULL`; stats = `WHERE status = 'valid'` with **no `expired = FALSE`** in the WHERE. This pins the 3-way drift F-006 unifies (F-006 will intentionally update these pins).

Extension (`environment:'jsdom'`; `tests/_load.mjs`: permissive Proxy `globalThis.chrome` stub — reuse shape at `test-extension.mjs:238-248` — then `readFileSync` + `(0,eval)(src + ';globalThis.__su={ getPrice,_isXPath };')` so hoisted decls are captured deterministically, not via global leakage):

- **`_isXPath`** (`shared-utils.js:233`, pure): `'//input'`→true, `'(//div)[2]'`→true, `'./x'`→true, `'input#code'`→false, `''`/non-string→false.
- **`getPrice`** (`:203`, price parsing F-008 splits): build a node, **set BOTH `textContent` and `innerText`** (`getPrice` reads `el.innerText`, unreliable in jsdom without explicit set); pin `'$100.00'`→`100`, multi-price default→first, `{returnLargest:true}`→max, no-match→`NaN`. (`_hostMatchesDomain`/`setInputValue` may be added if trivially pure.)
- (optional) **background empty-success** (`background.js:193,211`): stub `fetch`→`{ok:false,status:500}`, capture the `chrome.runtime.onMessage` handler, invoke with `{action:'fetchCoupons'}` + `sendResponse` spy → assert `{coupons:[]}` (and `{supported:[]}` for `fetchSupportedStores`). Pins F-002's shaping IF load survives the stubs.

"**Green**" at every checkpoint = all new pins pass asserting CURRENT behavior (warts and all). Later fixes edit their own pins as they change behavior — that edit is the protection this baseline provides.

## Breaking changes

None at runtime. `pnpm test` transitions from no-op-exit-0 to actually running suites (and failing on real failures) — any automation that relied on the green no-op will now truly test; that is the intended fix, not a regression. CI gains a `unit` leg (advisory until branch protection lands in F-009). No consumer of any module changes.

## Rollback

One commit: `fix(F-004): vitest baseline + characterization pins + CI unit job`. Internal checkpoints = the 7 steps, each independently green, so a failed later step restarts without losing earlier pins (final still squashes to one commit per audit rule). Revert = delete the created configs/tests and undo the package.json/workflow edits; no data/schema/runtime surface touched.

## Risk

Blast radius = build/test tooling only; zero `src` runtime change. **Worst case:** vitest↔`next/server` interop or the jsdom eval-load misbehaves on one OS. **Early-warning signs & mitigations:** (1) Node **<20.19** (Vite 7 floor) → if CI `node-version:20` resolves below, bump to `20.19`/`22`. (2) `next/server` import fails under node env → confirm Node 20 provides `Request`/`Response` (it does via undici); no plugin needed. (3) jsdom `innerText` empty → getPrice pin sets it explicitly (already specified). (4) top-level function decls don't surface after eval → mitigated by the appended `globalThis.__su={…}` capture. (5) vitest4↔jsdom29 incompat → align jsdom to a vitest-4-supported range if the env fails to boot. **Verified-in-code:** false-green no-op, decrypt wart, 3-route SQL drift, rateLimit exemption, extension eval trick, background shaping, CI matrix conventions. **Assumed (flagged above):** vitest4/jsdom29 compat; `next/server` under vitest node env.
