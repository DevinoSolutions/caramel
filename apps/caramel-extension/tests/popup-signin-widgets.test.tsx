import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import { App } from '../entrypoints/popup/App'
import type { AppApi } from '../entrypoints/popup/types'
import { SignInView } from '../entrypoints/popup/views/SignInView'

// WXT-migration P0 characterization pins (2026-08-12; P2-ported 2026-08-13 to
// @testing-library/react against the React SignInView).
//
// The sign-in prompt's small parts, none of them covered by the five OAuth
// suites that share this view. Each is the kind of detail a rewrite drops
// silently because nothing looks broken in a screenshot:
//
//   1. The password show/hide toggle. It flips the input type AND keeps
//      aria-pressed/aria-label/the icon in sync — a rewrite that only swaps the
//      type leaves a screen reader announcing "Show password" on a field that
//      is already showing it.
//   2. The Back button, and that it really leaves the overlay.
//   3. The settings gear is hidden here. It is a shared header element other
//      views turn ON, so sign-in must actively turn it back off.
//   4. The OAuth capability branch and the provider buttons' in-flight states —
//      the UI half of the OAuth contract. The WIRE half (URLs, bodies, cancel
//      mapping) is pinned against runSocialSignIn in popup-oauth-*; here the
//      only question is what the two buttons do while that wire runs.
//
// P2 reshapes, red-proofed:
//   - Back is unconditional. Vanilla branched it on whether renderSignInPrompt
//     was handed a return view; React reaches sign-in only as an overlay over a
//     resolved view, so "nowhere to go back to" no longer exists as a state.
//   - The eye icons are rendered one at a time instead of both with a
//     display:none on the inactive one.
//   - The gear pin is read off <App/>, which now owns header visibility.

/** Permissive chrome stub — the makeChromeStub/installChromeStub pair the old
 * tests/_load.mjs harness installed around every eval: anything not explicitly
 * set answers with a callable no-op, storage callbacks fire the way the real
 * API does, and runtime.lastError starts UNDEFINED (a permissive proxy would
 * auto-create a truthy callable, which caramel-base.js reads as a closed
 * port). */
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
    // window, so caramel-base.js's first-run bootstrap latch is still unset and
    // this stub really becomes the realm's currentBrowser.
    initCaramelBase()
    return stub
}

let chromeStub: any
let createdTabs: Array<{ url: string }>

const browserRealm = () => (globalThis as any).currentBrowser

/** Chrome: identity present, with an injected launchWebAuthFlow. */
const chromeShape = (launchWebAuthFlow: (...args: any[]) => any) => {
    browserRealm().identity = {
        launchWebAuthFlow,
        getRedirectURL: () => 'https://ext-id.chromiumapp.org/',
    }
    browserRealm().chrome = undefined
}

/** Firefox: no identity API anywhere, so no in-popup OAuth. */
const firefoxShape = () => {
    browserRealm().identity = undefined
    browserRealm().chrome = undefined
}

const makeApi = (): AppApi & { closeOverlay: ReturnType<typeof vi.fn> } => ({
    openSignIn: vi.fn(),
    closeOverlay: vi.fn(),
    refresh: vi.fn(),
})

beforeAll(() => {
    initCouponConstants()
    chromeStub = installChromeStub()
    initCouponRunner()

    chromeStub.runtime.sendMessage = (message: any, cb: any) => {
        // A chrome:// tab is the input resolvePopupState nulls out, which sends
        // a signed-out popup to the unsupported view — the one with a Log in
        // button, which is how a user reaches sign-in.
        if (message?.action === 'getActiveTabDomainRecord') {
            cb({ url: 'chrome://newtab/' })
        } else {
            cb(undefined)
        }
    }
})

beforeEach(() => {
    createdTabs = []
    browserRealm().tabs.create = (opts: { url: string }) => {
        createdTabs.push(opts)
    }
    window.close = vi.fn()
    chromeShape(async () => undefined)
    globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
    })) as any
})

const passwordField = () => screen.getByLabelText('Password')
const toggle = () =>
    screen.getByRole('button', { name: /^(Show|Hide) password$/ })

describe('popup sign-in prompt — password show/hide toggle', () => {
    beforeEach(() => {
        render(<SignInView api={makeApi()} />)
    })

    it('starts masked, with the button announcing the action it offers', () => {
        expect(passwordField()).toHaveAttribute('type', 'password')
        expect(toggle()).toHaveAttribute('aria-pressed', 'false')
        expect(toggle()).toHaveAccessibleName('Show password')
        expect(document.querySelector('#eyeIcon')).toBeInTheDocument()
        expect(document.querySelector('#eyeOffIcon')).not.toBeInTheDocument()
    })

    it('reveals the password and flips the accessible state and icon with it', async () => {
        await userEvent.click(toggle())

        expect(passwordField()).toHaveAttribute('type', 'text')
        expect(toggle()).toHaveAttribute('aria-pressed', 'true')
        expect(toggle()).toHaveAccessibleName('Hide password')
        expect(document.querySelector('#eyeOffIcon')).toBeInTheDocument()
        expect(document.querySelector('#eyeIcon')).not.toBeInTheDocument()
    })

    it('masks it again on a second press, back to the exact starting state', async () => {
        await userEvent.click(toggle())
        await userEvent.click(toggle())

        expect(passwordField()).toHaveAttribute('type', 'password')
        expect(toggle()).toHaveAttribute('aria-pressed', 'false')
        expect(toggle()).toHaveAccessibleName('Show password')
        expect(document.querySelector('#eyeIcon')).toBeInTheDocument()
        expect(document.querySelector('#eyeOffIcon')).not.toBeInTheDocument()
    })

    it('does not disturb what the user typed', async () => {
        await userEvent.type(passwordField(), 'hunter2')

        await userEvent.click(toggle())

        expect(passwordField()).toHaveValue('hunter2')
    })
})

