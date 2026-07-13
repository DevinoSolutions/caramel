import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadExtensionSource, loadExtensionSources } from './_load.mjs'

// D4 pin (audit/ext-e2e-report.md #5, ext-config-trace.md §5.4) — the popup
// loader used to hide on a fixed 400ms setTimeout, completely detached from
// the actual fetchCoupons() request (which can take up to background.js's
// FETCH_TIMEOUT_MS, 8s). E2E reproduced the resulting blank `auth-container`
// gap on a slow/degraded connection. The fix ties loader visibility to the
// real popup.js DOMContentLoaded listener (not initPopup() directly — this
// exercises the actual production wiring, same as a real popup open) via a
// synthetic DOMContentLoaded dispatch, matching this suite's "go through the
// real listener chain, stub only the messaging transport" convention
// (popup.test.mjs).
beforeAll(() => {
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
    loadExtensionSource('popup.js', [])
})

beforeEach(() => {
    document.body.innerHTML =
        '<div id="loading-container"></div><div id="auth-container"></div>'
    globalThis.currentBrowser.storage.sync.get = (_keys, cb) => cb({})
    vi.useFakeTimers()
})

describe('popup.js DOMContentLoaded — loader tracks the real fetch lifecycle (D4)', () => {
    it('slow-resolving transport: spinner stays visible at +1s, content renders once it resolves', async () => {
        let deliverCoupons
        globalThis.currentBrowser.runtime.sendMessage = (message, cb) => {
            if (message?.action === 'getActiveTabDomainRecord') {
                cb({ url: 'https://example.com/cart' })
            } else if (message?.action === 'fetchCoupons') {
                // Captured, not delivered yet — simulates a request that's
                // still in flight (real-world: up to ~8s).
                deliverCoupons = () =>
                    cb({ coupons: [{ code: 'SAVE10', status: 'valid' }] })
            } else {
                cb(undefined)
            }
        }

        document.dispatchEvent(new Event('DOMContentLoaded'))
        // Flush the synchronous-callback prefix (getActiveTabDomainRecord,
        // the storage.sync.get dispatch) so fetchCoupons's own sendMessage
        // call has actually happened and deliverCoupons is assigned.
        await vi.advanceTimersByTimeAsync(50)
        expect(typeof deliverCoupons).toBe('function')

        const loader = document.getElementById('loading-container')
        expect(loader.style.display).not.toBe('none')

        // Old behavior hid the loader on a flat 400ms timer; the fetch is
        // still pending well past that point here.
        await vi.advanceTimersByTimeAsync(1000)
        expect(loader.style.display).not.toBe('none')
        expect(document.getElementById('couponList')).toBeNull()

        deliverCoupons()
        await vi.advanceTimersByTimeAsync(500)

        expect(loader.style.display).toBe('none')
        expect(document.getElementById('couponList')).not.toBeNull()
    })

    it('rejecting transport: shows the load-error state (not a blank window) and hides the spinner', async () => {
        globalThis.currentBrowser.runtime.sendMessage = (message, cb) => {
            if (message?.action === 'getActiveTabDomainRecord') {
                cb({ url: 'https://example.com/cart' })
            } else if (message?.action === 'fetchCoupons') {
                setTimeout(() => cb({ error: 'HTTP 500' }), 600)
            } else {
                cb(undefined)
            }
        }

        document.dispatchEvent(new Event('DOMContentLoaded'))
        await vi.advanceTimersByTimeAsync(50)

        const loader = document.getElementById('loading-container')
        const authContainer = document.getElementById('auth-container')

        // Still in flight: this is exactly the window D4 left blank
        // (spinner already gone, error content not painted yet). Assert the
        // spinner is still covering it instead of a bare container.
        await vi.advanceTimersByTimeAsync(500)
        expect(loader.style.display).not.toBe('none')
        expect(authContainer.innerHTML).not.toContain("Couldn't load coupons")

        await vi.advanceTimersByTimeAsync(500)

        expect(loader.style.display).toBe('none')
        expect(authContainer.innerHTML).toContain("Couldn't load coupons")
    })
})
