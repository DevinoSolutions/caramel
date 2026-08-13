import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import {
    openWebsiteSignIn,
    popupOAuthSupported,
    runSocialSignIn,
} from '../popup-core.js'

// Pins the OAuth fallback for browsers without popup OAuth (issue #139;
// P2-ported 2026-08-13 to the popup-core logic): Firefox ships without
// identity.launchWebAuthFlow, so popupOAuthSupported() must answer false
// there — the React SignInView branches on it, routing the provider buttons
// through openWebsiteSignIn() (the website's /login page in a tab; the
// website→extension session relay lands the session) and rendering the
// "Sign-in opens grabcaramel.com" note. The button routing + note markup are
// pinned in the React SignInView suite; what THIS suite owns is the
// capability answer and what each branch DOES.

/* Realm stub, lifted from tests/_load.mjs (installChromeStub), which the ESM
 * port retires — permissive Proxy, storage callbacks invoked, lastError
 * undefined outside a failing callback (see popup-oauth-success.test.mjs for
 * the rationale block). */
function installChromeStub() {
    const cache = new WeakMap()
    const wrap = target => {
        if (cache.has(target)) return cache.get(target)
        const proxy = new Proxy(target, {
            get(obj, prop) {
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
        stub.storage[area].get = (_keys, cb) => {
            if (typeof cb === 'function') cb({})
        }
        stub.storage[area].set = (_items, cb) => {
            if (typeof cb === 'function') cb()
        }
        stub.storage[area].remove = (_keys, cb) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
    return stub
}

let createdTabs = []

beforeAll(() => {
    installChromeStub()
    initCouponConstants()
    initCaramelBase()
    initCouponRunner()
})

/** Firefox: no identity API anywhere; tab creation recorded. */
const firefoxShape = () => {
    globalThis.currentBrowser.identity = undefined
    globalThis.currentBrowser.chrome = undefined
    globalThis.currentBrowser.tabs.create = opts => {
        createdTabs.push(opts)
    }
}

/** Chrome: identity present with an injected launchWebAuthFlow. */
const chromeShape = launchWebAuthFlow => {
    globalThis.currentBrowser.identity = {
        launchWebAuthFlow,
        getRedirectURL: () => 'https://ext-id.chromiumapp.org/',
    }
    globalThis.currentBrowser.chrome = undefined
    globalThis.currentBrowser.tabs.create = opts => {
        createdTabs.push(opts)
    }
}

beforeEach(() => {
    createdTabs = []
    window.close = vi.fn()
})

describe('popup-core — OAuth fallback without the identity API (Firefox)', () => {
    it('popupOAuthSupported() answers false with no identity API, true with launchWebAuthFlow present', () => {
        firefoxShape()
        expect(popupOAuthSupported()).toBe(false)

        chromeShape(async () => undefined)
        expect(popupOAuthSupported()).toBe(true)

        // Capability check, not UA sniffing: an identity object WITHOUT
        // launchWebAuthFlow still means no popup OAuth.
        globalThis.currentBrowser.identity = {}
        globalThis.currentBrowser.chrome = undefined
        expect(popupOAuthSupported()).toBe(false)
    })

    it('openWebsiteSignIn() opens the website /login page in a tab, closes the popup, and never touches the OAuth endpoints', () => {
        firefoxShape()
        globalThis.fetch = vi.fn()

        openWebsiteSignIn()

        expect(createdTabs).toHaveLength(1)
        expect(createdTabs[0].url).toContain('grabcaramel.com')
        expect(new URL(createdTabs[0].url).pathname).toBe('/login')
        // The in-popup OAuth flow (authorize endpoint) must NOT have fired.
        expect(globalThis.fetch).not.toHaveBeenCalled()
        expect(window.close).toHaveBeenCalled()
    })

    it('keeps the in-popup launchWebAuthFlow path (no tab) when identity IS available', async () => {
        const launchWebAuthFlow = vi.fn(async () => undefined)
        chromeShape(launchWebAuthFlow)
        // runSocialSignIn's first hop: GET /api/extension/oauth/authorize.
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
            }),
        }))

        await runSocialSignIn('google', { onPending() {}, onError() {} })

        expect(globalThis.fetch).toHaveBeenCalled()
        expect(String(globalThis.fetch.mock.calls[0][0])).toContain(
            '/api/extension/oauth/authorize',
        )
        expect(launchWebAuthFlow).toHaveBeenCalled()
        expect(createdTabs).toHaveLength(0)
    })
})
