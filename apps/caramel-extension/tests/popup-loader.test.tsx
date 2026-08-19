import { render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { App } from '../entrypoints/popup/App'

// D4 pin (audit/ext-e2e-report.md #5, ext-config-trace.md §5.4; P2-ported
// 2026-08-13 to @testing-library/react against the React App) — the popup
// loader used to hide on a fixed 400ms setTimeout, completely detached from
// the actual coupon request (which can take up to background.js's
// FETCH_TIMEOUT_MS, 8s). E2E reproduced the resulting blank `auth-container`
// gap on a slow/degraded connection. The React boot keeps the fix: the
// loader (caramel-ui Spinner, role=status) stays up until BOTH the 400ms
// anti-flicker floor AND the real resolve have landed.
//
// Real timers + hand-delivered transport callbacks instead of fake timers:
// the in-flight window is held open by NOT invoking the captured callback,
// so there is no race against React's own scheduling to advance past.

let deliver: (() => void) | null = null

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const loader = () => screen.queryByRole('status', { name: /loading/i })

let chromeStub: any

beforeAll(() => {
    initCouponConstants()
    chromeStub = installChromeStub()

    // See the same note in tests/popup.test.tsx: a failed coupon fetch now
    // asks permission-state.js why before it paints (2026-08-19). Both halves
    // are stubbed healthy so this pin keeps owning the loader LIFECYCLE and
    // nothing else — and so the probe never reaches the real network, which
    // would make the rejecting-transport case depend on the machine's
    // connectivity rather than on the transport under test.
    chromeStub.permissions.contains = (_perms: unknown, cb: any) => cb(true)
    globalThis.fetch = () => Promise.resolve(new Response('{}'))
})

beforeEach(() => {
    deliver = null
})

/** Transport whose fetchCoupons answer is held until the test releases it. */
function armHeldTransport(answer: unknown) {
    chromeStub.runtime.sendMessage = (message: any, cb: any) => {
        if (message?.action === 'getActiveTabDomainRecord') {
            cb({ url: 'https://example.com/cart' })
        } else if (message?.action === 'fetchCoupons') {
            deliver = () => cb(answer)
        } else {
            cb(undefined)
        }
    }
}

describe('App boot — loader tracks the real fetch lifecycle (D4)', () => {
    it('slow-resolving transport: spinner stays visible well past 400ms, content renders once it resolves', async () => {
        armHeldTransport({
            coupons: [{ code: 'SAVE10', status: 'valid' }],
        })
        render(<App />)

        await waitFor(() => expect(deliver).toBeTypeOf('function'))

        // Old behavior hid the loader on a flat 400ms timer; the fetch is
        // still pending well past that point here.
        await sleep(700)
        expect(loader()).toBeInTheDocument()

        deliver!()
        await waitFor(() => expect(loader()).not.toBeInTheDocument())
        // The coupons branch was chosen — none of the failure/absence views
        // painted. (The coupons markup itself is pinned by the CouponsView
        // suites; this pin owns only the loader lifecycle.)
        expect(
            screen.queryByText("Couldn't load coupons"),
        ).not.toBeInTheDocument()
        expect(
            screen.queryByText('No coupons for this site yet'),
        ).not.toBeInTheDocument()
    })

    it('rejecting transport: shows the load-error state (not a blank window) and only then drops the spinner', async () => {
        armHeldTransport({ error: 'HTTP 500' })
        render(<App />)

        await waitFor(() => expect(deliver).toBeTypeOf('function'))

        // Still in flight: this is exactly the window D4 left blank (spinner
        // already gone, error content not painted yet). Assert the spinner is
        // still covering it instead of a bare container.
        await sleep(500)
        expect(loader()).toBeInTheDocument()
        expect(
            screen.queryByText("Couldn't load coupons"),
        ).not.toBeInTheDocument()

        deliver!()
        await waitFor(() => expect(loader()).not.toBeInTheDocument())
        expect(screen.getByText("Couldn't load coupons")).toBeInTheDocument()
    })
})
