import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { App } from '../entrypoints/popup/App'

// F-002 UI pin (P2-ported 2026-08-13 to @testing-library/react against the
// React App) — proves the honest-failure plumbing all the way through:
// background.js replies {error:'HTTP <status>'} on a non-ok upstream fetch
// (background.test.mjs); coupon-fetch.js's fetchCouponsPage throws on
// resp.error; popup-core's resolvePopupState catches that and resolves the
// load-error state instead of silently falling through to "no coupons for
// this site" (which would misrepresent an OUTAGE as a factual absence of
// coupons — the bug this finding exists for). The App renders that state.
//
// Goes through the real module chain (resolvePopupState → fetchCouponsPage,
// unimported-stub-free) rather than re-implementing the shaping — only the
// messaging transport (currentBrowser.runtime.sendMessage/storage) is
// stubbed, since there's no real background service worker in this harness.

let transportHealthy = false

/** Permissive chrome stub — the makeChromeStub/installChromeStub pair the old
 * tests/_load.mjs harness installed around every eval: anything not
 * explicitly set answers with a callable no-op, storage callbacks fire the
 * way the real API does, and runtime.lastError starts UNDEFINED (a permissive
 * proxy would auto-create a truthy callable, which caramel-base.js reads as a
 * closed port). */
function installChromeStub() {
    const cache = new WeakMap()
    const wrap = (target: any): any => {
        if (cache.has(target)) return cache.get(target)
        const proxy = new Proxy(target, {
            get(obj: any, prop) {
                if (prop === 'then' || typeof prop === 'symbol')
                    return undefined
                if (!(prop in obj)) obj[prop] = wrap(function () {})
                return obj[prop]
            },
            apply: () => undefined,
        })
        cache.set(target, proxy)
        return proxy
    }
    const stub = wrap(function chromeStubRoot() {})
    for (const area of ['sync', 'local', 'session']) {
        stub.storage[area].get = (_keys: unknown, cb: any) => {
            if (typeof cb === 'function') cb({})
        }
        stub.storage[area].set = (_items: unknown, cb: any) => {
            if (typeof cb === 'function') cb()
        }
        stub.storage[area].remove = (_keys: unknown, cb: any) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    ;(globalThis as any).chrome = stub
    ;(globalThis as any).browser = undefined
    ;(window as any).chrome = stub
    ;(window as any).browser = undefined
    // Installed ONCE per suite file — vitest gives each file its own jsdom
    // window, so caramel-base.js's first-run bootstrap latch is still unset
    // and this stub really becomes the realm's currentBrowser.
    initCaramelBase()
    return stub
}

beforeAll(() => {
    initCouponConstants()
    const chromeStub = installChromeStub()

    chromeStub.runtime.sendMessage = (message: any, cb: any) => {
        if (message?.action === 'getActiveTabDomainRecord') {
            cb({ url: 'https://example.com/cart' })
        } else if (message?.action === 'fetchCoupons') {
            cb(
                transportHealthy
                    ? { coupons: [{ code: 'SAVE10', status: 'valid' }] }
                    : { error: 'HTTP 500' },
            )
        } else {
            cb(undefined)
        }
    }
})

describe('App — honest load-failure UI (F-002)', () => {
    it('background {error} on fetchCoupons renders the load-error view, not "no coupons for this site" — and Try again really re-runs the init', async () => {
        transportHealthy = false
        render(<App />)

        expect(
            await screen.findByText("Couldn't load coupons"),
        ).toBeInTheDocument()
        expect(
            screen.queryByText('No coupons for this site yet'),
        ).not.toBeInTheDocument()

        // The vanilla retry re-ran the WHOLE init; the React button must be
        // wired to the same full re-resolve, so a recovered backend replaces
        // the error state instead of leaving a dead button.
        transportHealthy = true
        await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
        await waitFor(() =>
            expect(
                screen.queryByText("Couldn't load coupons"),
            ).not.toBeInTheDocument(),
        )
    })
})
