// @vitest-environment jsdom
import SocialSignIn from '@/components/auth/SocialSignIn'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The extension deep-link: Safari/Firefox open /login?provider=apple in a tab,
// and SocialSignIn's `autoStart` launches that provider on mount so the tab
// goes straight to Google/Apple with no extra tap. These pin that it fires
// once, for the right provider, and ONLY when asked.

const { socialMock, trackMock } = vi.hoisted(() => ({
    socialMock: vi.fn(async () => ({ error: null })),
    trackMock: vi.fn(),
}))
vi.mock('@/lib/auth/client', () => ({
    signIn: { social: socialMock },
}))
vi.mock('@/lib/analytics/growthEvents', () => ({ trackGrowthEvent: trackMock }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

beforeEach(() => {
    socialMock.mockClear()
    socialMock.mockResolvedValue({ error: null })
})
afterEach(() => cleanup())

describe('SocialSignIn autoStart (extension provider deep-link)', () => {
    it('launches the named provider once on mount', async () => {
        render(<SocialSignIn verb="Sign in" autoStart="apple" />)
        await waitFor(() => expect(socialMock).toHaveBeenCalledTimes(1))
        expect(socialMock).toHaveBeenCalledWith({
            provider: 'apple',
            callbackURL: '/',
        })
    })

    it('honors the callbackURL it was given', async () => {
        render(
            <SocialSignIn
                verb="Sign in"
                autoStart="google"
                callbackURL="/welcome"
            />,
        )
        await waitFor(() =>
            expect(socialMock).toHaveBeenCalledWith({
                provider: 'google',
                callbackURL: '/welcome',
            }),
        )
    })

    it('does nothing automatically when autoStart is absent', async () => {
        render(<SocialSignIn verb="Sign in" />)
        // Give any stray effect a tick to misfire.
        await new Promise(r => setTimeout(r, 20))
        expect(socialMock).not.toHaveBeenCalled()
    })
})
