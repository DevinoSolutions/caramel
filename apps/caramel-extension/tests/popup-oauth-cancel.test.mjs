import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadExtensionSource, loadExtensionSources } from './_load.mjs'

// Two OAuth defects found by a live audit (2026-08-05), both in the states a
// user hits by CLOSING the provider window — the most common OAuth outcome
// after success, and the one nobody screenshots:
//
//   1. Chrome REJECTS launchWebAuthFlow when the window is closed (it does not
//      resolve undefined), so handleSocialSignIn's `!finalCallbackUrl` guard
//      never ran and its friendly copy was dead code. What shipped was
//      Chrome's own third-person string — "OAuth sign-in failed: The user did
//      not approve access." — which reads as a product failure and blames the
//      user for the click they just made.
//   2. Only the CLICKED provider was disabled during a flow, so clicking the
//      other one put BOTH buttons in "Redirecting..." while exactly one
//      provider window existed.
//
// Harness mirrors popup-oauth-fallback.test.mjs. The chrome stub is a
// permissive Proxy that auto-creates missing properties, so identity is
// assigned explicitly.
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
})

/** Chrome shape: identity present, launchWebAuthFlow behaviour injected. */
const withIdentity = launchWebAuthFlow => {
    globalThis.currentBrowser.identity = {
        launchWebAuthFlow,
        getRedirectURL: () => 'https://ext-id.chromiumapp.org/',
    }
    globalThis.currentBrowser.chrome = undefined
}

/** The backend hop handleSocialSignIn makes before launching the flow. */
const stubAuthorizeEndpoint = () => {
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        }),
    })
}

const clickProvider = async id => {
    document.getElementById(id).click()
    // handleSocialSignIn is async and not awaited by the click handler.
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
}

const errorText = () => document.getElementById('loginErrorMessage').textContent

beforeEach(async () => {
    stubAuthorizeEndpoint()
    await renderSignInPrompt()
})

describe('popup OAuth — closing the provider window', () => {
    it('calls a cancel a cancel, not a failure, when Chrome rejects with its own wording', async () => {
        withIdentity(async () => {
            throw new Error('The user did not approve access.')
        })

        await clickProvider('googleSignInBtn')

        expect(errorText()).toBe('Sign-in was cancelled.')
        expect(errorText()).not.toMatch(/failed/i)
        expect(errorText()).not.toMatch(/did not approve/i)
    })

    it('still reports a GENUINE failure as a failure', async () => {
        withIdentity(async () => {
            throw new Error('Network request failed')
        })

        await clickProvider('googleSignInBtn')

        expect(errorText()).toMatch(/OAuth sign-in failed/)
        expect(errorText()).toMatch(/Network request failed/)
    })

    it('re-enables BOTH providers after a cancel, so neither is left stuck', async () => {
        withIdentity(async () => {
            throw new Error('The user did not approve access.')
        })

        await clickProvider('appleSignInBtn')

        expect(document.getElementById('googleSignInBtn').disabled).toBe(false)
        expect(document.getElementById('appleSignInBtn').disabled).toBe(false)
        expect(
            document.getElementById('appleSignInBtn').querySelector('span')
                .textContent,
        ).toBe('Sign in with Apple')
    })

    it('locks out the other provider while a flow is in flight, instead of showing two "Redirecting..." buttons', async () => {
        // Never settles: models a provider window sitting open.
        withIdentity(() => new Promise(() => {}))

        await clickProvider('googleSignInBtn')

        const google = document.getElementById('googleSignInBtn')
        const apple = document.getElementById('appleSignInBtn')
        expect(google.disabled).toBe(true)
        expect(apple.disabled).toBe(true)
        // Only the clicked provider claims to be redirecting.
        expect(google.querySelector('span').textContent).toBe('Redirecting...')
        expect(apple.querySelector('span').textContent).toBe(
            'Sign in with Apple',
        )
    })
})
