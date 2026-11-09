// @vitest-environment jsdom
import ProfilePageClient from '@/app/profile/ProfilePageClient'
import {
    AUTH_REDIRECT_LIMIT,
    resetAuthRedirectGuardForTests,
} from '@/lib/auth/authRedirectGuard'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// T-10055: the REAL profile page and the REAL overview hook together, so the
// handover between them is under test: one move to /login per transition, the
// 401 kept as the reason whichever side sees the change first, a sign-in
// action even when the stale client session survives a failed sign-out, the
// loop count reset by a server-confirmed session, and no URL fragment in the
// Sentry report. Mocked: the session store, the network, the router, and the
// section components (their own suites cover them).

type SessionValue = {
    data: { user: { id: string; email: string; name: string } } | null
    isPending: boolean
}

const {
    replaceMock,
    pushMock,
    captureMessage,
    endClientSessionMock,
    sessionStore,
} = vi.hoisted(() => {
    let value: SessionValue = { data: null, isPending: false }
    const listeners = new Set<() => void>()
    return {
        replaceMock: vi.fn(),
        pushMock: vi.fn(),
        captureMessage: vi.fn(),
        endClientSessionMock: vi.fn(),
        sessionStore: {
            get: () => value,
            set(next: SessionValue) {
                value = next
                listeners.forEach(listener => listener())
            },
            subscribe(listener: () => void) {
                listeners.add(listener)
                return () => {
                    listeners.delete(listener)
                }
            },
        },
    }
})

vi.mock('next/navigation', () => ({
    useRouter: () => ({ replace: replaceMock, push: pushMock }),
}))
vi.mock('@/lib/auth/client', async () => {
    const { useSyncExternalStore } = await import('react')
    return {
        useSession: () =>
            useSyncExternalStore(sessionStore.subscribe, sessionStore.get),
    }
})
vi.mock('@/lib/auth/endClientSession', () => ({
    endClientSession: endClientSessionMock,
}))
vi.mock('@/lib/feedback/promptSupportOnFailure', () => ({
    promptSupportOnFailure: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({
    captureMessage,
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
}))
// Section stubs: this suite is about the page's auth transition only.
vi.mock('@/components/profile/ProfileNav', () => ({ default: () => null }))
vi.mock('@/app/profile/sections/AccountDetailsCard', () => ({
    default: () => null,
}))
vi.mock('@/app/profile/sections/AccountHeaderCard', () => ({
    default: () => null,
}))
vi.mock('@/app/profile/sections/DataPrivacySection', () => ({
    default: () => null,
}))
vi.mock('@/app/profile/sections/FavoriteStoresSection', () => ({
    default: () => null,
}))
vi.mock('@/app/profile/sections/GetStartedChecklist', () => ({
    default: () => null,
}))
vi.mock('@/app/profile/sections/PreferencesSection', () => ({
    default: () => null,
}))
vi.mock('@/app/profile/sections/ReportsImpactSection', () => ({
    default: () => null,
}))
vi.mock('@/app/profile/sections/SavingsSection', () => ({
    default: () => null,
}))

const fetchMock = vi.fn()
const signedInUser = {
    user: { id: 'u1', email: 'shopper@example.com', name: 'Shopper' },
}
const overviewFixture = {
    memberSince: null,
    hasExtensionActivity: false,
    growthPromptsEnabled: true,
    savings: {
        syncEnabled: false,
        eventCount: 1,
        storeCount: 0,
        totals: [],
        firstEventAt: null,
        recentEvents: [],
    },
    favorites: [],
    siteSuggestions: { identifyingCount: 0 },
    reports: { reportCount: 0 },
}

function setSession(next: SessionValue) {
    act(() => sessionStore.set(next))
}

/** Fill the guard's window, as if the loop had already run five times. */
function exhaustGuard() {
    const now = Date.now()
    sessionStorage.setItem(
        'caramel:auth-redirects',
        JSON.stringify(
            Array.from({ length: AUTH_REDIRECT_LIMIT }, (_, i) => now - i),
        ),
    )
}

function redirectCount(): number {
    const raw = sessionStorage.getItem('caramel:auth-redirects')
    return raw ? (JSON.parse(raw) as number[]).length : 0
}

/** A sign-out the test finishes by hand. */
function deferredSignOut() {
    let finish: ((ok: boolean) => void) | undefined
    endClientSessionMock.mockImplementation(
        () =>
            new Promise<boolean>(resolve => {
                finish = resolve
            }),
    )
    return (ok: boolean) => act(() => finish?.(ok))
}

class NoopIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
        return []
    }
}

beforeEach(() => {
    replaceMock.mockReset()
    pushMock.mockReset()
    captureMessage.mockReset()
    endClientSessionMock.mockReset().mockResolvedValue(true)
    fetchMock.mockReset()
    sessionStorage.clear()
    resetAuthRedirectGuardForTests()
    sessionStore.set({ data: null, isPending: false })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver)
    window.history.replaceState(null, '', '/profile#favorites')
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/')
})

