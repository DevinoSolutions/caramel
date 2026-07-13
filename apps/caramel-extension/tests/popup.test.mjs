import { beforeAll, describe, expect, it } from 'vitest'
import { loadExtensionSource, loadExtensionSources } from './_load.mjs'

// F-002 UI pin — proves the honest-failure plumbing all the way through:
// background.js now replies {error:'HTTP <status>'} on a non-ok upstream
// fetch (background.test.mjs); coupon-fetch.js's fetchCoupons() (formerly
// shared-utils.js, split by F-008 — move-only, cat-diff-proven
// behavior-identical) already throws on resp.error; popup.js's
// initPopup() already catches that and renders the load-error state
// instead of silently falling through to "no coupons for this site"
// (which would misrepresent an OUTAGE as a factual absence of coupons —
// the bug this finding exists for).
//
// Goes through the real listener chain (coupon-fetch.js's fetchCoupons,
// unstubbed) rather than re-implementing the shaping — only the messaging
// transport (currentBrowser.runtime.sendMessage/storage.sync.get) is
// stubbed, since there's no real background service worker in this harness.
let initPopup

beforeAll(() => {
    document.body.innerHTML =
        '<div id="loading-container"></div><div id="auth-container"></div>'

    // F-006 — coupon-constants.generated.js sets window.CaramelCoupons,
    // which coupon-fetch.js now reads unconditionally at module-eval time
    // (RESTRICTED_STATUSES's rebind) and popup.js reads when rendering a
    // coupon list. Real load order (manifest.json, manifest-firefox.json,
    // index.html) always puts it first; mirror that here.
    loadExtensionSource('coupon-constants.generated.js', [])

    // Load the 6 F-008 split files next, in real manifest load order and
    // sharing ONE chrome stub (loadExtensionSources): together they
    // establish window/globalThis.currentBrowser (caramel-base.js's
    // bootstrap) and define the real fetchCoupons() (coupon-fetch.js).
    // popup.js references both as free globals (see its
    // `/* global currentBrowser, fetchCoupons */` header) and does not
    // declare either itself.
    loadExtensionSources(
        [
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
        ],
        [],
    )

    // Stub the messaging transport on the stub captured above. A later
    // loadExtensionSource() call (for popup.js, below) installs its OWN
    // fresh chrome stub and reassigns globalThis.chrome — but that does not
    // affect this object, since currentBrowser already holds a direct
    // reference to it (captured at caramel-base.js's bootstrap, the first
    // of the loadExtensionSources() call above, not a live re-read of
    // globalThis.chrome).
    globalThis.currentBrowser.runtime.sendMessage = (message, cb) => {
        if (message?.action === 'getActiveTabDomainRecord') {
            cb({ url: 'https://example.com/cart' })
        } else if (message?.action === 'fetchCoupons') {
            cb({ error: 'HTTP 500' })
        } else {
            cb(undefined)
        }
    }
    globalThis.currentBrowser.storage.sync.get = (_keys, cb) => cb({})
    ;({ initPopup } = loadExtensionSource('popup.js', ['initPopup']))
})

// initPopup() resolves as soon as its (un-awaited) storage.sync.get call
// returns — the actual render happens inside that callback's own async
// chain. Wrap the global renderLoadError (a top-level function declaration,
// so reassigning the global property redirects initPopup's free-variable
// lookup) to get a deterministic signal instead of guessing a delay.
function waitForRenderLoadError() {
    return new Promise(resolve => {
        const original = globalThis.renderLoadError
        globalThis.renderLoadError = (...args) => {
            const result = original(...args)
            resolve()
            return result
        }
    })
}

describe('popup.js initPopup — honest load-failure UI (F-002)', () => {
    it('background {error} on fetchCoupons renders the load-error view, not "no coupons for this site"', async () => {
        const rendered = waitForRenderLoadError()

        await initPopup()
        await rendered

        const html = document.getElementById('auth-container').innerHTML
        expect(html).toContain("Couldn't load coupons")
        expect(html).not.toContain('No coupons for this site yet')
    })
})
