import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { App } from '../entrypoints/popup/App'
import type { AppApi } from '../entrypoints/popup/types'
import { ProfileCard } from '../entrypoints/popup/views/ProfileCard'

// WXT-migration P0 characterization pins (2026-08-12; P2-ported 2026-08-13 to
// @testing-library/react against the React popup).
//
// The profile card is the view a SIGNED-IN user gets whenever the popup
// cannot read a web tab URL — opened on a new tab, on a chrome:// page, or as
// its own window — so it is the only place some users ever see their account
// in the extension, and the only signed-in surface with no coupon list to
// prove it rendered at all.
//
// Three things stay frozen across the rewrite: what it paints (username +
// avatar, with the bundled default when the account has no image), that the
// `token && !url` branch (now resolvePopupState → App) really routes here,
// and that its Log out button reaches the shared revoke path. The logout
// MECHANICS (revoke before clear, offline still signs out) stay pinned in
// popup-logout-revoke.test.mjs — this suite only proves this view's button
// reaches them, so the rewrite cannot ship a profile card whose logout
// quietly does nothing.

let chromeStub: any
let tabUrlAnswer: unknown

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

/** Backs one storage area with a real object (tests/_load.mjs's
 * backStorageArea, inlined), so a test asserts on what the code actually
 * stored instead of on which API it called. */
function backStorageArea(area: string, data: Record<string, unknown> = {}) {
    const store = chromeStub.storage[area]
    store.get = (_keys: unknown, cb: any) => {
        if (typeof cb === 'function') cb({ ...data })
    }
    store.set = (items: Record<string, unknown>, cb: any) => {
        Object.assign(data, items)
        if (typeof cb === 'function') cb()
    }
    store.remove = (keys: string | string[], cb: any) => {
        for (const key of ([] as string[]).concat(keys)) delete data[key]
        if (typeof cb === 'function') cb()
    }
    return data
}

/** A view-level render needs only the App seam, observed not performed. */
const makeApi = (): AppApi & { refresh: ReturnType<typeof vi.fn> } => ({
    openSignIn: vi.fn(),
    closeOverlay: vi.fn(),
    refresh: vi.fn(),
})

beforeAll(() => {
    initCouponConstants()
    chromeStub = installChromeStub()
    chromeStub.tabs.create = () => {}
    window.close = vi.fn()

    chromeStub.runtime.sendMessage = (message: any, cb: any) => {
        if (message?.action === 'getActiveTabDomainRecord') {
            cb(tabUrlAnswer)
        } else {
            cb(undefined)
        }
    }
})

beforeEach(() => {
    // A chrome:// tab is a real signed-in-user-with-no-store situation and the
    // exact input resolvePopupState nulls out, which is what sends it down the
    // profile-card branch.
    tabUrlAnswer = { url: 'chrome://newtab/' }
    // ALWAYS two separate objects: the session lives in local, and a shared
    // object would let caramelGetSession's pre-migration sync adoption path
    // see a token it should never find.
    backStorageArea('local', {
        token: 'stored-token',
        user: { username: 'shopper', image: '' },
    })
    backStorageArea('sync', {})
    // The /api/extension/me probe resolvePopupState fires in parallel. A 5xx
    // is the one answer validateStoredSession treats as "backend hiccup,
    // change nothing" — so it cannot rewrite the stored user mid-assertion.
    globalThis.fetch = (async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
    })) as any
})

describe('popup profile card — what a signed-in user with no store tab sees', () => {
    it('paints the account username and its avatar', () => {
        render(
            <ProfileCard
                user={{
                    username: 'shopper',
                    image: 'https://cdn.example.com/avatar.png',
                }}
                api={makeApi()}
            />,
        )

        expect(screen.getByText('@shopper')).toBeInTheDocument()
        expect(screen.getByAltText('avatar')).toHaveAttribute(
            'src',
            'https://cdn.example.com/avatar.png',
        )
    })

    it('falls back to the bundled default avatar when the account has no image', () => {
        // Both shapes an account with no picture arrives in: absent/null, and
        // the empty string the login response actually sends. `image?.length`
        // is what decides, so '' must fall back rather than render src="".
        for (const user of [
            { username: 'shopper', image: null },
            { username: 'shopper', image: '' },
            { username: 'shopper', image: undefined },
        ]) {
            const view = render(
                <ProfileCard user={user as any} api={makeApi()} />,
            )
            expect(
                screen.getByAltText('avatar'),
                JSON.stringify(user),
            ).toHaveAttribute('src', 'assets/default-profile.png')
            view.unmount()
        }
    })

    it('is the view the App routes to when there is a session but no readable tab URL', async () => {
        const { container } = render(<App />)

        // The old suite asserted on what initPopup painted into
        // #auth-container; the same three facts are read off the React tree:
        // THIS view (the signed-in note belongs to no other), exactly one
        // card, and the STORED user, whose empty image is why the avatar is
        // the bundled default.
        expect(await screen.findByText(/You're signed in/)).toBeInTheDocument()
        expect(
            container.querySelectorAll('.coupons-profile-card'),
        ).toHaveLength(1)
        expect(screen.getByText('@shopper')).toBeInTheDocument()
        expect(screen.getByAltText('avatar')).toHaveAttribute(
            'src',
            'assets/default-profile.png',
        )
    })

    it('shows the settings gear once booted — hidden until a view asks for it — and the gear really opens settings', async () => {
        render(<App />)

        // Boot order pin: the view can land before the 400ms anti-flicker
        // floor lifts, but the gear belongs to the booted chrome — it must
        // not exist while the loader is still up.
        await screen.findByText(/You're signed in/)
        expect(
            screen.queryByRole('button', { name: 'Open settings' }),
        ).not.toBeInTheDocument()

        // styles.css hides .profile-settings by default; the shown gear
        // carries the same explicit display override wireSettingsGear set.
        const gear = await screen.findByRole('button', {
            name: 'Open settings',
        })
        expect(gear).toHaveStyle({ display: 'block' })

        // The vanilla pin was `typeof gear.onclick === 'function'`; the
        // stronger honest fact is that clicking it actually leaves the
        // profile card for the settings surface.
        await userEvent.click(gear)
        await waitFor(() =>
            expect(
                screen.queryByText(/You're signed in/),
            ).not.toBeInTheDocument(),
        )
    })

    it('wires Log out to the shared revoke path rather than clearing storage itself', async () => {
        const api = makeApi()
        render(
            <ProfileCard user={{ username: 'shopper', image: '' }} api={api} />,
        )

        const calls: Array<{ url: string; method?: string }> = []
        globalThis.fetch = (async (url: unknown, opts: any) => {
            calls.push({ url: String(url), method: opts?.method })
            return { ok: true, status: 200, json: async () => ({}) }
        }) as any

        const logoutBtn = screen.getByRole('button', { name: 'Log out' })
        await userEvent.click(logoutBtn)

        // These three mutations are the FIRST thing signOutAndRevoke does,
        // and only to a `button` argument it was actually handed — proof the
        // view passed the pressed control into the shared path.
        expect(logoutBtn).toBeDisabled()
        expect(logoutBtn).toHaveAttribute('data-caramel-busy', '1')
        expect(logoutBtn).toHaveTextContent('Signing out…')

        // …and it reached the SHARED revoke rather than clearing storage on
        // its own: the session is killed server-side first, then the view's
        // after-callback (App.refresh) re-resolves the popup.
        await waitFor(() => expect(calls).toHaveLength(1))
        expect(calls[0]!.method).toBe('DELETE')
        expect(calls[0]!.url).toContain('api/extension/session')
        await waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(1))
    })
})
