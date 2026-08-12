import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import { renderSignInPrompt } from '../popup.js'

// Pins the popup OAuth fallback (issue #139): Firefox deliberately ships
// without the `identity` permission (manifest-sync.test.ts header), so the
// popup's Google/Apple buttons cannot run launchWebAuthFlow there. Instead
// of dying with "OAuth not supported", the buttons must open the website's
// /login page in a tab — the website→extension session relay
// (session-relay.test.mjs) then lands the session in storage.sync. When
// identity IS available (Chrome), the in-popup launchWebAuthFlow path must
// stay untouched.
//
// Harness mirrors popup-auth-validate.test.mjs: the popup realm's own inits in
// index.html order, one shared chrome stub, only storage + tabs + fetch
// stubbed. Gotcha the stub forces: it is a permissive Proxy that AUTO-CREATES
// any missing property (currentBrowser.identity would materialize as a truthy
// no-op), so the Firefox shape must be assigned EXPLICITLY as undefined.
let createdTabs

/* Realm stub, lifted from tests/_load.mjs (installChromeStub), which the ESM
 * port retires. Permissive Proxy: any unknown property materializes as a
 * callable no-op, so a source file touching an API this suite doesn't care
 * about cannot abort it. Two deliberate exceptions, exactly as _load.mjs had
 * them — storage.*.get/set/remove invoke their callbacks like the real API
 * (empty storage), and runtime.lastError stays UNDEFINED outside a failing
 * callback, because the proxy would otherwise auto-create a truthy callable
 * that caramelSendMessage reads as a closed port. */
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

beforeAll(() => {
    document.body.innerHTML =
        '<div id="loading-container"></div>' +
        '<button id="settingsIcon" style="display:none"></button>' +
        '<div id="auth-container"></div>'

    // The realm's effects, in entrypoints/popup/main.ts order — the successor
    // to the <script> list this suite used to eval.
    installChromeStub()
    initCouponConstants()
    initCaramelBase()
    initCouponRunner()

    createdTabs = []
    globalThis.currentBrowser.tabs.create = tab => createdTabs.push(tab)
    // jsdom's real window.close() tears the environment down mid-suite.
    window.close = vi.fn()
})

const firefoxShape = () => {
    // No identity permission → the API namespace itself is undefined.
    globalThis.currentBrowser.identity = undefined
    globalThis.currentBrowser.chrome = undefined
}

const chromeShape = launchWebAuthFlow => {
    globalThis.currentBrowser.identity = {
        launchWebAuthFlow,
        getRedirectURL: () => 'https://ext-id.chromiumapp.org/',
    }
}

describe('popup.js renderSignInPrompt — OAuth fallback without the identity API (Firefox)', () => {
    it('renders the website sign-in note and routes the Google button to the /login page instead of launchWebAuthFlow', async () => {
        firefoxShape()
        createdTabs = []
        globalThis.fetch = vi.fn()

        renderSignInPrompt()
        const html = document.getElementById('auth-container').innerHTML
        expect(html).toContain('oauth-note')

        document.getElementById('googleSignInBtn').click()
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(createdTabs).toHaveLength(1)
        expect(createdTabs[0].url).toContain('grabcaramel.com')
        expect(new URL(createdTabs[0].url).pathname).toBe('/login')
        // The in-popup OAuth flow (authorize endpoint) must NOT have fired.
        expect(globalThis.fetch).not.toHaveBeenCalled()
        expect(window.close).toHaveBeenCalled()
    })

    it('routes the Apple button through the same website fallback', async () => {
        firefoxShape()
        createdTabs = []

        renderSignInPrompt()
        document.getElementById('appleSignInBtn').click()
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(createdTabs).toHaveLength(1)
        expect(new URL(createdTabs[0].url).pathname).toBe('/login')
    })

    it('keeps the in-popup launchWebAuthFlow path (no note, no tab) when identity IS available', async () => {
        const launchWebAuthFlow = vi.fn(async () => undefined)
        chromeShape(launchWebAuthFlow)
        createdTabs = []
        // handleSocialSignIn's first hop: GET /api/extension/oauth/authorize.
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
            }),
        }))

        renderSignInPrompt()
        const html = document.getElementById('auth-container').innerHTML
        expect(html).not.toContain('oauth-note')

        document.getElementById('googleSignInBtn').click()
        // Let the async handleSocialSignIn chain reach launchWebAuthFlow.
        for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setTimeout(resolve, 0))
        }

        expect(globalThis.fetch).toHaveBeenCalled()
        expect(String(globalThis.fetch.mock.calls[0][0])).toContain(
            '/api/extension/oauth/authorize',
        )
        expect(launchWebAuthFlow).toHaveBeenCalled()
        expect(createdTabs).toHaveLength(0)
    })
})
