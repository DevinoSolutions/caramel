// @vitest-environment jsdom
import {
    AUTH_REDIRECT_LIMIT,
    resetAuthRedirectGuardForTests,
} from '@/lib/auth/authRedirectGuard'
import { useProfileOverview } from '@/lib/profile/useProfileOverview'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// CARAMEL-N (2026-10-06): one user's session cookie was still present (so the
// client's useSession() said "signed in") but the server rejected it, and
// /api/account/overview answered 401 on every /profile visit. The hook treated
// that as a fault: an error notice for the user and a Sentry exception per
// visit. A 401 now means "signed out": end the client session, send the user to
// /login, report nothing as an error. Every other non-OK status keeps the
// error path.
const {
    endClientSessionMock,
    promptSupportMock,
    addBreadcrumbMock,
    captureMessageMock,
} = vi.hoisted(() => ({
    endClientSessionMock: vi.fn(),
    promptSupportMock: vi.fn(),
    addBreadcrumbMock: vi.fn(),
    captureMessageMock: vi.fn(),
}))
vi.mock('@/lib/auth/endClientSession', () => ({
    endClientSession: endClientSessionMock,
}))
vi.mock('@/lib/feedback/promptSupportOnFailure', () => ({
    promptSupportOnFailure: promptSupportMock,
}))
vi.mock('@sentry/nextjs', () => ({
    addBreadcrumb: addBreadcrumbMock,
    captureException: vi.fn(),
    captureMessage: captureMessageMock,
}))

const fetchMock = vi.fn()
const replaceMock = vi.fn()
const realLocation = window.location

beforeEach(() => {
    endClientSessionMock.mockReset().mockResolvedValue(true)
    promptSupportMock.mockReset()
    addBreadcrumbMock.mockReset()
    captureMessageMock.mockReset()
    sessionStorage.clear()
    resetAuthRedirectGuardForTests()
    fetchMock.mockReset()
    replaceMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    // jsdom's Location.replace is not configurable; replace the whole object.
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...realLocation, replace: replaceMock },
    })
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: realLocation,
    })
})

describe('useProfileOverview — 401 is a signed-out user (CARAMEL-N)', () => {
    // Navigation is the page's job (T-10055): see profile-auth-transition.test.tsx
    // for the page and this hook together.
    it('ends the client session, reports auth-required, and reports no error', async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

        const { result } = renderHook(() => useProfileOverview(true))

        await waitFor(() => expect(result.current.status).toBe('auth-required'))
        expect(endClientSessionMock).toHaveBeenCalledTimes(1)
        expect(promptSupportMock).not.toHaveBeenCalled()
        // The hook never navigates on its own.
        expect(replaceMock).not.toHaveBeenCalled()
        // The breadcrumb explains the redirect to a later report.
        expect(addBreadcrumbMock).toHaveBeenCalledTimes(1)
        expect(addBreadcrumbMock.mock.calls[0]?.[0]).toMatchObject({
            category: 'profile',
            level: 'info',
        })
    })

    it('reports ending-session while the sign-out is in flight', async () => {
        let finishSignOut: ((ok: boolean) => void) | undefined
        endClientSessionMock.mockImplementation(
            () =>
                new Promise<boolean>(resolve => {
                    finishSignOut = resolve
                }),
        )
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

        const { result } = renderHook(() => useProfileOverview(true))

        await waitFor(() =>
            expect(result.current.status).toBe('ending-session'),
        )
        finishSignOut?.(true)
        await waitFor(() => expect(result.current.status).toBe('auth-required'))
    })

    it('still reports auth-required when the sign-out call itself failed (reported inside endClientSession)', async () => {
        endClientSessionMock.mockResolvedValueOnce(false)
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

        const { result } = renderHook(() => useProfileOverview(true))

        await waitFor(() => expect(result.current.status).toBe('auth-required'))
        expect(promptSupportMock).not.toHaveBeenCalled()
    })

    it('still reports auth-required after the page disabled the hook mid sign-out', async () => {
        let finishSignOut: ((ok: boolean) => void) | undefined
        endClientSessionMock.mockImplementation(
            () =>
                new Promise<boolean>(resolve => {
                    finishSignOut = resolve
                }),
        )
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

        const { result, rerender } = renderHook(
            ({ enabled }) => useProfileOverview(enabled),
            { initialProps: { enabled: true } },
        )
        await waitFor(() =>
            expect(result.current.status).toBe('ending-session'),
        )
        // The session store emptied first: the page turns the hook off.
        rerender({ enabled: false })
        finishSignOut?.(true)
        await waitFor(() => expect(result.current.status).toBe('auth-required'))
    })
})

describe('useProfileOverview — other failures keep the error path', () => {
    it('a 500 sets the error status, reports via promptSupportOnFailure, and does not sign out or redirect', async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }))

        const { result } = renderHook(() => useProfileOverview(true))

        await waitFor(() => expect(result.current.status).toBe('error'))
        expect(promptSupportMock).toHaveBeenCalledTimes(1)
        const arg = promptSupportMock.mock.calls[0]?.[0] as {
            error: Error
            operation: string
        }
        expect(arg.operation).toBe('profile_overview_load')
        expect(arg.error.message).toBe('Overview request failed with 500')
        expect(endClientSessionMock).not.toHaveBeenCalled()
        expect(replaceMock).not.toHaveBeenCalled()
        expect(addBreadcrumbMock).not.toHaveBeenCalled()
    })

    it('a 403 is not mistaken for a stale session', async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }))

        const { result } = renderHook(() => useProfileOverview(true))

        await waitFor(() => expect(result.current.status).toBe('error'))
        expect(endClientSessionMock).not.toHaveBeenCalled()
        expect(replaceMock).not.toHaveBeenCalled()
    })

    it('does not fetch at all while disabled', () => {
        renderHook(() => useProfileOverview(false))
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe('useProfileOverview — a confirmed session resets the loop guard (T-10055)', () => {
    it('a 200 overview clears earlier auth redirects', async () => {
        const now = Date.now()
        sessionStorage.setItem(
            'caramel:auth-redirects',
            JSON.stringify(
                Array.from({ length: AUTH_REDIRECT_LIMIT }, (_, i) => now - i),
            ),
        )
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ favorites: [] }), { status: 200 }),
        )

        const { result } = renderHook(() => useProfileOverview(true))

        await waitFor(() => expect(result.current.status).toBe('ready'))
        expect(sessionStorage.getItem('caramel:auth-redirects')).toBe('[]')
        expect(captureMessageMock).not.toHaveBeenCalled()
    })
})
