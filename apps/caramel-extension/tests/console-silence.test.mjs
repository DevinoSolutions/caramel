// A packed Web Store install must print NOTHING to any console.
//
// Content scripts run on https://*/* — a raw console call there lands in a
// STORE's console on a shopper's machine, signed with our name (or worse,
// unsigned: "applyCoupon error" told a store owner nothing about whose bug
// they were reading). The gate is `log` / `logError` in caramel-base.js and
// the service worker's own `logError` in background.js, all of which check the
// build-time environment stamp (CARAMEL_ENV.verbose, false in every shipped
// build — see scripts/build-dist.mjs) and record to extension storage instead
// of printing.
//
// This test pins the rule the way check_conventions.py does in the sibling
// repo: the raw form is banned at the source level, so a new console call is
// a build failure rather than a code-review hope. If a new call site is
// genuinely dev-only, route it through log()/logError() — that is the whole
// point of them existing.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Every file the manifest injects into store pages, plus the service worker.
// popup.js is deliberately NOT here: its console is our own popup page, no
// shopper or store owner ever sees it, and its OAuth error objects are
// genuinely useful when a login report comes in.
const SHIPPED_TO_STRANGERS = [
    // caramel-env.js is generated, contains no console call, and is not read
    // from disk here — the environment pins own it (build-environment.test.mjs)
    'coupon-constants.generated.js',
    'cart-signals.js',
    'caramel-base.js',
    'dom-utils.js',
    'store-detect.js',
    'coupon-apply.js',
    'coupon-fetch.js',
    'coupon-runner.js',
    'UI-helpers.js',
    'inject.js',
    'background.js',
]

function ungatedConsoleLines(file) {
    const src = readFileSync(join(root, file), 'utf8')
    const lines = src.split('\n')
    const out = []
    lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '')
        if (!/console\.(log|warn|info|debug|error|trace)\s*\(/.test(code))
            return
        // The sanctioned pattern is a call guarded by the verbose flag on the
        // same line (`if (CARAMEL_ENV.verbose) console.…`) or the line directly
        // above (prettier wraps both the base.js ternary and the background
        // fetchCoupons `if` that way). One line of lookback is deliberate: a
        // gate further away than that is too far for a reader to see either,
        // and should be rewritten as a logError call.
        const gate = /CARAMEL_ENV\.verbose/
        if (gate.test(code)) return
        if (i > 0 && gate.test(lines[i - 1])) return
        out.push(`${file}:${i + 1}: ${line.trim()}`)
    })
    return out
}

describe('a packed install is silent in every console it can reach', () => {
    for (const file of SHIPPED_TO_STRANGERS) {
        it(`${file} has no ungated console call`, () => {
            expect(ungatedConsoleLines(file)).toEqual([])
        })
    }

    it('the manifest list above still matches what actually ships', () => {
        // If a content script is added to the manifest but not to this test,
        // the ban silently stops covering it — so the list is derived-checked
        // rather than trusted.
        const manifest = JSON.parse(
            readFileSync(join(root, 'manifest.json'), 'utf8'),
        )
        const injected = manifest.content_scripts.flatMap(cs => cs.js)
        const sw = manifest.background.service_worker
        for (const f of [...injected, sw]) {
            // caramel-env.js does not exist as a checked-in shipped file (the
            // build writes it), so it is exempt from the read-from-disk scan.
            if (f === 'caramel-env.js') continue
            expect(SHIPPED_TO_STRANGERS).toContain(f)
        }
    })
})
