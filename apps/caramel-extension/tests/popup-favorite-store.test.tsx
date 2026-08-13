import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initBackground } from '../background.js'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { ToastProvider } from '../entrypoints/popup/components/toast'
import type { AppApi, Coupon, PopupUser } from '../entrypoints/popup/types'
import { CouponsView } from '../entrypoints/popup/views/CouponsView'

// The popup's "follow this store" star (favorites).
//
// Three things are worth a test here and each has already been a bug class in
// this popup:
//
//  1. THE LOGGED-OUT POPUP MUST BE UNCHANGED. The star is signed-in-only, so a
//     guest's header must render what it rendered before — no star, no
//     wrapper, no extra control to mis-tap into a sign-in wall.
//  2. THE HEADER MUST NOT GROW. tests/popup-sizing.test.mjs pins .coupon-list's
//     320px cap against a measured ~279px of chrome stacked above it; a star
//     that added a row would slice the last coupon inside body's
//     overflow:hidden. So: one row, two children, star inside the existing row.
//  3. THE ACTION NAME MUST MATCH THE WORKER'S. popup and background.js agree
//     only by string, and background's unknown-action branch answers
//     {error:'unknown_action'} — which the popup would render as a failed
//     toggle rather than anything obviously broken. The round-trip test below
//     drives the REAL background handler with the REAL message the popup
//     produced, so a rename on either side goes red instead of silent.
//
// P2-ported 2026-08-13 from popup-favorite-store.test.mjs: the vanilla suite
// called renderCouponsView() and read #favoriteStoreBtn; the star is now
// queried the way a screen reader finds it (a toggle button whose accessible
// name is the action it performs), and its disabled/aria-pressed contract is
// unchanged. The producer/consumer round trip through the real worker is
// untouched.

const DOMAIN = 'shop.nike.com'
const USER: PopupUser = { username: 'shopper', image: '' }
const COUPONS: Coupon[] = [
    { code: 'SAVE10', title: '10% off', status: 'valid' },
]

let chromeStub: any
/** background.js's own onMessage handler, captured off the realm's stub. */
let backgroundHandler: any

/** Permissive chrome stub — the makeChromeStub/installChromeStub pair the old
 * tests/_load.mjs harness installed around every eval: anything not explicitly
 * set answers with a callable no-op, storage callbacks fire the way the real
 * API does, runtime.lastError starts UNDEFINED (a permissive proxy would
 * auto-create a truthy callable, which caramel-base.js reads as a closed
 * port), and onMessage.addListener records real listeners so a test can invoke
 * one. */
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
    const listeners: any[] = []
    stub.runtime.onMessage.addListener = (fn: any) => listeners.push(fn)
    stub.runtime.onMessage.removeListener = (fn: any) => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
    }
    stub.runtime.onMessage.hasListener = (fn: any) => listeners.includes(fn)
    ;(globalThis as any).chrome = stub
    ;(globalThis as any).browser = undefined
    ;(window as any).chrome = stub
    ;(window as any).browser = undefined
    // Installed ONCE per suite file — vitest gives each file its own jsdom
    // window, so caramel-base.js's first-run bootstrap latch is still unset and
    // this stub really becomes the realm's currentBrowser.
    initCaramelBase()
    return { stub, listeners }
}

beforeAll(() => {
    const installed = installChromeStub()
    chromeStub = installed.stub
    initCouponConstants()
    // The REAL service worker. Its handler stays callable for the whole file:
    // it closed over the realm's chrome handle and its own caramelUrl, and
    // reaches the network through whatever `fetch` a test installs.
    initBackground()
    ;[backgroundHandler] = installed.listeners
})

/** Answers every runtime message from `replies`, recording what was sent.
 * caramelSendMessage rejects on an `undefined` response, so unknown messages
 * get an explicit empty object rather than nothing. */
function stubMessaging(replies: Record<string, unknown>) {
    const sent: any[] = []
    chromeStub.runtime.sendMessage = (message: any, cb: any) => {
        sent.push(message)
        const reply = (replies as any)[message?.action]
        cb(typeof reply === 'function' ? reply(message) : (reply ?? {}))
    }
    return sent
}

