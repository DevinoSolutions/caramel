// @vitest-environment jsdom
import ProfilePageClient from '@/app/profile/ProfilePageClient'
import {
    AUTH_REDIRECT_LIMIT,
    resetAuthRedirectGuardForTests,
} from '@/lib/auth/authRedirectGuard'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// CARAMEL-2Y / CARAMEL-30 (2026-10-25): a signed-out /profile#favorites sent
// the shopper to /login with router.push, which left /profile behind it in
// history. Back from /login (a browser user, or an app shell that steps back
// from /login to run its native sign-in) landed on /profile, which bounced to
// /login again: in the iOS and macOS shells a ~150 ms loop until WebKit
// refused pushState. The redirect now REPLACES the profile entry, and carries
// the page (fragment included) as `next` so sign-in comes back to it.
const { replaceMock, pushMock, sessionState, captureMessage } = vi.hoisted(
    () => ({
        replaceMock: vi.fn(),
        pushMock: vi.fn(),
        captureMessage: vi.fn(),
        sessionState: {
            value: { data: null, isPending: false } as {
                data: { user: { id: string } } | null
                isPending: boolean
            },
        },
    }),
)

vi.mock('next/navigation', () => ({
    useRouter: () => ({ replace: replaceMock, push: pushMock }),
}))
vi.mock('@sentry/nextjs', () => ({
    captureMessage,
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
}))
vi.mock('@/lib/auth/client', () => ({
    useSession: () => sessionState.value,
}))
// Signed out, the overview is never fetched; signed in, it stays loading.
vi.mock('@/lib/profile/useProfileOverview', () => ({
    useProfileOverview: () => ({
        overview: null,
        status: 'loading',
        retry: vi.fn(),
        patchOverview: vi.fn(),
    }),
}))

// The signed-in page's section nav watches the sections; jsdom has no observer.
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
    sessionStorage.clear()
    resetAuthRedirectGuardForTests()
    vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver)
    window.history.replaceState(null, '', '/profile#favorites')
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/')
})

describe('signed-out /profile', () => {
    it('replaces itself with /login (no history entry to bounce back into), keeping the page as next', async () => {
        sessionState.value = { data: null, isPending: false }
        render(<ProfilePageClient />)

        await waitFor(() =>
            expect(replaceMock).toHaveBeenCalledWith(
                '/login?next=%2Fprofile%23favorites',
            ),
        )
        expect(pushMock).not.toHaveBeenCalled()
    })

    it('waits for the session check before redirecting', () => {
        sessionState.value = { data: null, isPending: true }
        render(<ProfilePageClient />)

        expect(replaceMock).not.toHaveBeenCalled()
        expect(pushMock).not.toHaveBeenCalled()
    })

    it('a signed-in shopper is never sent to /login', async () => {
        sessionState.value = { data: { user: { id: 'u1' } }, isPending: false }
        render(<ProfilePageClient />)

        // One commit after mount is when the redirect would have fired.
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(replaceMock).not.toHaveBeenCalled()
        expect(pushMock).not.toHaveBeenCalled()
    })
})

// T-10055: the Oct 24-26 2026 shell loop ran ~150 ms per cycle with no backoff
// and no Sentry trace. Whatever recreates a bounce, the page stops after
// AUTH_REDIRECT_LIMIT redirects, shows a sign-in prompt in place and reports
// auth_redirect_loop once.
describe('signed-out /profile in a redirect loop', () => {
    it('stops redirecting after the limit and shows a sign-in prompt instead', async () => {
        vi.stubGlobal('navigator', {
            userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CaramelApp/1.5.0 (ios)',
        })
        sessionState.value = { data: null, isPending: false }

        // Each shell step-back remounts /profile, which redirects again.
        for (let i = 0; i < AUTH_REDIRECT_LIMIT; i++) {
            render(<ProfilePageClient />)
            await waitFor(() =>
                expect(replaceMock).toHaveBeenCalledTimes(i + 1),
            )
            cleanup()
        }

        render(<ProfilePageClient />)
        const link = await screen.findByRole('link', { name: 'Sign in' })
        expect(link.getAttribute('href')).toBe(
            '/login?next=%2Fprofile%23favorites',
        )
        expect(screen.getByRole('alert').textContent).toContain(
            'Sign in to see your account',
        )
        expect(replaceMock).toHaveBeenCalledTimes(AUTH_REDIRECT_LIMIT)
        expect(captureMessage).toHaveBeenCalledTimes(1)
        expect(captureMessage.mock.calls[0][0]).toBe('auth_redirect_loop')
        expect(captureMessage.mock.calls[0][1].tags.app_shell_platform).toBe(
            'ios',
        )
    })
})
