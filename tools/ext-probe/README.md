# ext-probe

Loads the **real unpacked extension** into Playwright's Chromium, drives a live store, and reports
whether the store's config actually **works** — not merely whether the prompt appeared.

It exists because the previous answer to "does this config work?" was a human reading prose from a
scratch script that exited `0` whether or not anything happened. Here the run ends in one
schema-versioned JSON object and an exit code, so a caller can branch on the result and CI can pin
the vocabulary.

## Layout

| File          | Role                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `probe.mjs`   | The driver. Launches Chromium, seeds a cart, watches the run, emits the report. Needs a browser. |
| `verdict.mjs` | The judgement. Pure — no browser, no filesystem. This is what the unit tests exercise.           |
| `seed.mjs`    | The functions that run **inside** the page. Self-contained so Playwright can serialise them.     |

## Usage

```sh
node tools/ext-probe/probe.mjs <url> [width] [tag] [flags]
```

| Flag / env         | Default                  | Meaning                                                                                                     |
| ------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `EXT_DIR`          | `apps/caramel-extension` | Which build to load. Point it at `apps/caramel-extension/.output/chrome-mv3` to measure the packaged build. |
| `PROBE_WAIT_MS`    | `30000`                  | How long a shopper waits before we call it a no-show.                                                       |
| `PROBE_ALL_LOGS`   | unset                    | `1` keeps every console line, not just the Caramel-shaped ones.                                             |
| `--out <path>`     | stdout                   | Write the JSON report to a file instead of stdout.                                                          |
| `--out-dir <path>` | `.ext-probe/`            | Where the full log, screenshot and disposable profile live.                                                 |
| `--expect-config`  | —                        | JSON file holding the config under test; enables the staleness compare.                                     |
| `--good-code`      | —                        | A code expected to work — supplies GREEN evidence (6).                                                      |
| `--invalid-code`   | —                        | A deliberately invalid code — the negative control, GREEN evidence (7).                                     |
| `--width`/`--tag`  | `390` / `probe`          | Same as the positional forms.                                                                               |

Human prose goes to **stderr**; stdout carries the JSON object and nothing else.

## Exit codes

The exit code carries the verdict. `0` means GREEN and nothing else. `1` and `2` are avoided
deliberately — those are node's own uncaught-throw and bad-usage codes, and a caller must be able to
tell "the config is broken" from "the probe never ran".

| Code | Verdict                     | Meaning                                                            |
| ---- | --------------------------- | ------------------------------------------------------------------ |
| 0    | `GREEN`                     | Full chain proven — all seven evidence items below.                |
| 10   | `AMBER_NO_INDICATORS`       | The flow works but cannot be **proved**.                           |
| 20   | `RED_NOT_DETECTED`          | Real cart, extension never recognised the checkout.                |
| 21   | `RED_NO_COUPONS`            | Detected, catalogue had nothing to try.                            |
| 22   | `RED_NO_PROMPT`             | Coupons fetched, prompt never rendered.                            |
| 23   | `RED_PROMPT_DEGENERATE`     | Rendered but unusable (zero size, invisible, fallback CSS).        |
| 24   | `RED_APPLY_FAILED`          | Codes entered, nothing landed, no error fired.                     |
| 30   | `INCONCLUSIVE_SEED`         | Cart never populated — "no prompt" is CORRECT here, not a failure. |
| 31   | `INCONCLUSIVE_PLATFORM`     | Store is not Shopify-shaped; the seed path cannot apply.           |
| 32   | `INCONCLUSIVE_CONFIG_STALE` | The served config is not the one under test.                       |
| 70   | `PROBE_ERROR`               | The **probe** crashed. Not a statement about the store.            |

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
        "platform": { "productsJsonOk": null, "cartJsOk": null },
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

## Store safety

Two behaviours are non-negotiable and pinned by tests:

- **The seed stops after 5 consecutive rejected adds.** An uncapped version of this loop once fired
  154 POSTs into one store, drew 286 rate-limit 429s, and broke that store's own scripts — and the
  breakage was then mis-diagnosed as an extension defect. The second-order damage is the lesson.
- **The cart is read before the wait window, never after.** An empty cart at arrival makes silence
  the correct answer; reading the cart only after the wait cannot tell the two apart.

The run uses its own disposable profile, created and deleted per invocation. It clears the
extension's cached domain list on that profile so the config under test is fetched fresh — staleness
is detected by **comparison**, never by a fixed sleep.

## Tests

`apps/caramel-extension/tests/ext-probe-*.test.mjs`, run by the extension unit lane
(`pnpm --filter caramel-extension test`) — the same lane CI runs in `checks-extension.yml`.