const makeApi = (): AppApi => ({
    openSignIn: vi.fn(),
    closeOverlay: vi.fn(),
    refresh: vi.fn(),
})

/** Lets the star's fire-and-forget message round trips settle when the
 *  assertion is that NOTHING changed (waitFor cannot wait for an absence). */
const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
    })

/** The star as a screen reader finds it: a toggle button whose accessible
 *  name IS the action it performs. */
const STAR_NAME = /^(Follow|Unfollow) shop\.nike\.com$/

const starButton = () => screen.queryByRole('button', { name: STAR_NAME })

function renderCoupons(user: PopupUser | null) {
    return render(
        <ToastProvider>
            <CouponsView
                coupons={COUPONS}
                user={user}
                domain={DOMAIN}
                page={{ coupons: COUPONS }}
                api={makeApi()}
            />
        </ToastProvider>,
    )
}

describe('popup header star — signed in', () => {
    it('renders in the header, starts unpressed and disabled, then reflects the account', async () => {
        stubMessaging({
            getFavoriteStores: { favorites: [{ store: 'nike.com' }] },
        })

        renderCoupons(USER)

        // Before the account answers: present, unpressed, and NOT clickable —
        // an enabled star showing a guessed state invites a click that writes
        // the opposite of what the user is looking at.
        const star = starButton()
        expect(star).not.toBeNull()
        expect(star).toHaveAttribute('aria-pressed', 'false')
        expect(star).toBeDisabled()

        // "shop.nike.com" is followed because the ACCOUNT is keyed on the
        // registrable domain "nike.com" — the suffix-tolerant match is the
        // whole reason this assertion is interesting.
        await waitFor(() =>
            expect(starButton()).toHaveAttribute('aria-pressed', 'true'),
        )
        expect(starButton()).toBeEnabled()
        expect(starButton()).toHaveAccessibleName(`Unfollow ${DOMAIN}`)
    })

    it('stays unpressed for a store the account does not follow', async () => {
        stubMessaging({
            getFavoriteStores: { favorites: [{ store: 'ebay.com' }] },
        })

        renderCoupons(USER)
        await waitFor(() => expect(starButton()).toBeEnabled())

        expect(starButton()).toHaveAttribute('aria-pressed', 'false')
        expect(starButton()).toHaveAccessibleName(`Follow ${DOMAIN}`)
    })

    it('stays disabled — never lying about the state — when the account cannot be reached', async () => {
        stubMessaging({ getFavoriteStores: { error: 'HTTP 401' } })

        renderCoupons(USER)
        await settle()

        expect(starButton()).toBeDisabled()
        expect(starButton()).toHaveAttribute('aria-pressed', 'false')
    })

    it('sits inside the existing header row and adds no row of its own', async () => {
        // The height contract popup-sizing.test.mjs's arithmetic depends on:
        // .coupons-profile-row keeps exactly its two children (info +
        // actions), and the star is a descendant of that row rather than a
        // sibling block.
        stubMessaging({ getFavoriteStores: { favorites: [] } })

        const { container } = renderCoupons(USER)
        await waitFor(() => expect(starButton()).toBeEnabled())

        const rows = container.querySelectorAll('.coupons-profile-row')
        expect(rows).toHaveLength(1)
        expect(rows[0]!.children).toHaveLength(2)
        expect(rows[0]!.contains(starButton())).toBe(true)
        // Reuses the header button's sizing rather than introducing a control
        // with its own height.
        expect(starButton()!.className).toContain('coupons-logout-button')
    })
})

describe('popup header star — logged out', () => {
    it('is absent, and the guest header is exactly what it was before favorites existed', async () => {
        const sent = stubMessaging({})

        const { container } = renderCoupons(null)
        await settle()

        expect(starButton()).toBeNull()
        expect(container.querySelector('.coupons-header-actions')).toBeNull()
        // The guest header is still the single Log in button, unwrapped.
        const row = container.querySelector('.coupons-profile-row')!
        expect(row.children).toHaveLength(2)
        expect(row.lastElementChild).toBe(
            screen.getByRole('button', { name: 'Log in' }),
        )
        // And a signed-out popup must not ask the account anything.
        expect(sent.some(m => m?.action === 'getFavoriteStores')).toBe(false)
        expect(sent.some(m => m?.action === 'setFavoriteStore')).toBe(false)
    })
})

