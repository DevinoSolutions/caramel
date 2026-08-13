import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { CARAMEL_ENV } from '../caramel-env.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import type { AppApi } from '../entrypoints/popup/types'
import { SignInView } from '../entrypoints/popup/views/SignInView'

// WXT-migration P0 characterization pins (2026-08-12; P2-ported 2026-08-13 to
// @testing-library/react against the React SignInView).
//
// The email/password login form is the ONE sign-in path with no automated
// coverage of what a user sees when it goes wrong — the happy path is proven
// E2E against prod, and OAuth has five suites of its own. So its FAILURE copy
// and its one piece of conditional UI (the "Verify your email" link) are
// frozen here. These pins describe the behavior exactly; they are not an
// endorsement of the copy (see the two notes below), they are the contract the
// React port had to reproduce.
//
// Note 1 — every failure reads "Login failed: <reason>". The non-ok branch
// does not render the server's message itself: it THROWS it, and the single
// catch prefixes every message it receives. So a server saying "Invalid
// credentials" surfaces as "Login failed: Invalid credentials", not as the
// bare string.
//
// Note 2 — a non-ok response carrying no `error` field therefore stutters: the
// fallback is itself the string 'Login failed', which the catch then prefixes,
// producing "Login failed: Login failed". Pinned as-is (P2 ruling: conscious
// copy, not a bug to fix during the rewrite).
//
// P2 reshape — the error box and the resend link were display:none elements
// the vanilla view toggled; React renders them only when they have something
// to say, so "hidden" is now "absent". The alert role and the link text are
// what a user actually perceives, and those are unchanged.
let loginRequests: Array<{ url: string; init: RequestInit }>
let loginResponse: unknown

/* caramel-base.js's session writer is stubbed through vi.mock: the factory
 * delegates to whatever `stubs.caramelSetSession` currently holds, and falls
 * back to the real implementation when a test hasn't installed one. Stubbing
 * it keeps a successful login from continuing into afterLoginSuccess() — this
 * suite is about the form, not about what the popup renders next. */
const stubs = vi.hoisted(() => ({
    caramelSetSession: null as null | ReturnType<typeof vi.fn>,
}))

vi.mock('../caramel-base.js', async importOriginal => {
    const actual = (await importOriginal()) as Record<string, unknown>
    return {
        ...actual,
        // `currentBrowser` is a live binding that initCaramelBase() assigns;
        // a plain spread would freeze its pre-init `undefined`.
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelSetSession: (...args: unknown[]) =>
            (
                stubs.caramelSetSession ??
                (actual.caramelSetSession as (...a: unknown[]) => unknown)
            )(...args),
    }
})

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
    return stub
}

const makeApi = (): AppApi => ({
    openSignIn: vi.fn(),
    closeOverlay: vi.fn(),
    refresh: vi.fn(),
})

beforeAll(() => {
    // The realm's effects, in entrypoints/popup/main.tsx order.
    installChromeStub()
    initCouponConstants()
    initCaramelBase()
    initCouponRunner()
    ;(globalThis as any).currentBrowser.tabs.create = () => {}
    window.close = vi.fn()
})

beforeEach(() => {
    loginRequests = []
    loginResponse = { ok: true, status: 200, json: async () => ({}) }
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
        loginRequests.push({ url: String(url), init })
        if (loginResponse instanceof Error) throw loginResponse
        return loginResponse
    }) as any
    stubs.caramelSetSession = vi.fn()
    render(<SignInView api={makeApi()} />)
})

/** Fills the form and presses Log in, the way a shopper does. */
const submitLogin = async (
    email = 'shopper@example.com',
    password = 'hunter2',
) => {
    const emailField = screen.getByLabelText('Email')
    const passwordField = screen.getByLabelText('Password')
    await userEvent.clear(emailField)
    await userEvent.type(emailField, email)
    await userEvent.clear(passwordField)
    await userEvent.type(passwordField, password)
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }))
}

