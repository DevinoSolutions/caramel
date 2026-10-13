// @vitest-environment jsdom
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
const { endClientSessionMock, promptSupportMock, addBreadcrumbMock } =
    vi.hoisted(() => ({
        endClientSessionMock: vi.fn(),
        promptSupportMock: vi.fn(),
        addBreadcrumbMock: vi.fn(),
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
}))

const fetchMock = vi.fn()
const assignMock = vi.fn()
const realLocation = window.location

beforeEach(() => {
    endClientSessionMock.mockReset().mockResolvedValue(true)
    promptSupportMock.mockReset()
    addBreadcrumbMock.mockReset()
    fetchMock.mockReset()
    assignMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    // jsdom's Location.assign is not configurable; replace the whole object.
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...realLocation, assign: assignMock },
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
    it('ends the client session, redirects to /login, and reports no error', async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

        const { result } = renderHook(() => useProfileOverview(true))

        await waitFor(() => expect(assignMock).toHaveBeenCalledWith('/login'))
        expect(endClientSessionMock).toHaveBeenCalledTimes(1)
        expect(promptSupportMock).not.toHaveBeenCalled()
        // No error notice flashes before the navigation lands.
        expect(result.current.status).toBe('loading')
        // The breadcrumb explains the redirect to a later report.
        expect(addBreadcrumbMock).toHaveBeenCalledTimes(1)
        expect(addBreadcrumbMock.mock.calls[0]?.[0]).toMatchObject({
            category: 'profile',
            level: 'info',
        })
    })

    it('signs out BEFORE navigating, so /login does not see the stale session', async () => {
        const order: string[] = []
        endClientSessionMock.mockImplementation(async () => {
            order.push('signOut')
            return true
        })
        assignMock.mockImplementation(() => order.push('navigate'))
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

        renderHook(() => useProfileOverview(true))

        await waitFor(() => expect(assignMock).toHaveBeenCalled())
        expect(order).toEqual(['signOut', 'navigate'])
    })

    it('still redirects when the sign-out call itself failed (reported inside endClientSession)', async () => {
        endClientSessionMock.mockResolvedValueOnce(false)
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

        renderHook(() => useProfileOverview(true))

        await waitFor(() => expect(assignMock).toHaveBeenCalledWith('/login'))
        expect(promptSupportMock).not.toHaveBeenCalled()
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
        expect(assignMock).not.toHaveBeenCalled()
        expect(addBreadcrumbMock).not.toHaveBeenCalled()
    })

    it('a 403 is not mistaken for a stale session', async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }))

        const { result } = renderHook(() => useProfileOverview(true))

        await waitFor(() => expect(result.current.status).toBe('error'))
        expect(endClientSessionMock).not.toHaveBeenCalled()
        expect(assignMock).not.toHaveBeenCalled()
    })

    it('does not fetch at all while disabled', () => {
        renderHook(() => useProfileOverview(false))
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
