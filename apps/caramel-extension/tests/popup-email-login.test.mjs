import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadExtensionSource, loadExtensionSources } from './_load.mjs'

// WXT-migration P0 characterization pins (2026-08-12)
//
// The email/password login form (popup.js:1032-1079) is the ONE sign-in path
// with no automated coverage of what a user sees when it goes wrong — the
// happy path is proven E2E against prod, and OAuth has four suites of its own.
// The React popup rewrite reimplements this handler, so its FAILURE copy and
// its one piece of conditional UI (the "Verify your email" link) are frozen
// here first. These pins describe the CURRENT vanilla behavior exactly; they
// are not an endorsement of the copy (see the two notes below), they are the
// contract the rewrite must either reproduce or consciously change.
//
// Note 1 — every failure reads "Login failed: <reason>". The non-ok branch
// does not render the server's message itself: it THROWS it (popup.js:1068)
// and the single catch at :1076 prefixes every message it receives. So a
// server saying "Invalid credentials" surfaces as "Login failed: Invalid
// credentials", not as the bare string.
//
// Note 2 — a non-ok response carrying no `error` field therefore stutters:
// the fallback is itself the string 'Login failed' (:1055), which the catch
// then prefixes, producing "Login failed: Login failed". Pinned as-is.
//
// Harness mirrors popup-oauth-cancel.test.mjs (same fixture, same load order,
// window.close stubbed because jsdom's real one tears down the environment).
let renderSignInPrompt
let loginRequests
let loginResponse

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

beforeEach(async () => {
    loginRequests = []
    loginResponse = { ok: true, status: 200, json: async () => ({}) }
    globalThis.fetch = async (url, init) => {
        loginRequests.push({ url: String(url), init })
        if (loginResponse instanceof Error) throw loginResponse
        return loginResponse
    }
    // caramel-base.js's session writer is a top-level function declaration, so
    // it is a replaceable global here. Stubbing it keeps a successful login
    // from continuing into afterLoginSuccess()/initPopup() — this suite is
    // about the form, not about what the popup renders next.
    globalThis.caramelSetSession = vi.fn()
    await renderSignInPrompt()
})

/** Fills the form and submits it, then flushes the un-awaited async handler. */
const submitLogin = async (
    email = 'shopper@example.com',
    password = 'hunter2',
) => {
    document.getElementById('email').value = email
    document.getElementById('password').value = password
    document
        .getElementById('loginForm')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
}

const errorBox = () => document.getElementById('loginErrorMessage')
const resendBox = () => document.getElementById('resendVerificationContainer')

const rejectWith = body => {
    loginResponse = { ok: false, status: 401, json: async () => body }
}

describe('popup email/password login — the happy path', () => {
    it('POSTs the credentials to /api/extension/login and hands the session to caramelSetSession', async () => {
        loginResponse = {
            ok: true,
            status: 200,
            json: async () => ({
                token: 'fresh-token',
                username: 'shopper',
                image: 'https://cdn.example.com/a.png',
            }),
        }

        await submitLogin('shopper@example.com', 'hunter2')

        const [request] = loginRequests
        expect(request.url).toBe(
            `${globalThis.CARAMEL_ENV.baseUrl}/api/extension/login`,
        )
        expect(request.init.method).toBe('POST')
        expect(JSON.parse(request.init.body)).toEqual({
            email: 'shopper@example.com',
            password: 'hunter2',
        })
        expect(globalThis.caramelSetSession).toHaveBeenCalledWith(
            {
                token: 'fresh-token',
                user: {
                    username: 'shopper',
                    image: 'https://cdn.example.com/a.png',
                },
            },
            expect.any(Function),
        )
        expect(errorBox().style.display).toBe('none')
    })
})

describe('popup email/password login — what the user sees when it fails', () => {
    it('shows the rejection reason, prefixed, and leaves the verify-email link hidden', async () => {
        rejectWith({ error: 'Invalid credentials' })

        await submitLogin()

        // See Note 1: the server's reason arrives via a thrown Error, so the
        // catch's "Login failed: " prefix is part of what ships.
        expect(errorBox().textContent).toBe('Login failed: Invalid credentials')
        expect(errorBox().style.display).toBe('block')
        // A wrong password is not an unverified account — offering "Verify
        // your email" here would send the user down a dead end.
        expect(resendBox().style.display).toBe('none')
    })

    it('reveals the verify-email link when the rejection is about verification', async () => {
        rejectWith({ error: 'Please verify your email' })

        await submitLogin()

        expect(errorBox().textContent).toBe(
            'Login failed: Please verify your email',
        )
        expect(resendBox().style.display).toBe('block')
    })

    it('matches the verification wording case-insensitively and on any of its three spellings', async () => {
        // popup.js:1058-1062 lowercases the message and tests three substrings.
        // Each spelling is a real backend phrasing; missing one strands the
        // user on an unverified account with no route out of the popup.
        for (const message of [
            'Email VERIFICATION required',
            'Account is not verified',
            'Please Verify your address',
        ]) {
            rejectWith({ error: message })
            await renderSignInPrompt()
            await submitLogin()
            expect(resendBox().style.display, message).toBe('block')
        }
    })

    it('keeps the verify-email link hidden for an unrelated rejection', async () => {
        rejectWith({ error: 'Too many attempts, try again later' })

        await submitLogin()

        expect(resendBox().style.display).toBe('none')
    })

    it("reports a network failure with the browser's own message, not a blank box", async () => {
        loginResponse = new Error('Failed to fetch')

        await submitLogin()

        expect(errorBox().textContent).toBe('Login failed: Failed to fetch')
        expect(errorBox().style.display).toBe('block')
        expect(globalThis.caramelSetSession).not.toHaveBeenCalled()
    })

    it('falls back to bare copy when the rejection carries no error field — and stutters doing it', async () => {
        rejectWith({})

        await submitLogin()

        // See Note 2: 'Login failed' is the fallback message, and the catch
        // prefixes it again. This is the current shipped string.
        expect(errorBox().textContent).toBe('Login failed: Login failed')
        expect(errorBox().style.display).toBe('block')
    })

    it('clears the previous failure before the next attempt, so stale copy never outlives it', async () => {
        rejectWith({ error: 'Please verify your email' })
        await submitLogin()
        expect(resendBox().style.display).toBe('block')

        loginResponse = {
            ok: true,
            status: 200,
            json: async () => ({ token: 't', username: 'u', image: null }),
        }
        await submitLogin()

        expect(errorBox().textContent).toBe('')
        expect(errorBox().style.display).toBe('none')
        expect(resendBox().style.display).toBe('none')
    })
})
