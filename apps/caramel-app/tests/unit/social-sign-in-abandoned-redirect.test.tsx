// @vitest-environment jsdom
import SocialSignIn, {
    ABANDONED_REDIRECT_MS,
} from '@/components/auth/SocialSignIn'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Desktop Safari answers the Apple redirect with its NATIVE "Sign in with
// Apple" sheet, and cancelling that sheet fires nothing on the page (measured
// 2026-10-17: no focus, blur, visibilitychange or pageshow). The page simply
// stays, and the buttons used to sit on a disabled "Redirecting…" until a
// reload. These pin the give-back: a successful signIn.social that leaves the
// page in place for ABANDONED_REDIRECT_MS restores both buttons.

const { socialMock } = vi.hoisted(() => ({
    socialMock: vi.fn(async () => ({ error: null })),
}))
vi.mock('@/lib/auth/client', () => ({
    signIn: { social: socialMock },
}))
vi.mock('@/lib/analytics/growthEvents', () => ({ trackGrowthEvent: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const appleButton = () =>
    screen.getByRole('button', { name: /Apple|Redirecting/ })

beforeEach(() => {
    vi.useFakeTimers()
    socialMock.mockClear()
    socialMock.mockResolvedValue({ error: null })
})
afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

async function clickApple() {
    await act(async () => {
        fireEvent.click(
            screen.getByRole('button', { name: 'Sign in with Apple' }),
        )
    })
}

describe('SocialSignIn after a redirect that never left the page', () => {
    it('keeps "Redirecting…" while the redirect is still plausibly under way', async () => {
        render(<SocialSignIn verb="Sign in" />)
        await clickApple()

        await act(async () => {
            vi.advanceTimersByTime(ABANDONED_REDIRECT_MS - 1)
        })
        expect(appleButton().textContent).toBe('Redirecting…')
        expect((appleButton() as HTMLButtonElement).disabled).toBe(true)
    })

    it('gives both buttons back once the page is still here after the window', async () => {
        render(<SocialSignIn verb="Sign in" />)
        await clickApple()

        await act(async () => {
            vi.advanceTimersByTime(ABANDONED_REDIRECT_MS)
        })
        expect(appleButton().textContent).toBe('Sign in with Apple')
        expect((appleButton() as HTMLButtonElement).disabled).toBe(false)
        expect(
            (
                screen.getByRole('button', {
                    name: 'Sign in with Google',
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(false)

        // And the button works again: a second try starts a second redirect.
        await clickApple()
        expect(socialMock).toHaveBeenCalledTimes(2)
    })

    it('does the same for the extension deep-link autoStart', async () => {
        render(<SocialSignIn verb="Sign in" autoStart="apple" />)
        await act(async () => {})
        expect(appleButton().textContent).toBe('Redirecting…')

        await act(async () => {
            vi.advanceTimersByTime(ABANDONED_REDIRECT_MS)
        })
        expect(appleButton().textContent).toBe('Sign in with Apple')
    })
})
