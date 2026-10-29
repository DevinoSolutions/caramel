// @vitest-environment jsdom
import {
    AUTH_REDIRECT_LIMIT,
    AUTH_REDIRECT_WINDOW_MS,
    clearAuthRedirectCount,
    decideAuthRedirect,
    guardAuthRedirect,
    resetAuthRedirectGuardForTests,
} from '@/lib/auth/authRedirectGuard'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// T-10055: Oct 24-26 2026 the iOS/macOS shells (CaramelApp 1.5.0 / 1.6.0)
// bounced signed-out shoppers /profile#favorites <-> /login every ~150 ms with
// no Sentry trace. Every auth redirect now passes this guard: more than
// AUTH_REDIRECT_LIMIT in a minute is refused and reported once.
const { captureMessage, captureException } = vi.hoisted(() => ({
    captureMessage: vi.fn(),
    captureException: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({ captureMessage, captureException }))

const SHELL_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CaramelApp/1.6.0 (ios)'

const attempt = {
    from: '/profile#favorites',
    to: '/login?next=%2Fprofile%23favorites',
    hasSession: false,
    sessionPending: false,
    serverRejectedSession: false,
}

beforeEach(() => {
    sessionStorage.clear()
    resetAuthRedirectGuardForTests()
    captureMessage.mockReset()
    captureException.mockReset()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('decideAuthRedirect', () => {
    it('allows up to the limit inside the window, then refuses', () => {
        let stamps: number[] = []
        for (let i = 0; i < AUTH_REDIRECT_LIMIT; i++) {
            const d = decideAuthRedirect(stamps, 1_000 + i * 150)
            expect(d.allowed).toBe(true)
            stamps = d.recent
        }
        expect(decideAuthRedirect(stamps, 1_000 + 6 * 150).allowed).toBe(false)
    })

    it('forgets redirects older than the window', () => {
        const stamps = Array.from({ length: AUTH_REDIRECT_LIMIT }, (_, i) => i)
        const d = decideAuthRedirect(stamps, AUTH_REDIRECT_WINDOW_MS + 10)
        expect(d.allowed).toBe(true)
        expect(d.recent).toEqual([AUTH_REDIRECT_WINDOW_MS + 10])
    })

    it('ignores timestamps from the future and junk', () => {
        const d = decideAuthRedirect([Number.NaN, 99_999_999, 5], 10)
        expect(d.recent).toEqual([5, 10])
    })
})

describe('guardAuthRedirect', () => {
    it('lets a single signed-out visit through without reporting', () => {
        expect(guardAuthRedirect(attempt, 1_000)).toBe(true)
        expect(captureMessage).not.toHaveBeenCalled()
    })

    it('stops a ~150 ms loop after five redirects and reports it once', () => {
        vi.stubGlobal('navigator', { userAgent: SHELL_UA })
        const results = Array.from({ length: 10 }, (_, i) =>
            guardAuthRedirect(attempt, 1_000 + i * 150),
        )
        expect(results).toEqual([
            true,
            true,
            true,
            true,
            true,
            false,
            false,
            false,
            false,
            false,
        ])
        expect(captureMessage).toHaveBeenCalledTimes(1)
        const [message, context] = captureMessage.mock.calls[0]
        expect(message).toBe('auth_redirect_loop')
        expect(context.tags).toMatchObject({
            operation: 'auth_redirect_loop',
            surface: 'app-shell',
            app_shell_platform: 'ios',
        })
        expect(context.extra).toMatchObject({
            from: '/profile',
            to: '/login',
            hasSession: false,
            sessionPending: false,
            serverRejectedSession: false,
            redirectsInWindow: AUTH_REDIRECT_LIMIT,
            appShellVersion: '1.6.0',
        })
    })

    it('counts across full page loads through sessionStorage', () => {
        for (let i = 0; i < AUTH_REDIRECT_LIMIT; i++) {
            guardAuthRedirect(attempt, 1_000 + i)
        }
        // A reload drops module memory but keeps the tab's sessionStorage.
        resetAuthRedirectGuardForTests()
        expect(guardAuthRedirect(attempt, 2_000)).toBe(false)
    })

    it('reports pathnames only: no fragment or query reaches Sentry', () => {
        const sensitive = {
            ...attempt,
            from: '/profile?x=1#Jane%20Doe%20-%20555-123-4567',
            to: '/login?next=%2Fprofile%23Jane%20Doe',
        }
        for (let i = 0; i <= AUTH_REDIRECT_LIMIT; i++) {
            guardAuthRedirect(sensitive, 1_000 + i)
        }
        expect(JSON.stringify(captureMessage.mock.calls[0])).not.toMatch(
            /Jane|555|next|x=1/,
        )
    })

    it('clearAuthRedirectCount forgets the window but keeps the report flag', () => {
        for (let i = 0; i <= AUTH_REDIRECT_LIMIT; i++) {
            guardAuthRedirect(attempt, 1_000 + i)
        }
        clearAuthRedirectCount()
        expect(guardAuthRedirect(attempt, 2_000)).toBe(true)
        for (let i = 0; i <= AUTH_REDIRECT_LIMIT; i++) {
            guardAuthRedirect(attempt, 2_001 + i)
        }
        expect(captureMessage).toHaveBeenCalledTimes(1)
    })

    it('reports a browser loop as surface web', () => {
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Safari/605' })
        for (let i = 0; i <= AUTH_REDIRECT_LIMIT; i++) {
            guardAuthRedirect(attempt, 1_000 + i)
        }
        expect(captureMessage.mock.calls[0][1].tags).toMatchObject({
            surface: 'web',
            app_shell_platform: 'none',
        })
    })

    it('redirects again once the loop has been quiet for a minute', () => {
        for (let i = 0; i <= AUTH_REDIRECT_LIMIT; i++) {
            guardAuthRedirect(attempt, 1_000 + i)
        }
        expect(
            guardAuthRedirect(attempt, 1_000 + AUTH_REDIRECT_WINDOW_MS + 10),
        ).toBe(true)
    })

    it('keeps counting in memory when sessionStorage throws', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('denied')
        })
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('denied')
        })
        const results = Array.from(
            { length: AUTH_REDIRECT_LIMIT + 1 },
            (_, i) => guardAuthRedirect(attempt, 1_000 + i),
        )
        expect(results[results.length - 1]).toBe(false)
        expect(captureMessage).toHaveBeenCalledTimes(1)
        vi.restoreAllMocks()
    })
})
