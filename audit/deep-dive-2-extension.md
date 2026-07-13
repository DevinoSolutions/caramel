# Deep Dive DD-2 — `apps/caramel-extension/**` (background/popup/shared-utils/manifests/tests)

caramel @ `537547b3081aa3a0ec817cdc5f6dac4f0d328dbb` (dev). Read-only on tracked files. Priorities: (1) maintainability — modularity, dedup, clarity, conventions; (2) operability. Security arch accepted; no security findings below (none found that qualify as a regression).

## Architecture sketch

- **3 execution realms share global scope, zero module system.** `manifest.json` injects `cart-signals.js → shared-utils.js → UI-helpers.js → inject.js` (in that order) into every `https://*/*` page as one isolated-world realm; `index.html` (popup) _separately_ loads `shared-utils.js → UI-helpers.js → popup.js` as plain page scripts. The same 1537-line shared-utils.js runs in both, though the popup only ever calls `fetchCoupons`/`_isDevInstall`-adjacent helpers.
- **background.js** (MV3 service worker on Chrome, MV2 script on Firefox) is the only fetch-capable layer (CORS); content scripts and the popup relay every network call through `runtime.sendMessage`, each inventing its own ad-hoc response shape.
- **Auth bridge:** grabcaramel.com `window.postMessage`s a token into the content-script realm (origin-gated by `CARAMEL_ALLOWED_ORIGINS`), written to `chrome.storage.sync`; popup and content scripts each read that storage independently, with no shared accessor.
- **Apply flow:** `inject.js` → `startCheckoutDetection()` → `getDomainRecord()` (API-backed store config, locally cached) → `startApplyingCoupons()` (348-line loop with early-exit/discount-link/DOM-fallback branches) → per-code `applyCoupon()` (255-line DOM event-dispatch + signal-polling).
- **3 publish targets diverge:** Chrome (CI-built/zipped/uploaded) and Safari/iOS/macOS (CI xcodebuild) are automated in `release-extension.yml`; Firefox's manifest is not built, linted, or published by any CI job in this repo.

## onMessage handler map (`background.js`)

| Action                                      | Location                | `return true`?     | `sendResponse` on every path?              | Honesty / failure-mode notes                                                                                                                                                                                                               |
| ------------------------------------------- | ----------------------- | ------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _(malformed: missing/non-string `.action`)_ | `background.js:140`     | No (bare `return`) | **No**                                     | Not reachable by any caller in this repo today (every `sendMessage` call site sends a valid string `action`); if ever hit, the caller's `sendMessage` resolves `undefined` (Chrome does not hang the promise), not a hang. Defensive-only. |
| `openPopup`                                 | `background.js:141-151` | No (sync)          | Yes                                        | Fire-and-forget `windows.create`; ack sent before the popup window exists.                                                                                                                                                                 |
| `userLoggedInFromPopup_<tabId>`             | `background.js:152-157` | No (sync)          | Yes                                        | `tabs.sendMessage(parseInt(callerId), ...)` has no callback/`lastError` check — if the origin tab was closed, the error is silently dropped.                                                                                               |
| `keepAlive`                                 | `background.js:158-159` | No (sync)          | Yes                                        | Trivial ack; unrelated to the real `keepAlive()` alarm mechanism (see DD2-14).                                                                                                                                                             |
| `classifyCart`                              | `background.js:160-176` | Yes                | Yes (chain always settles, final `.catch`) | Honest: real errors surface as `{error}`.                                                                                                                                                                                                  |
| `fetchCoupons`                              | `background.js:177-204` | Yes                | Yes                                        | **`!r.ok` silently returns `{coupons: []}`** — see DD2-1. Only a network-level throw gets `{coupons:[], error}`.                                                                                                                           |
| `fetchSupportedStores`                      | `background.js:205-220` | Yes                | Yes                                        | Same pattern: HTTP failure → `{supported: []}`, no error field. See DD2-1.                                                                                                                                                                 |
| `getActiveTabDomainRecord`                  | `background.js:221-269` | Yes                | Yes (all 3 sub-branches covered)           | `domainRecord` is hardcoded `null` on **every** path — dead field, see DD2-8.                                                                                                                                                              |
| _(unknown action)_                          | `background.js:270-273` | No (sync)          | Yes                                        | Honest `{error:'unknown_action'}`.                                                                                                                                                                                                         |

