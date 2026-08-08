import { beforeAll, describe, expect, it, vi } from 'vitest'
import { loadExtensionSource, loadExtensionSources } from './_load.mjs'

// Pins the popup OAuth fallback (issue #139): Firefox deliberately ships
// without the `identity` permission (manifest-sync.test.ts header), so the
// popup's Google/Apple buttons cannot run launchWebAuthFlow there. Instead
// of dying with "OAuth not supported", the buttons must open the website's
// /login page in a tab — the website→extension session relay
// (session-relay.test.mjs) then lands the session in storage.sync. When
// identity IS available (Chrome), the in-popup launchWebAuthFlow path must
// stay untouched.
//
// Harness mirrors popup-auth-validate.test.mjs: real load order, one shared
// chrome stub, only storage + tabs + fetch stubbed. Gotcha the stub forces:
// _load.mjs's chrome stub is a permissive Proxy that AUTO-CREATES any
// missing property (currentBrowser.identity would materialize as a truthy
// no-op), so the Firefox shape must be assigned EXPLICITLY as undefined.
let renderSignInPrompt
let createdTabs

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

    createdTabs = []
    globalThis.currentBrowser.tabs.create = tab => createdTabs.push(tab)
    // jsdom's real window.close() tears the environment down mid-suite.
    window.close = vi.fn()
    ;({ renderSignInPrompt } = loadExtensionSource('popup.js', [
        'renderSignInPrompt',
    ]))
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