describe('star toggle — round trip through the real service worker', () => {
    /** Replays `message` against the REAL background.js onMessage handler,
     * with fetch stubbed, and reports what it did. */
    async function replayThroughBackground(message: any, response: unknown) {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => response,
        }))
        globalThis.fetch = fetchMock as any
        const reply = await new Promise(resolve =>
            backgroundHandler(message, {}, resolve),
        )
        return { fetchMock, reply }
    }

    it('a click on an unfollowed store sends setFavoriteStore, which the worker turns into a PUT', async () => {
        const sent = stubMessaging({
            getFavoriteStores: { favorites: [] },
            setFavoriteStore: { ok: true, store: 'nike.com', favorited: true },
        })

        renderCoupons(USER)
        await waitFor(() => expect(starButton()).toBeEnabled())
        await userEvent.click(starButton()!)

        const toggle = sent.find(m => m?.action === 'setFavoriteStore')
        expect(toggle).toEqual({
            action: 'setFavoriteStore',
            site: DOMAIN,
            favorite: true,
        })
        // The star now shows the server's answer, not the optimistic guess.
        await waitFor(() =>
            expect(starButton()).toHaveAttribute('aria-pressed', 'true'),
        )
        expect(starButton()).toBeEnabled()

        // …and that exact message, unedited, drives the real worker.
        const { fetchMock, reply } = await replayThroughBackground(toggle, {
            ok: true,
            store: 'nike.com',
            favorited: true,
        })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, opts] = fetchMock.mock.calls[0] as any
        expect(url).toContain(
            `/api/account/favorites/${encodeURIComponent(DOMAIN)}`,
        )
        expect(opts.method).toBe('PUT')
        expect(reply).toEqual({ ok: true, store: 'nike.com', favorited: true })
    })

    it('a click on a followed store sends favorite:false, which the worker turns into a DELETE', async () => {
        const sent = stubMessaging({
            getFavoriteStores: { favorites: [{ store: 'nike.com' }] },
            setFavoriteStore: { ok: true, store: 'nike.com', favorited: false },
        })

        renderCoupons(USER)
        await waitFor(() => expect(starButton()).toBeEnabled())
        await userEvent.click(starButton()!)

        const toggle = sent.find(m => m?.action === 'setFavoriteStore')
        expect(toggle.favorite).toBe(false)
        await waitFor(() =>
            expect(starButton()).toHaveAttribute('aria-pressed', 'false'),
        )

        const { fetchMock } = await replayThroughBackground(toggle, {
            ok: true,
            store: 'nike.com',
            favorited: false,
        })
        const [, opts] = fetchMock.mock.calls[0] as any
        expect(opts.method).toBe('DELETE')
    })

    it('a rejected write puts the star back where it was, and says so', async () => {
        stubMessaging({
            getFavoriteStores: { favorites: [] },
            setFavoriteStore: { error: 'HTTP 500' },
        })

        renderCoupons(USER)
        await waitFor(() => expect(starButton()).toBeEnabled())
        await userEvent.click(starButton()!)

        // Optimistic flip reverted — the popup never claims a follow the
        // account did not record — and the failure is not silent.
        await waitFor(() =>
            expect(
                screen.getByText("Couldn't save that — please try again"),
            ).toBeInTheDocument(),
        )
        expect(starButton()).toHaveAttribute('aria-pressed', 'false')
        expect(starButton()).toBeEnabled()
    })

    it('the worker answers a store it does not know about with unknown_action (the contract a rename would break)', async () => {
        // Documents the failure mode the round-trip tests above exist to catch:
        // if popup and background stop agreeing on the action string, the
        // worker's fallback replies unknown_action and no request is ever made.
        const { fetchMock, reply } = await replayThroughBackground(
            { action: 'setFavouriteStore', site: DOMAIN, favorite: true },
            {},
        )
        expect(reply).toEqual({ error: 'unknown_action' })
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