const failure = () => screen.queryByRole('alert')
const resendLink = () =>
    screen.queryByRole('link', { name: 'Verify your email' })

const rejectWith = (body: unknown) => {
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

        await waitFor(() => expect(loginRequests).toHaveLength(1))
        const request = loginRequests[0]!
        expect(request.url).toBe(`${CARAMEL_ENV.baseUrl}/api/extension/login`)
        expect(request.init.method).toBe('POST')
        expect(JSON.parse(String(request.init.body))).toEqual({
            email: 'shopper@example.com',
            password: 'hunter2',
        })
        await waitFor(() =>
            expect(stubs.caramelSetSession).toHaveBeenCalledWith(
                {
                    token: 'fresh-token',
                    user: {
                        username: 'shopper',
                        image: 'https://cdn.example.com/a.png',
                    },
                },
                expect.any(Function),
            ),
        )
        expect(failure()).not.toBeInTheDocument()
    })
})

describe('popup email/password login — what the user sees when it fails', () => {
    it('shows the rejection reason, prefixed, and leaves the verify-email link hidden', async () => {
        rejectWith({ error: 'Invalid credentials' })

        await submitLogin()

        // See Note 1: the server's reason arrives via a thrown Error, so the
        // catch's "Login failed: " prefix is part of what ships.
        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Login failed: Invalid credentials',
        )
        // A wrong password is not an unverified account — offering "Verify
        // your email" here would send the user down a dead end.
        expect(resendLink()).not.toBeInTheDocument()
    })

    it('reveals the verify-email link when the rejection is about verification', async () => {
        rejectWith({ error: 'Please verify your email' })

        await submitLogin()

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Login failed: Please verify your email',
        )
        const link = await screen.findByRole('link', {
            name: 'Verify your email',
        })
        expect(link).toHaveAttribute('href', `${CARAMEL_ENV.baseUrl}/verify`)
    })

    // Three full type-and-submit passes in one test: comfortably inside the
    // default 5s alone, but not under a full 769-test run's CPU contention
    // (measured flaking there, 2026-08-13) — hence the explicit budget.
    it('matches the verification wording case-insensitively and on any of its three spellings', async () => {
        // The handler lowercases the message and tests three substrings.
        // Each spelling is a real backend phrasing; missing one strands
        // the user on an unverified account with no route out of the
        // popup.
        for (const message of [
            'Email VERIFICATION required',
            'Account is not verified',
            'Please Verify your address',
        ]) {
            rejectWith({ error: message })
            await submitLogin()
            expect(
                await screen.findByRole('link', {
                    name: 'Verify your email',
                }),
                message,
            ).toBeInTheDocument()
        }
    }, 15000)

    it('keeps the verify-email link hidden for an unrelated rejection', async () => {
        rejectWith({ error: 'Too many attempts, try again later' })

        await submitLogin()

        await screen.findByRole('alert')
        expect(resendLink()).not.toBeInTheDocument()
    })

    it("reports a network failure with the browser's own message, not a blank box", async () => {
        loginResponse = new Error('Failed to fetch')

        await submitLogin()

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Login failed: Failed to fetch',
        )
        expect(stubs.caramelSetSession).not.toHaveBeenCalled()
    })

    it('falls back to bare copy when the rejection carries no error field — and stutters doing it', async () => {
        rejectWith({})

        await submitLogin()

        // See Note 2: 'Login failed' is the fallback message, and the catch
        // prefixes it again. This is the current shipped string.
        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Login failed: Login failed',
        )
    })

    it('clears the previous failure before the next attempt, so stale copy never outlives it', async () => {
        rejectWith({ error: 'Please verify your email' })
        await submitLogin()
        await screen.findByRole('link', { name: 'Verify your email' })

        loginResponse = {
            ok: true,
            status: 200,
            json: async () => ({ token: 't', username: 'u', image: null }),
        }
        await submitLogin()

        await waitFor(() => expect(failure()).not.toBeInTheDocument())
        expect(resendLink()).not.toBeInTheDocument()
    })
})