describe('popup sign-in prompt — the Back button', () => {
    it('returns to the view the shopper came from', async () => {
        const api = makeApi()
        render(<SignInView api={api} />)

        await userEvent.click(screen.getByRole('button', { name: '← Back' }))

        expect(api.closeOverlay).toHaveBeenCalledTimes(1)
    })

    it('really leaves the sign-in overlay when pressed inside the popup', async () => {
        render(<App />)

        await userEvent.click(
            await screen.findByRole('button', { name: 'Log in' }),
        )
        expect(
            screen.getByRole('button', { name: 'Sign in with Google' }),
        ).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', { name: '← Back' }))

        await waitFor(() =>
            expect(
                screen.queryByRole('button', { name: 'Sign in with Google' }),
            ).not.toBeInTheDocument(),
        )
        expect(
            screen.getByRole('button', { name: 'Log in' }),
        ).toBeInTheDocument()
    })
})

describe('popup sign-in prompt — the settings gear', () => {
    it('is hidden here, even though the view underneath turned it on', async () => {
        render(<App />)

        // The resolved view below shows the gear…
        const gear = await screen.findByRole('button', {
            name: 'Open settings',
        })
        expect(gear).toBeInTheDocument()

        // …and opening sign-in takes it away: a signed-out popup must not
        // strand a settings gear over a login form.
        await userEvent.click(screen.getByRole('button', { name: 'Log in' }))

        await waitFor(() =>
            expect(
                screen.queryByRole('button', { name: 'Open settings' }),
            ).not.toBeInTheDocument(),
        )
    })
})

describe('popup sign-in prompt — the OAuth capability branch', () => {
    it('says nothing extra where the popup can run OAuth itself', () => {
        render(<SignInView api={makeApi()} />)

        expect(
            screen.queryByText(/Sign-in opens grabcaramel\.com/),
        ).not.toBeInTheDocument()
    })

    it('explains the hand-off, and sends the shopper to the website, where it cannot', async () => {
        // Firefox ships no identity permission, so launchWebAuthFlow is absent
        // and the provider buttons mean something different — say so before
        // the click rather than after.
        firefoxShape()
        render(<SignInView api={makeApi()} />)

        expect(
            screen.getByText(
                'Sign-in opens grabcaramel.com; the extension picks it up automatically.',
            ),
        ).toBeInTheDocument()

        await userEvent.click(
            screen.getByRole('button', { name: 'Sign in with Apple' }),
        )

        expect(createdTabs).toHaveLength(1)
        expect(new URL(createdTabs[0]!.url).pathname).toBe('/login')
        expect(window.close).toHaveBeenCalled()
        // The in-popup OAuth flow must NOT have fired.
        expect(
            screen.getByRole('button', { name: 'Sign in with Apple' }),
        ).toBeEnabled()
    })
})

describe('popup sign-in prompt — the provider buttons while OAuth is in flight', () => {
    /** Holds launchWebAuthFlow open so the in-flight state can be observed. */
    const deferredLaunch = () => {
        let settle: (value: unknown) => void = () => {}
        let fail: (reason: Error) => void = () => {}
        chromeShape(
            () =>
                new Promise((resolve, reject) => {
                    settle = resolve
                    fail = reject
                }),
        )
        globalThis.fetch = (async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
            }),
        })) as any
        return {
            cancel: () => fail(new Error('The user did not approve access.')),
            finish: settle,
        }
    }

    it('disables BOTH providers and labels only the one that was clicked', async () => {
        deferredLaunch()
        render(<SignInView api={makeApi()} />)
        const google = screen.getByRole('button', {
            name: 'Sign in with Google',
        })
        const apple = screen.getByRole('button', { name: 'Sign in with Apple' })

        await userEvent.click(google)

        // Only one launchWebAuthFlow can be in flight, so the other provider is
        // genuinely unavailable until this one settles — say so by disabling
        // it. Labelling both would describe a state the browser is not in.
        await waitFor(() => expect(google).toHaveTextContent('Redirecting...'))
        expect(google).toBeDisabled()
        expect(apple).toBeDisabled()
        expect(apple).toHaveTextContent('Sign in with Apple')
    })

    it('re-enables and relabels BOTH when the attempt fails, and says why', async () => {
        const launch = deferredLaunch()
        render(<SignInView api={makeApi()} />)
        const google = screen.getByRole('button', {
            name: 'Sign in with Google',
        })
        const apple = screen.getByRole('button', { name: 'Sign in with Apple' })

        await userEvent.click(google)
        await waitFor(() => expect(google).toBeDisabled())
        launch.cancel()

        // Closing the provider window is a CANCEL, not a failure — the copy is
        // popup-core's (pinned there); what this view owns is that the buttons
        // come back rather than staying stuck mid-flight.
        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Sign-in was cancelled.',
        )
        expect(google).toBeEnabled()
        expect(apple).toBeEnabled()
        expect(google).toHaveTextContent('Sign in with Google')
        expect(apple).toHaveTextContent('Sign in with Apple')
    })

    it('clears a previous failure when the next attempt starts', async () => {
        const first = deferredLaunch()
        render(<SignInView api={makeApi()} />)
        const google = screen.getByRole('button', {
            name: 'Sign in with Google',
        })

        await userEvent.click(google)
        await waitFor(() => expect(google).toBeDisabled())
        first.cancel()
        await screen.findByRole('alert')

        deferredLaunch()
        await userEvent.click(
            screen.getByRole('button', { name: 'Sign in with Google' }),
        )

        await waitFor(() =>
            expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
        )
    })
})
