// @vitest-environment jsdom
import ProfilePageClient from '@/app/profile/ProfilePageClient'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// CARAMEL-2Y / CARAMEL-30 (2026-10-25): a signed-out /profile#favorites sent
// the shopper to /login with router.push, which left /profile behind it in
// history. Back from /login (a browser user, or an app shell that steps back
// from /login to run its native sign-in) landed on /profile, which bounced to
// /login again: in the iOS and macOS shells a ~150 ms loop until WebKit
// refused pushState. The redirect now REPLACES the profile entry, and carries
// the page (fragment included) as `next` so sign-in comes back to it.
const { replaceMock, pushMock, sessionState } = vi.hoisted(() => ({
    replaceMock: vi.fn(),
    pushMock: vi.fn(),
    sessionState: {
        value: { data: null, isPending: false } as {
            data: { user: { id: string } } | null
            isPending: boolean
        },
    },
}))

vi.mock('next/navigation', () => ({
    useRouter: () => ({ replace: replaceMock, push: pushMock }),
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
