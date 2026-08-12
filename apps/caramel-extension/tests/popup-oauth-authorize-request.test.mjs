import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    backStorageArea,
    loadExtensionSource,
    loadExtensionSources,
} from './_load.mjs'

// WXT-migration P0 characterization pins (2026-08-12): the REQUEST half of the
// popup OAuth flow. popup-oauth-success/cancel.test.mjs pin the response half
// thoroughly, but nothing asserted what we SEND — the authorize URL's shape,
// that the redirect_uri is identity.getRedirectURL()'s output (encoded), that
// the provider window is launched interactive and with the backend's own
// authorizationUrl — nor the authorize-hop failure branches, the
// resolve-undefined cancel, the session-write lastError path, or the
// visibility gate on re-render. Those are exactly what a rewrite rewrites.
// Mechanics under pin: popup.js handleSocialSignIn (:668-855).
//
// Harness mirrors popup-oauth-cancel.test.mjs.

let renderSignInPrompt

beforeAll(() => {
    document.body.innerHTML =
        '<div id="loading-container"></div>' +
        '<button id="settingsIcon" style="display:none"></button>' +
        '<div id="auth-container"></div>'

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
    globalThis.currentBrowser.tabs.create = () => {}
    window.close = vi.fn()
    ;({ renderSignInPrompt } = loadExtensionSource('popup.js', [
        'renderSignInPrompt',
    ]))
    realCaramelSetSession = globalThis.caramelSetSession
})

// The lastError test swaps caramelSetSession out; every test starts real.
let realCaramelSetSession

const REDIRECT = 'https://ext-id.chromiumapp.org/'

/** identity present; launchWebAuthFlow behaviour injected, calls recorded. */
const withIdentity = launchWebAuthFlow => {
    const launches = []
    globalThis.currentBrowser.identity = {
        launchWebAuthFlow: args => {
            launches.push(args)
            return launchWebAuthFlow(args)
        },
        getRedirectURL: () => REDIRECT,
    }
    globalThis.currentBrowser.chrome = undefined
    return launches
}

/** Recording fetch: authorize GET then (optionally) the exchange POST. */
const recordFetch = ({
    authorize = {
        ok: true,
        json: async () => ({
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        }),
    },
    exchange = {
        ok: true,
        json: async () => ({ token: 'tok', username: 'ada', image: null }),
    },
} = {}) => {
    const calls = []
    globalThis.fetch = async (url, opts) => {
        calls.push({ url: String(url), opts })
        return String(url).includes('/api/extension/oauth/authorize')
            ? authorize
            : exchange
    }
    return calls
}

const clickProvider = async id => {
    document.getElementById(id).click()
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
}

const errorText = () => document.getElementById('loginErrorMessage').textContent

beforeEach(async () => {
    globalThis.caramelSetSession = realCaramelSetSession
    recordFetch()
    await renderSignInPrompt()
})

describe('popup OAuth — the authorize request we send', () => {
    it('builds the authorize URL from the env base, the clicked provider, and the ENCODED getRedirectURL() output, then launches the backend-issued URL interactively', async () => {
        const calls = recordFetch()
        // Provider window stays open: the request half is fully observable
        // without ever settling the flow.
        const launches = withIdentity(() => new Promise(() => {}))

        await clickProvider('googleSignInBtn')

        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe(
            `${CARAMEL_ENV.baseUrl}/api/extension/oauth/authorize?provider=google&redirect_uri=${encodeURIComponent(REDIRECT)}`,
        )
        expect(launches).toEqual([
            {
                url: 'https://accounts.google.com/o/oauth2/v2/auth',
                interactive: true,
            },
        ])
    })

    it('sends provider=apple for the Apple button, same URL grammar', async () => {
        const calls = recordFetch()
        withIdentity(() => new Promise(() => {}))

        await clickProvider('appleSignInBtn')

        expect(calls[0].url).toBe(
            `${CARAMEL_ENV.baseUrl}/api/extension/oauth/authorize?provider=apple&redirect_uri=${encodeURIComponent(REDIRECT)}`,
        )
    })

    it("surfaces the backend's own error when the authorize hop answers non-ok, and never launches a window", async () => {
        recordFetch({
            authorize: {
                ok: false,
                status: 503,
                json: async () => ({ error: 'OAuth backend down' }),
            },
        })
        const launches = withIdentity(() => new Promise(() => {}))

        await clickProvider('googleSignInBtn')

        expect(errorText()).toBe('OAuth sign-in failed: OAuth backend down')
        expect(launches).toEqual([])
        expect(document.getElementById('googleSignInBtn').disabled).toBe(false)
        expect(document.getElementById('appleSignInBtn').disabled).toBe(false)
    })

    it('treats a 200 with no authorizationUrl as a failure, not a launch of `undefined`', async () => {
        recordFetch({ authorize: { ok: true, json: async () => ({}) } })
        const launches = withIdentity(() => new Promise(() => {}))

        await clickProvider('googleSignInBtn')

        expect(errorText()).toMatch(/Failed to get OAuth authorization URL/)
        expect(launches).toEqual([])
    })
})

describe('popup OAuth — settle paths the response suites never reach', () => {
    it('an engine that RESOLVES undefined on window-close still reads as a cancel', async () => {
        // Chrome rejects instead (pinned in popup-oauth-cancel.test.mjs); the
        // !finalCallbackUrl guard covers engines that resolve undefined.
        withIdentity(async () => undefined)

        await clickProvider('googleSignInBtn')

        expect(errorText()).toBe('Sign-in was cancelled.')
    })

    it('a session write that fails via chrome.runtime.lastError surfaces the reason and stays signed out', async () => {
        withIdentity(async () => `${REDIRECT}?code=CODE123&state=S1`)
        globalThis.initPopup = vi.fn()
        // Real chrome semantics: lastError is set only inside the failing
        // callback. caramelSetSession is a top-level function declaration, so
        // the eval realm resolves it through globalThis — replaceable here.
        globalThis.caramelSetSession = (_session, cb) => {
            globalThis.chrome.runtime.lastError = { message: 'disk full' }
            cb()
            globalThis.chrome.runtime.lastError = undefined
        }

        await clickProvider('googleSignInBtn')
        await vi.waitFor(() =>
            expect(errorText()).toBe('OAuth sign-in failed: disk full'),
        )

        expect(globalThis.initPopup).not.toHaveBeenCalled()
        expect(document.getElementById('googleSignInBtn').disabled).toBe(false)
    })

    it('a popup already hidden (no caller) banks the session but does not re-render', async () => {
        withIdentity(async () => `${REDIRECT}?code=CODE123&state=S1`)
        const local = backStorageArea('local', {})
        backStorageArea('sync', {})
        globalThis.initPopup = vi.fn()
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'hidden',
        })

        try {
            await clickProvider('googleSignInBtn')
            await vi.waitFor(() => expect(local.token).toBe('tok'))
            // The settle delay (popup.js:815) has already elapsed once the
            // token is visible; the gate (:819) must have skipped the render.
            expect(globalThis.initPopup).not.toHaveBeenCalled()
        } finally {
            delete document.visibilityState
        }
    })
})