Refuting one nomination precisely: popup.js has **18** `await` expressions and **5** `catch` blocks (0 `.then(`), not "30+ vs 9" — but the raw ratio overstates the gap, since 4 of the 5 catches each wrap an entire multi-await flow (`initPopup`, `handleSocialSignIn`, the login-form submit handler), not one await apiece. The real residual issues are captured in DD2-6 (silent storage-error swallowing) and DD2-8 (no shared response envelope), not "uncaught awaits."

## Findings

```json
[
    {
        "id": "DD2-1",
        "location": "apps/caramel-extension/background.js:191-202",
        "quote": "fetchWithTimeout(url.toString())\n    .then(async r => {\n        if (!r.ok) return { coupons: [] }\n        const json = await r.json()\n        return {\n            coupons: Array.isArray(json)\n                ? json\n                : json.coupons || [],\n        }\n    })\n    .then(resp => sendResponse(resp))\n    .catch(err => sendResponse({ coupons: [], error: String(err) }))",
        "what": "When the coupons API returns any non-2xx status (500, 502, 429, auth failure, etc.), fetchCoupons resolves `{coupons: []}` with no error field at all — identical to the honest 'this store genuinely has zero coupons' response. The same pattern repeats verbatim in fetchSupportedStores (background.js:205-220, `if (!r.ok) return { supported: [] }`). Only a network-level throw (DNS failure, timeout, CORS) reaches the `.catch` and gets an `error` key; an HTTP error response never does, because the early `return` inside the first `.then` intercepts it before the chain ever reaches `.catch`.",
        "why_it_matters": "The popup and the in-page prompt both render 'No coupons for this site yet' / 'No codes for this store just yet' off this exact shape (popup.js renderUnsupportedSite, shared-utils.js startApplyingCoupons) — a backend outage or a bad deploy is presented to the user as a factual claim about store's coupon inventory. This is the extension's core value proposition (honest, non-dark-pattern coupon finding) lying by construction on the one code path most likely to fire during a real incident, and it's silent to the developer too — no error is logged anywhere for this branch.",
        "severity": "Critical",
        "confidence": 0.95,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "On `!r.ok`, return `{coupons: [], error: 'HTTP '+r.status}` / `{supported: [], error: ...}` (mirroring classifyCart's own pattern one branch away in the same file) and have callers render a distinct 'couldn't check right now' state instead of collapsing it into the empty-inventory copy.",
        "effort": "S",
        "category": "error-handling"
    },
    {
        "id": "DD2-2",
        "location": "apps/caramel-extension/index.html:61-63",
        "quote": "<script src=\"shared-utils.js\"></script>\n<script src=\"UI-helpers.js\"></script>\n<script src=\"popup.js\"></script>",
        "what": "shared-utils.js (1537 lines) bundles at least six distinct responsibilities with no internal boundary: generic DOM waiters/selector-matching (qOne/qAll/waitForVisible/pickBestMatch, ~190 lines), store-config fetch+cache+domain-matching (getDomainRecord/_hostMatchesDomain, ~100 lines), checkout detection via MutationObserver (isCheckout/startCheckoutDetection, ~150 lines), the coupon-apply DOM automation engine (applyCoupon alone is 255 lines, startApplyingCoupons is 348 lines — 40% of the file in two functions), coupon-list fetch/cart-classification (fetchCoupons/classifyCartCategory/getCoupons), and a cross-realm auth-token bridge (the `window.addEventListener('message', ...)` + onMessage listener at the file's bottom). manifest.json injects the whole file into every web page as a content script; index.html (quoted above) additionally loads the entire same file into the popup, which per its own source (popup.js) only ever calls fetchCoupons and reads `_isDevInstall`/`caramelUrl`-adjacent globals — none of the checkout-detection, DOM-apply, or MutationObserver code is ever invoked in that context, yet it all parses and holds memory there.",
        "why_it_matters": "Violates 'every module understandable in isolation': a reader opening shared-utils.js to change one thing (e.g. price parsing) must first mentally filter out five unrelated subsystems. It also means the popup — the simplest, most latency-sensitive surface in the extension — pays the parse/memory cost of the entire cross-site DOM-automation engine it will never execute, and any bug introduced anywhere in that engine is one edit away from being loaded into a context that has no way to exercise or catch it.",
        "severity": "High",
        "confidence": 0.9,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "Split shared-utils.js along the six seams above into separate files (e.g. dom-utils.js, store-config.js, checkout-detect.js, coupon-apply.js, coupon-fetch.js, auth-bridge.js); give the popup its own minimal manifest/script list that only pulls in store-config.js + coupon-fetch.js.",
        "effort": "L",
        "category": "modularity"
    },
    {
        "id": "DD2-3",
        "location": "apps/caramel-extension/shared-utils.js:1154-1160",
        "quote": "log('AUTO_INSERT_STOP', { result: 'no-domain-record' })\n        showFinalModal(0, null, \"We don't have codes for this store yet.\")\n        return\n    }\n    log('AUTO_INSERT_START', { domain: rec.domain, t: performance.now() })\n    _caramelCancelled = false\n    await showTestingModal()",
        "what": "shared-utils.js calls showFinalModal, showTestingModal, updateTestingModal, and hideTestingModal throughout (e.g. lines 1155, 1160, 1231, 1309) — none of them declared, imported, or even JSDoc-annotated (`/* global */`) anywhere in the file; they are defined in the sibling file UI-helpers.js and reachable only because manifest.json's content_scripts array happens to load both into the same realm. The coupling runs both directions: UI-helpers.js's showTestingModal sets `_caramelCancelled = true` on its close button (UI-helpers.js:109) and Escape handler (:115), a variable declared and read only in shared-utils.js (:1146, :1159, :1223, :1350). Contrast cart-signals.js, the one file in the set that namespaces itself correctly (`window.CaramelCartSignals = {...}`, cart-signals.js:183-188) and needs no such implicit contract. popup.js at least partially documents its cross-file globals (`/* global currentBrowser, fetchCoupons */`, popup.js:1); shared-utils.js and UI-helpers.js have no such annotation at all.",
        "why_it_matters": "A reader (human or model) opening shared-utils.js or UI-helpers.js in isolation hits calls/writes to identifiers that don't exist in that file, with no comment pointing at the sibling file that defines them — the only way to resolve them is to already know to grep the whole extension folder. This is the concrete, repeated instance of 'every module understandable in isolation' failing: the dependency is real and load-bearing (a manifest reorder or a lone-file dynamic injection would silently break it) but is expressed nowhere except the accident of script-tag order.",
        "severity": "High",
        "confidence": 0.88,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "Adopt cart-signals.js's own pattern consistently: namespace each file's public surface under one window object (`window.CaramelUI`, `window.CaramelCore`) and reference through that, or at minimum add `/* global */` annotations everywhere the pattern in popup.js already exists so the dependency is at least documented.",
        "effort": "M",
        "category": "encapsulation"
    },
    {
        "id": "DD2-4",
        "location": "apps/caramel-extension/scripts/test-extension.mjs:29,79-84",
        "quote": "const API_BASE = 'http://localhost:58000'\n...\n        const baseUrl = await sw.evaluate(() => globalThis.CARAMEL_BASE_URL)\n        log(\n            'dev-mode URL switch',\n            baseUrl === API_BASE,\n            `CARAMEL_BASE_URL=${baseUrl}`,\n        )",
        "what": "HEAD's own last commit (537547b, 'point unpacked/dev installs at dev.grabcaramel.com instead of localhost') changed background.js and popup.js so an unpacked/dev install's base URL is now `https://dev.grabcaramel.com`, not `http://localhost:58000` — but this test script's step 2 assertion, and the entire step-7 popup-login flow that reuses API_BASE as the server it expects the popup to call, were never updated and still hardcode the old localhost value. The suite is not a false claim about mocking — it genuinely exercises the real service worker, real storage, and a real applyCoupon() DOM run — but `checks-extension.yml` (the only CI workflow touching this directory) runs only `pnpm run lint` and `pnpm run prettier-check`; `test:e2e` is invoked nowhere in CI, so this breakage has no automated tripwire. Separately, the one DOM-injection scenario it does run (step 8) only exercises applyCoupon()'s single-code happy path against a synthetic vanilla input+button+price DOM — startApplyingCoupons's multi-code loop, early-exit heuristics, discount-link strategy, accordion-reveal, and error-message detection are never exercised by any script in the repo.",
        "why_it_matters": "The suite's own header claims it verifies 'Dev detection WITHOUT the management permission... base URL is correct' as one of 7 numbered guarantees; that guarantee is currently false on this exact commit, and nothing signals that to anyone — a developer would have to run the script manually (with a local dev server, per its own prerequisites comment) to discover it. For a codebase whose test file is the closest thing to a regression net for the DOM-automation engine, an already-stale, CI-unwired suite means the net was torn the same day it mattered.",
        "severity": "High",
        "confidence": 0.95,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "Update API_BASE (or derive it from the same source background.js/popup.js use, closing DD2-7 at the same time); add a `test:e2e` job to checks-extension.yml (even nightly, given it needs a live dev server) so drift like this fails loudly; extend step 8 to cover at least one error-path and one discount-link scenario.",
        "effort": "M",
        "category": "testability"
    },
    {
        "id": "DD2-5",
        "location": "apps/caramel-extension/manifest-firefox.json:42-51",
        "quote": "\"content_scripts\": [\n        {\n            \"matches\": [\n                \"https://www.amazon.com/*\",\n                \"https://*.ebay.com/*\",\n                \"https://*.codecademy.com/*\"\n            ],\n            \"js\": [\"shared-utils.js\", \"UI-helpers.js\", \"inject.js\", \"amazon.js\"]\n        }\n    ],",
        "what": "manifest-firefox.json (version 1.0.5) references `amazon.js`, a file that does not exist anywhere in this repository (confirmed by exhaustive filename search); it omits `cart-signals.js` (present in manifest.json's list) and the `caramel-content.css` stylesheet; its host_permissions/content_scripts matches are hardcoded to exactly 3 domains (amazon.com, *.ebay.com, *.codecademy.com) versus manifest.json's `https://*/*`; its permissions list carries `management` and `alarms` (manifest.json has neither `management` — confirmed unused anywhere in the codebase except in comments describing the OLD implementation — nor, separately, `alarms`, see DD2-14) but omits `identity` (present in manifest.json, required for the Google/Apple OAuth flow popup.js implements). manifest.json is at version 1.1.0, package.json at 1.0.2 — three files describing 'the same product' carry three different version numbers. release-extension.yml (the only release pipeline in this repo) has jobs for Chrome (publish_chrome) and Safari/iOS/macOS (publish_safari) only; there is no Firefox job, so nothing in this repo builds, lints, or publishes manifest-firefox.json, and nothing would catch it drifting further.",
        "why_it_matters": "The marketing site (coupons-section.tsx) advertises a live, supported Firefox add-on link. If this manifest is what's actually submitted (nothing in the repo suggests an out-of-band transform), Firefox users get a fundamentally different, far narrower product than Chrome users (3 hardcoded stores vs. the 5,000+ dynamically-fetched ones), an OAuth sign-in path that's missing its required permission, and a content-script file list that references a file that isn't there — the kind of drift that matches this task's stated context exactly (store review lag means old/broken builds live for weeks) except here the staleness is store-side from day one, not a version-skew problem.",
        "severity": "High",
        "confidence": 0.8,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "Either wire an automated Firefox build (regenerate manifest-firefox.json's content_scripts/host_permissions from manifest.json at build time, add a CI lint/diff job) or remove amazon.js and cart-signals.js/CSS gaps by hand and bring host_permissions/permissions/version into parity now; add a CI check that fails when the two manifests' content_scripts file lists diverge from what's actually on disk.",
        "effort": "M",
        "category": "release-management"
    },
    {
        "id": "DD2-6",
        "location": "apps/caramel-extension/shared-utils.js:45-51,67-69",
        "quote": "if (typeof log === 'undefined') {\n    var log = _isDevInstall()\n        ? (...a) => console.log('Caramel:', ...a)\n        : () => {}\n}\nif (typeof recordTiming === 'undefined') {\n    var recordTiming = (event, meta = {}) => {\n        try {\n            ...\n        } catch (e) {\n            // ignore storage errors\n        }\n    }\n}",
        "what": "Across shared-utils.js's 26 catch blocks, only ONE (applyCoupon's outer catch, line 921: `console.error('applyCoupon error', err)`) survives in a packed production build. The other 25 either route through `log()` — a guaranteed no-op in every non-dev install per the definition quoted above (7 catches: lines 347, 414, 723, 730, 1042, 1086, 1165) — or do nothing but a comment/silent fallback (18 catches, including the recordTiming one quoted above, 'ignore storage errors'). recordTiming itself writes every timing event to `chrome.storage.local` under 'caramel_timings', but nothing else in the codebase ever reads that key — it is write-only, dead instrumentation. A repo-wide grep for Sentry/analytics/captureException/reportError inside apps/caramel-extension returns zero hits (contrast apps/caramel-app, which has sentry.*.config.ts files).",
        "why_it_matters": "When the extension breaks on a real user's machine — a store changed their DOM, a selector went stale, storage quota was hit — there is no mechanism by which support or engineering ever finds out: 96% of caught errors in the file responsible for the core apply flow produce literally no trace anywhere, dev-only console logs don't exist in production, and the one telemetry mechanism that does exist (recordTiming) is never transmitted or read. 'Site changed their DOM' and 'our bug' are indistinguishable from the outside because nothing is outside — everything stays on the user's own machine, unread.",
        "severity": "High",
        "confidence": 0.9,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "Add a minimal remote error-reporting hook (even a low-volume beacon to the existing backend) for the handful of catches that matter most (applyCoupon failures, getDomainRecord API failures); at minimum, upgrade recordTiming's silent local write into something periodically flushed and surfaced, or delete it if it will never be read.",
        "effort": "M",
        "category": "observability"
    },
    {
        "id": "DD2-7",
        "location": "apps/caramel-extension/background.js:20-22 vs apps/caramel-extension/popup.js:7-10",
        "quote": "// background.js\nglobalThis.CARAMEL_BASE_URL = _isDevInstall()\n    ? 'https://dev.grabcaramel.com'\n    : 'https://grabcaramel.com'\n\n// popup.js (separate, independently-maintained copy of the same ternary)\nconst CARAMEL_BASE_URL =\n    typeof _isDevInstall === 'function' && _isDevInstall()\n        ? 'https://dev.grabcaramel.com'\n        : 'https://grabcaramel.com'",
        "what": "The dev/prod base-URL ternary (and its accompanying `caramelUrl(path)` helper) is independently declared in both background.js and popup.js rather than computed once and read from one place. This is proven, not hypothetical: HEAD's own last commit had to touch both files (`background.js | 4 +++-`, `popup.js | 5 +++-`) to change one URL string, and even then missed a third copy of an adjacent constant — `EXTENSION_API_KEY = 'WXqEpm2uOV5jjJXPpnQFyZiNdaPVUrtd2LIrf4kc1JA'` is duplicated verbatim between background.js:23 and scripts/test-extension.mjs:32, so a future key rotation has a third silent place to miss (surfacing as unexplained 401s in the already CI-unwired test script, see DD2-4).",
        "why_it_matters": "Direct evidence of 'each behavior in exactly one place' being violated: identical business logic (which environment am I in, what's my base URL) lives in N independently-edited copies, so every future change to it is a find-all-copies exercise with no compiler/linter to catch a missed spot — exactly what happened this week.",
        "severity": "Medium",
        "confidence": 0.9,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "Compute CARAMEL_BASE_URL once (e.g. in shared-utils.js, which both background.js and popup.js already load after) and have background.js/popup.js read it from there; move EXTENSION_API_KEY to the same shared location and import it into the test script instead of copy-pasting.",
        "effort": "S",
        "category": "duplication"
    },
    {
        "id": "DD2-8",
        "location": "apps/caramel-extension/background.js:226,242-245,258",
        "quote": "if (!tabs || !tabs.length) {\n    sendResponse({ domainRecord: null, url: null })\n    return\n}\n...\n    sendResponse({ domainRecord: null, url: url.hostname })\n...\n    sendResponse({ domainRecord: null, url: hostname })",
        "what": "getActiveTabDomainRecord's response always carries `domainRecord: null` — on all three branches, unconditionally. popup.js's only consumer (getActiveTabDomainRecord in popup.js:124-133) destructures `resp?.url` and never reads `domainRecord` at all. More broadly, none of the ~8 message actions in background.js share a response envelope: `{success}`, `{coupons}`, `{supported}`, `{domainRecord,url}`, `{error}`, `{status}` are each invented ad hoc per-handler with no shared type/schema anywhere in the codebase (plain JS, no JSDoc typedefs, no zod/io-ts equivalent).",
        "why_it_matters": "A dead field that both sides carry but neither populates nor reads is a small but real tax on every future reader trying to understand what the background/content-script contract actually is — and it's a symptom of the larger gap: with no shared schema, every new message action is free to invent its own shape, and nothing catches a caller reading a field the handler never sends (as very nearly happened here in reverse).",
        "severity": "Medium",
        "confidence": 0.85,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "Remove the dead `domainRecord` field (or implement it if a future feature needs it); define one small shared response-shape convention (e.g. always `{ok: boolean, data, error}`) that every handler in background.js follows.",
        "effort": "S",
        "category": "messaging-protocol"
    },
    {
        "id": "DD2-9",
        "location": "apps/caramel-extension/background.js:71-76 vs shared-utils.js:1054-1059",
        "quote": "// background.js comment:\n// NOTE: Do not use `execScript` to inject full content-script bundles\n// that are declared in `manifest.json` (e.g. `shared-utils.js`).\n// Injecting the same bundle twice into the same isolated world can\n// cause redeclaration errors for top-level `const`/`let`/`class`.\n\n// shared-utils.js — an UNGUARDED top-level const, one of ~7:\nconst RESTRICTED_STATUSES = new Set([\n    'product_restriction',\n    ...",
        "what": "shared-utils.js guards exactly 6 identifiers against reinjection (sleep, log, recordTiming, currentBrowser, _caramelCancelled, _caramelCodes via `if (typeof x === 'undefined')`), but at least 7 other top-level `const` bindings are not guarded: CARAMEL_ALLOWED_ORIGINS (:77), STORE_CACHE_KEY/STORE_CACHE_PROD_TTL/STORE_CACHE_DEV_TTL (:281-283), GENERIC_APPLIED_SELECTORS/GENERIC_REMOVE_SELECTORS/GENERIC_ERROR_TEXT_RE (:544-553), ERROR_WORDS_RE (:634), CARAMEL_TRIED_KEY/CARAMEL_TRIED_TTL (:969-970), and RESTRICTED_STATUSES (:1054, quoted above) — any of these would throw `SyntaxError: Identifier '...' has already been declared` if the bundle were ever injected twice into one isolated world, exactly the failure mode background.js's own comment warns about. Mitigating factor found: `execScript` (background.js:50-69, the only dynamic-injection path in the codebase) has zero callers anywhere in the extension — the hazard is currently latent, not actively triggered.",
        "why_it_matters": "The guard pattern exists specifically because this failure mode was anticipated (the comment is explicit and detailed), but it was applied to under half of the identifiers that need it — a partial fix that looks complete at a glance but isn't, which is worse than no guard plus no comment, since it invites false confidence.",
        "severity": "Medium",
        "confidence": 0.85,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "Either wrap the remaining ~7 top-level consts in the same `if (typeof x === 'undefined')` pattern, or (cheaper, given execScript is dead) delete execScript/hasTabsExecute/waitForTabComplete/sendMessageToTab (background.js:46-111, ~60 lines, zero callers anywhere) and soften the comment to reflect that manifest-declared content scripts are never re-injected in normal operation today.",
        "effort": "S",
        "category": "defensive-coding"
    },
    {
        "id": "DD2-10",
        "location": "apps/caramel-extension/popup.js:59,194,335-341",
        "quote": "currentBrowser.storage.sync.get(['token', 'user'], async res => { ... })\n...\ncurrentBrowser.storage.sync.remove(['token', 'user'], () => renderUnsupportedSite(null))\n...\nawait new Promise((resolve, reject) => {\n    currentBrowser.storage.sync.set({ token, user }, () => {\n        if (chrome.runtime.lastError) {\n            reject(new Error(chrome.runtime.lastError.message))\n            return\n        }\n        resolve()\n    })\n})",
        "what": "Three distinct styles for the same `chrome.storage` API coexist in popup.js alone: bare fire-and-forget callback with no error check (6 of 7 call sites: lines 59, 194, 335's sibling at 522, 561, 704, plus shared-utils.js's own storage.local.get/set in getDomainRecord and recordTiming use a fourth style — promise-wrapped, no lastError check), and exactly one promise-wrapped call WITH an explicit `chrome.runtime.lastError` check (popup.js:335-341, inside handleSocialSignIn only). That one correct instance also reaches for the bare global `chrome.runtime.lastError` directly instead of going through the `currentBrowser` abstraction every other line in the file uses to stay Chrome/Firefox-portable.",
        "why_it_matters": "storage.sync has real, low failure-tolerance limits (quota, sync conflicts) that this codebase already knows to check for in exactly one place — the other 6+ call sites assume success unconditionally, so a failed token save/remove leaves the popup silently out of sync with reality (e.g. 'logged out' UI shown while storage still holds a stale token, or vice versa) with no error surfaced anywhere.",
        "severity": "Medium",
        "confidence": 0.8,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "Wrap all chrome.storage.* calls through one small promise-returning helper that always checks runtime.lastError (via currentBrowser, not the bare chrome global) and reuse it everywhere instead of re-deriving the pattern per call site.",
        "effort": "M",
        "category": "storage-api"
    },
    {
        "id": "DD2-11",
        "location": "apps/caramel-extension/shared-utils.js:1054-1059 vs apps/caramel-extension/popup.js:604-609",
        "quote": "// shared-utils.js\nconst RESTRICTED_STATUSES = new Set([\n    'product_restriction',\n    'category_restricted',\n    'seller_specific',\n    'valid_with_warning',\n])\n\n// popup.js, ~450 lines later in the same app\nconst restrictedSet = new Set([\n    'product_restriction',\n    'category_restricted',\n    'seller_specific',\n    'valid_with_warning',\n])",
        "what": "The identical 4-value coupon-status set is declared twice, verbatim, in two different files of the same extension. It's actually a 3-way (cross-app, cross-language) duplication: apps/caramel-app/src/types/coupon.ts declares the canonical `CouponStatus` union (9 values) and apps/caramel-app/src/components/coupons/coupon-card.tsx's `STATUS_BADGE` map assigns each status a label ('Restrictions apply', 'Category-limited', 'Seller-specific', 'Verified · may vary', etc.) and a Tailwind class; popup.js's own `BADGE` object (popup.js:638-664) reproduces the exact same label strings (including the 'Verified · may vary' middle-dot) against inline hex colors instead. No shared constants file, generated code, or API-supplied label ties any of these three definitions together — a repo-wide grep for the four restricted-status strings hits 9 separate files.",
        "why_it_matters": "The coupon-status vocabulary is product-critical (it drives what warning text and badge color a user sees before trusting a code) yet is hand-copied across two languages and two apps with nothing to catch drift — add a new status server-side, rename a label, or fix a typo, and there are at least 3 independent places (2 in the extension alone) that must be remembered and kept byte-identical by hand.",
        "severity": "Medium",
        "confidence": 0.9,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "Have the API response carry the display label directly (removing the need for any client to hardcode it), or at minimum extract one shared status-vocabulary module referenced by both shared-utils.js and popup.js within the extension.",
        "effort": "M",
        "category": "duplication"
    },
    {
        "id": "DD2-12",
        "location": "apps/caramel-extension/package.json:10",
        "quote": "\"build\": \"rm -rf dist && mkdir -p dist && rsync -a --exclude='node_modules' --exclude='dist' --exclude='.git' --exclude='*.lock' --exclude='apple-extension' ./ dist/\",",
        "what": "The `--exclude='*.lock'` glob matches files ending in the literal suffix `.lock`; it does not match `pnpm-lock.yaml` (which ends in `.yaml`). There is also no exclusion for eslint.config.cjs, scripts/ (including the two test .mjs files), README.md, .turbo/ build logs, or the multi-megabyte apps/caramel-extension/assets/Caramel Logos/ source-asset folder (raw logo exports far larger than the actual runtime icons/ directory). All of the above get rsync'd into dist/, which is exactly what `pnpm run package` zips into extension.zip — the artifact release-extension.yml uploads to the Chrome Web Store and feeds into the Safari web-extension converter.",
        "why_it_matters": "Every packed build shipped to end users and app-store reviewers silently bundles the full dependency lockfile, lint config, node test scripts, and unused high-res source logos — pure bloat with no build step ever intended to include them (the exclude list's own intent, four other exclusions, makes clear this is an oversight, not a choice).",
        "severity": "Medium",
        "confidence": 0.85,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "Fix the glob to `--exclude='pnpm-lock.yaml'` (or `--exclude='*lock*'` if intentionally broad) and add explicit excludes for eslint.config.cjs, scripts/, README.md, .turbo/, and assets/Caramel Logos/.",
        "effort": "S",
        "category": "build-hygiene"
    },
    {
        "id": "DD2-13",
        "location": "apps/caramel-extension/eslint.config.cjs:7-36",
        "quote": "module.exports = [\n    {\n        files: ['**/*.{js,html}'],\n        ...\n        rules: {\n            'import/no-unresolved': 'off',\n            'no-console': ['warn', { allow: ['error'] }],\n            'prettier/prettier': 'warn',\n        },\n    },\n]",
        "what": "This flat config extends no preset (no `eslint:recommended`/`js.configs.recommended` equivalent) and defines exactly 3 rules total for the whole codebase — none of them no-undef, no-unused-vars, no-unreachable, or any correctness rule. The `files` glob (`**/*.{js,html}`) never matches `.mjs`, so scripts/test-extension.mjs and scripts/test-cart-signals.mjs are skipped by `eslint .` entirely (ESLint 9 flat config silently skips files no config block matches); package.json's `prettier-check` script glob (`**/*.{js,html,css,json,md}`) excludes `.mjs` too, so those two files are formatted and linted by nothing in the toolchain.",
        "why_it_matters": "This codebase's central convention — implicit globals shared across files purely via manifest/script-tag load order (DD2-3) — is precisely the pattern `no-undef` exists to keep honest, and it isn't enabled. Combined with zero coverage of the two .mjs test scripts, the tooling stack currently would not catch a typo'd global reference, an unused variable, or a formatting drift in exactly the files most likely to hide one.",
        "severity": "Low",
        "confidence": 0.8,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "Extend `@eslint/js`'s recommended config as a base layer; add `no-undef` (paired with accurate `/* global */` annotations or the namespacing fix in DD2-3); widen the `files` glob and package.json's prettier-check glob to include `**/*.mjs`.",
        "effort": "S",
        "category": "tooling"
    },
    {
        "id": "DD2-14",
        "location": "apps/caramel-extension/background.js:114-127 vs manifest.json:19",
        "quote": "function keepAlive() {\n    if (isServiceWorker) {\n        try {\n            currentBrowser.alarms.create('keepAlive', { periodInMinutes: 1 })\n            currentBrowser.alarms.onAlarm.addListener(alarm => { ... })\n        } catch (error) {\n            // Fallback if alarms API is not available\n        }\n    } else {\n        setInterval(() => { ... }, 10000)\n    }\n}\n\n// manifest.json permissions (Chrome/MV3 — the isServiceWorker=true branch above):\n\"permissions\": [\"tabs\", \"activeTab\", \"storage\", \"scripting\", \"identity\"],",
        "what": "manifest.json (the Chrome/MV3 build, the one actually built and published by CI) does not declare the `alarms` permission, so `currentBrowser.alarms` is `undefined` in that context and `currentBrowser.alarms.create(...)` throws a TypeError, caught by the surrounding try/catch. The catch's comment promises 'Fallback if alarms API is not available', but the catch body is empty — the only real fallback branch (the `setInterval` in the `else`) is unreachable from here, since Chrome's service-worker path always takes the `if (isServiceWorker)` branch. manifest-firefox.json, by contrast, does declare `alarms`.",
        "why_it_matters": "The function named and commented as this extension's keep-alive mechanism does nothing at all on the Chrome build — the one distributed through the CI/release pipeline to the large majority of users — and fails completely silently (not even a dev-mode log). Actual runtime impact is likely small since Chrome MV3 re-spawns service workers on demand for new events regardless, but the code as written asserts a guarantee ('keep alive') it does not provide, which is exactly the kind of comment-promises-behavior-that-isn't-there gap that erodes trust in the rest of the file's comments.",
        "severity": "Medium",
        "confidence": 0.75,
        "verified": false,
        "survived_adversarial_review": null,
        "fix_direction": "Add `alarms` to manifest.json's permissions (cheap, matches Firefox already), or delete the dead illusion of a fallback and the misleading comment if keep-alive alarms are judged unnecessary for MV3's on-demand wake behavior.",
        "effort": "S",
        "category": "manifest-permissions"
    }
]
```
