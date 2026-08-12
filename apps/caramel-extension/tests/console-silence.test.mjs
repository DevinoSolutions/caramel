// A packed Web Store install must print NOTHING to any console.
//
// Content scripts run on https://*/* — a raw console call there lands in a
// STORE's console on a shopper's machine, signed with our name (or worse,
// unsigned: "applyCoupon error" told a store owner nothing about whose bug
// they were reading). The gate is `log` / `logError` in caramel-base.js and
// the service worker's own `logError` in background.js, all of which check the
// build-time environment stamp (CARAMEL_ENV.verbose, false in every shipped
// build — see scripts/environments.mjs) and record to extension storage
// instead of printing.
//
// This test pins the rule the way check_conventions.py does in the sibling
// repo: the raw form is banned at the source level, so a new console call is
// a build failure rather than a code-review hope. If a new call site is
// genuinely dev-only, route it through log()/logError() — that is the whole
// point of them existing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { entryModuleClosure, EXT_ROOT } from './_entry-modules.mjs'

const root = EXT_ROOT

// Every module the content/background entrypoints bundle into store pages,
// plus the service worker. popup.js is deliberately NOT here: its console is
// our own popup page, no shopper or store owner ever sees it, and its OAuth
// error objects are genuinely useful when a login report comes in.
const SHIPPED_TO_STRANGERS = [
    // caramel-env.js is define-fed, contains no console call, and is not read
    // from disk here — the environment pins own it (env-stamp.test.mjs)
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

    it('the module list above still matches what actually ships', () => {
        // If a module is added to an entrypoint's import graph but not to this
        // test, the ban silently stops covering it — so the list is
        // derive-checked against the real build inputs rather than trusted.
        // Set EQUALITY, both directions: a module dropped from the build makes
        // a stale row here fail too.
        const bundled = entryModuleClosure(
            'entrypoints/content.ts',
            'entrypoints/background.ts',
        )
        bundled.delete('caramel-env.js')
        expect([...bundled].toSorted()).toEqual(
            [...SHIPPED_TO_STRANGERS].toSorted(),
        )
    })
})
