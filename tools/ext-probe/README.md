# ext-probe

Loads the **real unpacked extension** into Playwright's Chromium, drives a live store, and reports
whether the store's config actually **works** — not merely whether the prompt appeared.

It exists because the previous answer to "does this config work?" was a human reading prose from a
scratch script that exited `0` whether or not anything happened. Here the run ends in one
schema-versioned JSON object and an exit code, so a caller can branch on the result and CI can pin
the vocabulary.

## Layout

| File          | Role                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `probe.mjs`   | The driver. Launches Chromium, seeds a cart, watches the run, emits the report. Needs a browser.                                                             |
| `verdict.mjs` | The judgement. Pure — no browser, no filesystem. This is what the unit tests exercise.                                                                       |
| `seed.mjs`    | The functions that run **inside** the page — platform detection, the per-platform seeders, the cart reader. Self-contained so Playwright can serialise them. |

## Usage

```sh
node tools/ext-probe/probe.mjs <url> [width] [tag] [flags]
```

| Flag / env         | Default                  | Meaning                                                                                                                                                                                                                                              |
| ------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXT_DIR`          | `apps/caramel-extension` | Which build to load. **Set it** — the WXT build lands in `apps/caramel-extension/.output/chrome-mv3`, and the default path no longer holds a manifest. A directory without a loadable `manifest.json` exits `71` before Chromium starts (see below). |
| `PROBE_WAIT_MS`    | `30000`                  | How long a shopper waits before we call it a no-show.                                                                                                                                                                                                |
| `PROBE_ALL_LOGS`   | unset                    | `1` keeps every console line, not just the Caramel-shaped ones.                                                                                                                                                                                      |
| `--out <path>`     | stdout                   | Write the JSON report to a file instead of stdout.                                                                                                                                                                                                   |
| `--out-dir <path>` | `.ext-probe/`            | Where the full log, screenshot and disposable profile live.                                                                                                                                                                                          |
| `--expect-config`  | —                        | JSON file holding the config under test; enables the staleness compare.                                                                                                                                                                              |
| `--good-code`      | —                        | A code expected to work — supplies GREEN evidence (6).                                                                                                                                                                                               |
| `--invalid-code`   | —                        | A deliberately invalid code — the negative control, GREEN evidence (7).                                                                                                                                                                              |
| `--width`/`--tag`  | `390` / `probe`          | Same as the positional forms.                                                                                                                                                                                                                        |

Human prose goes to **stderr**; stdout carries the JSON object and nothing else.

## Exit codes

The exit code carries the verdict. `0` means GREEN and nothing else. `1` and `2` are avoided
deliberately — those are node's own uncaught-throw and bad-usage codes, and a caller must be able to
tell "the config is broken" from "the probe never ran".

| Code | Verdict                     | Meaning                                                                        |
| ---- | --------------------------- | ------------------------------------------------------------------------------ |
| 0    | `GREEN`                     | Full chain proven — all seven evidence items below.                            |
| 10   | `AMBER_NO_INDICATORS`       | The flow works but cannot be **proved**.                                       |
| 20   | `RED_NOT_DETECTED`          | Real cart, extension never recognised the checkout.                            |
| 21   | `RED_NO_COUPONS`            | Detected, catalogue had nothing to try.                                        |
| 22   | `RED_NO_PROMPT`             | Coupons fetched, prompt never rendered.                                        |
| 23   | `RED_PROMPT_DEGENERATE`     | Rendered but unusable (zero size, invisible, fallback CSS).                    |
| 24   | `RED_APPLY_FAILED`          | Codes entered, nothing landed, no error fired.                                 |
| 30   | `INCONCLUSIVE_SEED`         | Cart never populated — "no prompt" is CORRECT here, not a failure.             |
| 31   | `INCONCLUSIVE_PLATFORM`     | No seeder speaks for this store's platform, or its endpoints did not answer.   |
| 32   | `INCONCLUSIVE_CONFIG_STALE` | The served config is not the one under test.                                   |
| 70   | `PROBE_ERROR`               | The **probe** crashed. Not a statement about the store.                        |
| 71   | `PROBE_NO_EXTENSION`        | `EXT_DIR` holds no loadable extension. Not a statement about the store either. |

`PROBE_NO_EXTENSION` has its own code because the failure it names is silent by nature. Chromium
accepts `--load-extension=<dir>` pointing at a directory with no manifest, logs nothing a caller can
see, and runs a perfectly ordinary browser with nothing installed — and every measurement taken that
way says the prompt never appeared, no coupons were fetched and nothing was submitted, which is
indistinguishable from a genuinely broken store config. That is exactly what happened after the WXT
migration moved the build to `.output/chrome-mv3`: days of ext-QA verdicts were measurements of an
empty browser, and the only tell in the whole report was `vnull` in the log header. **A probe that
cannot load the extension must never produce a verdict**, so the check runs before Chromium is
launched and the report carries no observation at all.

Verdicts are evaluated **first match wins**, in the order listed in `VERDICTS`. `INCONCLUSIVE_SEED`
is checked before everything else on purpose: an empty cart is not a checkout, so the extension
staying silent is correct behaviour, and grading that as a defect is the easiest way to invent a bug
that was never there.

`GREEN` requires all of: (1) `cartItemsAtArrival > 0`, read **before** the wait window; (2) the
served config matches the config under test **and** the API log line is present; (3) a complete
detection → fetch-start → fetch-end (`count > 0`) trail; (4) a non-degenerate prompt — the rect is
**recorded, never compared to a remembered size**; (5) a strict price decrease read via
`priceContainer`; (6) the success indicator fired on a good code; (7) the error indicator fired on a
deliberately invalid code. If `priceContainer`, `successIndicator` or `errorIndicator` is null in
the served config, the best available verdict is `AMBER_NO_INDICATORS` — never `GREEN`.

## JSON schema (`ext-probe/1`)

```jsonc
{
    "schema": "ext-probe/1",
    "verdict": "GREEN", // one of VERDICTS, or PROBE_ERROR
    "exitCode": 0, // always exitCodeFor(verdict)
    "reasons": ["..."], // why this verdict and not another
    "target": { "url": "", "origin": "", "viewportWidth": 390, "tag": "probe" },
    "build": {
        // which build was measured — never a guess
        "extensionPath": "",
        "manifestName": "",
        "manifestVersion": "",
        "fileCount": 0,
        "contentHash": "sha256:...",
    },
    "observation": {
        "seed": { "ok": null, "detail": "", "rejectedAdds": 0, "adds": 0 },
        "platform": {
            "detected": null, // shopify | woocommerce | bigcommerce | unknown
            "productFeedOk": null, // the platform's product source listed something addable
            "cartApiOk": null, // the platform's cart endpoint answered
            "productsJsonOk": null, // the Shopify legs, set only on a Shopify run
            "cartJsOk": null,
        },
        "cartItemsAtArrival": null, // read BEFORE the wait window
        "config": {
            "servedFromApi": null,
            "expected": null,
            "served": null,
            "matches": null,
            "mismatchedFields": [],
        },
        "detection": {
            "checkoutViaCartPayload": null,
            "matchedPromoBox": null,
        },
        "coupons": { "fetchStarted": null, "fetchEnded": null, "count": null },
        "prompt": {
            "present": false,
            "appearedMs": null,
            "rect": null,
            "opacity": null,
            "visibility": null,
            "cssIsFallback": null,
            "shadowChildren": null,
        },
        "indicators": {
            "priceContainer": null,
            "successIndicator": null,
            "errorIndicator": null,
        },
        "apply": {
            "submitted": 0,
            "successFiredOnGoodCode": null,
            "errorFiredOnInvalidCode": null,
            "totalBefore": null,
            "totalAfter": null,
        },
    },
    "witnesses": {
        "console": { "available": true, "trail": [] },
        "serviceWorker": { "available": true, "trail": [] },
        "timings": { "available": true, "trail": [] },
        "disagreement": {
            "detected": false,
            "timingsAtCap": false,
            "details": [],
            "consoleCounts": {},
            "timingCounts": {},
        },
    },
    "logFile": "", // full, untruncated
    "screenshot": null,
    "durationMs": 0,
}
```

`null` means **not observed** and is never written as `false`. "We did not see it" and "it did not
happen" lead to different verdicts, and collapsing them is how a harness starts lying.

## Two independent witnesses

The console trail and `chrome.storage.local.caramel_timings` are two separate records of the same
run, and the report carries **both**. When they disagree, `witnesses.disagreement` says so and the
probe picks no winner — the disagreement is usually the interesting bug. `caramel_timings` is capped
at the newest 50 entries at write time, so `timingsAtCap` is reported alongside: at the cap a
difference is _explainable_, which is not the same as _forgiven_.

The timings live in extension storage and are readable **only** through the service-worker handle —
page `evaluate` runs in the store's world and cannot see them.

## Seeding a cart, per platform

The probe's first question on any store is "is there a cart?". Until 2026-08-14 only Shopify could
answer it, so every WooCommerce and BigCommerce store fell out at `INCONCLUSIVE_SEED` and the repair
loop behind ext-QA never got a verdict to act on.

The platform is named from markup the platform itself emits (`window.Shopify`,
`wc_add_to_cart_params`, `window.BCData`, then CDN/asset URLs, then theme classes) — never from the
hostname and never from a per-store list, which would rot the day a store replatformed. Detection
runs **once** and the answer is passed to both the seeder and the cart reader, so the two can never
disagree about what the store is.

| Platform    | Products from                        | Added via                                                  | Cart read from              |
| ----------- | ------------------------------------ | ---------------------------------------------------------- | --------------------------- |
| Shopify     | `/products.json`                     | `POST /cart/add.js`                                        | `/cart.js`                  |
| WooCommerce | `/wp-json/wc/store/v1/products`      | `POST /wp-json/wc/store/v1/cart/add-item` + `Nonce` header | `/wp-json/wc/store/v1/cart` |
| BigCommerce | product ids in the storefront markup | `POST /api/storefront/carts`                               | `/api/storefront/carts`     |

Two things about the WooCommerce path were measured on a live store (alphaterritory.com,
2026-08-14) rather than assumed: `add-item` answers `401 woocommerce_rest_missing_nonce` without a
`Nonce` header, and that nonce is handed out in the `Nonce` **response** header of the cart GET the
seeder already makes for its baseline count — so it costs no extra request. The same endpoint takes
a variable product as the parent id plus a `variation` list, which is what makes the path general:
most Woo catalogues are variable products, and the classic `?add-to-cart=` form handler cannot reach
them without reconstructing the theme's own `attribute_*` field names. On BigCommerce
(a1supplements.com, same day) products carrying required options answer
`422 This product has options, variant ID is required` — a real rejection, counted as one.

A platform with no seeder reports `INCONCLUSIVE_PLATFORM` and the run stops there. **A cart is never
faked**: on Shopify the add's own status is the signal, and on both new platforms success is
confirmed by re-reading the cart, so a `201` whose item never appears is not a seeded cart.

## Store safety

Two behaviours are non-negotiable and pinned by tests:

- **Every seeder stops after 5 consecutive rejected adds.** An uncapped version of this loop once
  fired 154 POSTs into one store, drew 286 rate-limit 429s, and broke that store's own scripts — and
  the breakage was then mis-diagnosed as an extension defect. The second-order damage is the lesson.
  Each platform's cap carries its own red-proof: uncapped, the same fixture fires 40 adds.
- **An add that cannot be verified is never sent.** If the cart endpoint will not answer, or
  WooCommerce served no nonce, the seeder abandons before the first POST rather than pushing writes
  at a store it cannot check.
- **The cart is read before the wait window, never after.** An empty cart at arrival makes silence
  the correct answer; reading the cart only after the wait cannot tell the two apart.

The run uses its own disposable profile, created and deleted per invocation. It clears the
extension's cached domain list on that profile so the config under test is fetched fresh — staleness
is detected by **comparison**, never by a fixed sleep.

## Tests

`apps/caramel-extension/tests/ext-probe-*.test.mjs`, run by the extension unit lane
(`pnpm --filter caramel-extension test`) — the same lane CI runs in `checks-extension.yml`.
