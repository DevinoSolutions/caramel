import { beforeAll, describe, expect, it } from 'vitest'
import {
    getOnMessageListeners,
    loadExtensionSource,
    loadExtensionSources,
} from './_load.mjs'

// Producer/consumer CONTRACT pin for getActiveTabDomainRecord — born from a
// live bug (eBay, iOS Safari, 2026-08-09): background.js answered with
// `new URL(tabUrl).hostname` ("www.ebay.com") while popup.js's non-web-tab
// guard (`/^https?:\/\//`) requires a scheme, so EVERY real store nulled to
// "no active tab" and the popup skipped its coupon fetch — showing the
// "Ready when you are" empty state (plus a Log in button) on sites the
// extension had just flagged as having coupons. The store had 96 live eBay
// coupons at the time; nothing was wrong server-side.
//
// Every other popup suite stubs the service worker with a hand-written
// payload (`cb({ url: 'https://example.com/cart' })`), which is exactly how
// the drift stayed invisible: the fixtures described the contract, the
// producer broke it, and no test ran the two against each other. This suite
// closes that hole by capturing the REAL background.js handler's response
// and feeding it — unedited — to the REAL popup.
//
// (jsdom lacks a service-worker realm, so producer and consumer are loaded
// into separate stub realms and bridged by replaying the captured payload —
// the payload itself is never hand-authored.)

const STORE_TAB_URL = 'https://www.ebay.com/itm/1234567890?campid=abc'
const NON_WEB_TAB_URL = 'chrome://newtab/'

/** Runs the real background.js onMessage handler for a tab whose full URL is
 * `tabUrl` and resolves with the getActiveTabDomainRecord payload. */
function captureProducerPayload(tabUrl) {
    loadExtensionSource('background.js', [])
    const [handler] = getOnMessageListeners()
    globalThis.chrome.tabs.query = (_query, cb) => cb([{ url: tabUrl }])
    return new Promise(resolve =>
        handler({ action: 'getActiveTabDomainRecord' }, {}, resolve),
    )
}

/** Loads the real popup stack, replays `payload` as the service worker's
 * getActiveTabDomainRecord answer, runs initPopup(), and reports what the
 * popup did: which site (if any) it fetched coupons for, and which view
 * landed in the DOM. */
async function runPopupAgainst(payload) {
    document.body.innerHTML =
        '<div id="loading-container"></div><div id="auth-container"></div>'

    // Same load order as index.html / the manifests (see popup.test.mjs).
    loadExtensionSource('coupon-constants.generated.js', [])
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

    const observed = { fetchedSite: null }
    globalThis.currentBrowser.runtime.sendMessage = (message, cb) => {
        if (message?.action === 'getActiveTabDomainRecord') {
            cb(payload)
        } else if (message?.action === 'fetchCoupons') {
            observed.fetchedSite = message.site
            cb({
                coupons: [
                    {
                        id: 1,
                        code: 'CONTRACT10',
                        title: '10% off',
                        status: 'valid',
                    },
                ],
            })
        } else {
            cb(undefined)
        }
    }
    globalThis.currentBrowser.storage.sync.get = (_keys, cb) => cb({})

    const { initPopup } = loadExtensionSource('popup.js', ['initPopup'])

    // initPopup resolves before its async render chain finishes (see
    // popup.test.mjs's waitForRenderLoadError note) — wrap the three terminal
    // render functions for a deterministic completion signal.
    const rendered = new Promise(resolve => {
        for (const name of [
            'renderCouponsView',
            'renderUnsupportedSite',
            'renderProfileCard',
            'renderLoadError',
        ]) {
            const original = globalThis[name]
            globalThis[name] = (...args) => {
                const result = original(...args)
                resolve(name)
                return result
            }
        }
    })

    await initPopup()
    const view = await rendered
    return {
        observed,
        view,
        html: document.getElementById('auth-container').innerHTML,
    }
}

describe('getActiveTabDomainRecord producer/consumer contract', () => {
    let storePayload
    let nonWebPayload

    beforeAll(async () => {
        // Capture both payloads from the REAL producer up front — each
        // loadExtensionSource call installs a fresh chrome stub, so the
        // producer runs are done before any popup realm is built.
        storePayload = await captureProducerPayload(STORE_TAB_URL)
        nonWebPayload = await captureProducerPayload(NON_WEB_TAB_URL)
    })

    it('producer answers with the FULL tab URL (scheme included), never a bare hostname', () => {
        expect(storePayload.url).toBe(STORE_TAB_URL)
    })

    it('a store tab renders the coupon list, fetching by hostname without www/path/query', async () => {
        const { observed, view, html } = await runPopupAgainst(storePayload)
        expect(observed.fetchedSite).toBe('ebay.com')
        expect(view).toBe('renderCouponsView')
        expect(html).toContain('CONTRACT10')
        // The empty state that shipped to eBay users must not be what renders.
        expect(html).not.toContain('View Supported Stores')
    })

    it('a non-web tab still lands on the introduction view without fetching (PR #143 behavior preserved)', async () => {
        const { observed, view } = await runPopupAgainst(nonWebPayload)
        expect(observed.fetchedSite).toBeNull()
        expect(view).toBe('renderUnsupportedSite')
    })
})
