import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { App } from '../entrypoints/popup/App'

// Settings-gear visibility contract (P2-ported 2026-08-13 to
// @testing-library/react against the React App): the MAIN signed-in path — a
// logged-in user on a supported store — lands on the coupons view, which must
// show the gear. Before the vanilla pin existed only the no-tab profile card
// set it, so the gear silently never appeared in the dominant real-world
// view. In P2 the gear belongs to the App header (one owner instead of four
// wireSettingsGear call sites); this suite pins the coupons branch, the
// profile-card suite pins its own branch plus the hidden-until-booted half.

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
            cb({
                coupons: [
                    { code: 'SAVE10', title: 'Save 10%', status: 'valid' },
                ],
            })
        } else {
            cb(undefined)
        }
    }
    chromeStub.storage.local.get = (_keys: unknown, cb: any) =>
        cb({ token: 'test-token', user: { username: 'tester', image: '' } })
    // The /me probe fired in parallel: 5xx = "backend hiccup, change nothing".
    globalThis.fetch = (async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
    })) as any
})

describe('App header — settings gear contract on the coupons view', () => {
    it('shows the gear for a signed-in user on a supported store', async () => {
        render(<App />)

        const gear = await screen.findByRole('button', {
            name: 'Open settings',
        })
        // styles.css hides .profile-settings by default; the shown gear
        // carries the same explicit display override wireSettingsGear set.
        expect(gear).toHaveStyle({ display: 'block' })

        // Guard that this really is the coupons branch: none of the other
        // resolved views painted. (The coupons markup itself is pinned by
        // the CouponsView suites.)
        expect(
            screen.queryByText("Couldn't load coupons"),
        ).not.toBeInTheDocument()
        expect(
            screen.queryByText('No coupons for this site yet'),
        ).not.toBeInTheDocument()
        expect(screen.queryByText(/You're signed in/)).not.toBeInTheDocument()
    })
})
