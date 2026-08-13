import { render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import type { AppApi } from '../entrypoints/popup/types'
import { UnsupportedView } from '../entrypoints/popup/views/UnsupportedView'

// One screen was answering three different questions with the same sentence.
// (P2-ported 2026-08-13 to @testing-library/react against UnsupportedView —
// the vanilla renderUnsupportedSite pins, unchanged in substance.)
//
// "No coupons for this site yet" is a verdict ABOUT A STORE — but this view is
// also where the popup lands when there is no store at all: a new tab, a PDF, a
// settings page, anywhere the extension cannot read a URL. Clicking the toolbar
// icon before going shopping is the most likely first thing a new user ever
// does with Caramel, and it answered with a judgement on a shop they were not
// in, plus a link to "the stores we support" that reads as an apology.
//
// It is also the only place the popup can say what the product IS. QA's
// first-time users had to work that out from a pill that shows up on a checkout;
// nothing in the extension ever introduces itself. The moment someone opens it
// with no store in front of them is precisely when that sentence helps.
//
// The third case — "we cover this store, nothing is working right now" — is
// pinned in tests/supported-but-no-codes.test.mjs (the lookup) and stays
// additive here: the store answer below is an empty list, so the copy painted
// first must stand.

let chromeStub: any

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

const makeApi = (): AppApi => ({
    openSignIn: vi.fn(),
    closeOverlay: vi.fn(),
    refresh: vi.fn(),
})

beforeAll(() => {
    chromeStub = installChromeStub()
})

beforeEach(() => {
    chromeStub.runtime.lastError = null
    chromeStub.runtime.sendMessage = vi.fn((_msg: unknown, cb: any) =>
        cb({ supported: [] }),
    )
})

describe('opened with no store in front of the user', () => {
    it('does not deliver a verdict about a store', () => {
        render(<UnsupportedView user={null} api={makeApi()} />)

        expect(screen.getByRole('heading', { level: 3 })).not.toHaveTextContent(
            /no coupons for this site/i,
        )
    })

    it('says what Caramel actually does', () => {
        render(<UnsupportedView user={null} api={makeApi()} />)

        expect(screen.getByText(/coupon codes/i)).toBeInTheDocument()
        expect(screen.getByText(/checkout/i)).toBeInTheDocument()
    })

    it('tells the user what to do next', () => {
        render(<UnsupportedView user={null} api={makeApi()} />)

        expect(screen.getByText(/cart/i)).toBeInTheDocument()
    })

    it('still offers the list of stores, which is a real answer here', () => {
        render(<UnsupportedView user={null} api={makeApi()} />)

        expect(
            screen.getByRole('link', { name: 'View Supported Stores' }),
        ).toBeInTheDocument()
    })

    it('still offers the sign-in door, and it opens the sign-in overlay', async () => {
        const api = makeApi()
        render(<UnsupportedView user={null} api={api} />)

        // The vanilla pin stopped at "#loginToggleBtn exists"; the React door
        // is the App seam, so the stronger honest fact is that it really asks
        // the App for the sign-in overlay.
        const login = screen.getByRole('button', { name: 'Log in' })
        login.click()
        expect(api.openSignIn).toHaveBeenCalledTimes(1)
    })

    it('offers log out instead when someone is signed in', () => {
        render(
            <UnsupportedView
                user={{ username: 'shopper', image: null }}
                api={makeApi()}
            />,
        )

        expect(
            screen.getByRole('button', { name: 'Log out' }),
        ).toBeInTheDocument()
        expect(
            screen.queryByRole('button', { name: 'Log in' }),
        ).not.toBeInTheDocument()
    })
})

describe('opened on a store we do not cover', () => {
    it('still says so, in the store’s own terms', () => {
        render(
            <UnsupportedView
                user={null}
                domain="en.wikipedia.org"
                api={makeApi()}
            />,
        )

        expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(
            /no coupons for this site/i,
        )
        expect(
            screen.getByText(/stores we support|ones we support/i),
        ).toBeInTheDocument()
    })
})