describe('a 401 with the session store emptying BEFORE sign-out resolves', () => {
    it('navigates once, after the sign-out, and consumes one allowance', async () => {
        const order: string[] = []
        replaceMock.mockImplementation(() => order.push('navigate'))
        const finishSignOut = deferredSignOut()
        sessionStore.set({ data: signedInUser, isPending: false })
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

        render(<ProfilePageClient />)
        await waitFor(() => expect(endClientSessionMock).toHaveBeenCalled())
        setSession({ data: null, isPending: false })
        expect(replaceMock).not.toHaveBeenCalled()
        order.push('signedOut')
        finishSignOut(true)

        await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1))
        expect(replaceMock).toHaveBeenCalledWith(
            '/login?next=%2Fprofile%23favorites',
        )
        expect(order).toEqual(['signedOut', 'navigate'])
        expect(redirectCount()).toBe(1)
    })

    it('keeps the 401 as the reason when the guard refuses', async () => {
        exhaustGuard()
        const finishSignOut = deferredSignOut()
        sessionStore.set({ data: signedInUser, isPending: false })
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

        render(<ProfilePageClient />)
        await waitFor(() => expect(endClientSessionMock).toHaveBeenCalled())
        setSession({ data: null, isPending: false })
        finishSignOut(true)

        await screen.findByRole('link', { name: 'Sign in' })
        expect(replaceMock).not.toHaveBeenCalled()
        expect(captureMessage).toHaveBeenCalledTimes(1)
        expect(captureMessage.mock.calls[0][1].extra).toMatchObject({
            hasSession: false,
            serverRejectedSession: true,
        })
    })
})

describe('a 401 with the session store emptying AFTER sign-out resolves', () => {
    it('navigates once and consumes one allowance', async () => {
        const finishSignOut = deferredSignOut()
        sessionStore.set({ data: signedInUser, isPending: false })
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

        render(<ProfilePageClient />)
        await waitFor(() => expect(endClientSessionMock).toHaveBeenCalled())
        finishSignOut(true)
        await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1))
        setSession({ data: null, isPending: false })
        await act(async () => {})

        expect(replaceMock).toHaveBeenCalledTimes(1)
        expect(redirectCount()).toBe(1)
    })

    it('reports the 401 with the session still present when the guard refuses', async () => {
        exhaustGuard()
        const finishSignOut = deferredSignOut()
        sessionStore.set({ data: signedInUser, isPending: false })
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

        render(<ProfilePageClient />)
        await waitFor(() => expect(endClientSessionMock).toHaveBeenCalled())
        finishSignOut(true)

        await screen.findByRole('link', { name: 'Sign in' })
        expect(captureMessage.mock.calls[0][1].extra).toMatchObject({
            hasSession: true,
            serverRejectedSession: true,
        })
    })
})

describe('a 401 whose sign-out FAILED, with the loop guard exhausted', () => {
    it('still offers sign-in rather than the "Try again" notice', async () => {
        exhaustGuard()
        endClientSessionMock.mockResolvedValue(false)
        sessionStore.set({ data: signedInUser, isPending: false })
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

        render(<ProfilePageClient />)

        const link = await screen.findByRole('link', { name: 'Sign in' })
        expect(link.getAttribute('href')).toBe(
            '/login?next=%2Fprofile%23favorites',
        )
        expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
        expect(replaceMock).not.toHaveBeenCalled()
        // The stale client session is still there: the prompt does not need
        // it gone.
        expect(sessionStore.get().data).not.toBeNull()
    })
})

describe('a server-confirmed session resets the loop count', () => {
    it('redirects -> sign-in -> sign-out -> a fresh redirect is allowed', async () => {
        // Five signed-out visits inside a minute.
        for (let i = 0; i < AUTH_REDIRECT_LIMIT; i++) {
            render(<ProfilePageClient />)
            await waitFor(() =>
                expect(replaceMock).toHaveBeenCalledTimes(i + 1),
            )
            cleanup()
        }
        expect(redirectCount()).toBe(AUTH_REDIRECT_LIMIT)

        // Signed in: the overview answers 200.
        sessionStore.set({ data: signedInUser, isPending: false })
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify(overviewFixture), { status: 200 }),
        )
        render(<ProfilePageClient />)
        await waitFor(() => expect(redirectCount()).toBe(0))
        cleanup()

        // Signed out again, storage untouched by the test.
        sessionStore.set({ data: null, isPending: false })
        render(<ProfilePageClient />)
        await waitFor(() =>
            expect(replaceMock).toHaveBeenCalledTimes(AUTH_REDIRECT_LIMIT + 1),
        )
        expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
        expect(captureMessage).not.toHaveBeenCalled()
    })
})

describe('the loop report never carries the URL fragment', () => {
    it('reports pathnames only for a sensitive fragment', async () => {
        window.history.replaceState(
            null,
            '',
            '/profile#Jane%20Doe%20-%20555-123-4567',
        )
        exhaustGuard()

        render(<ProfilePageClient />)
        const link = await screen.findByRole('link', { name: 'Sign in' })
        // Navigation keeps the fragment...
        expect(link.getAttribute('href')).toBe(
            `/login?next=${encodeURIComponent('/profile#Jane%20Doe%20-%20555-123-4567')}`,
        )
        // ...the report does not.
        expect(captureMessage).toHaveBeenCalledTimes(1)
        const event = JSON.stringify(captureMessage.mock.calls[0])
        expect(event).not.toMatch(/Jane|555|%23|#/)
        expect(captureMessage.mock.calls[0][1].extra).toMatchObject({
            from: '/profile',
            to: '/login',
        })
    })
})
