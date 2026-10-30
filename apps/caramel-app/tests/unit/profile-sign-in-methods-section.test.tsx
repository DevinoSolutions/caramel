// @vitest-environment jsdom
import SignInMethodsSection from '@/app/profile/sections/SignInMethodsSection'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// /profile > "Sign-in methods" (owner rule 2026-10-27): lists the ways into
// the account, connects a missing provider through better-auth's
// `linkSocial` redirect, disconnects through `unlinkAccount`, and never lets
// the last way in go. MOCK (announced): the better-auth client, and fetch
// standing in for GET /api/account/sign-in-methods.

type AccountRow = { id: string; providerId: string }

const { authMock, server } = vi.hoisted(() => ({
    server: { accounts: [] as AccountRow[] },
    authMock: {
        linkSocial: vi.fn(),
        unlinkAccount: vi.fn(),
    },
}))
vi.mock('@/lib/auth/client', () => ({ authClient: authMock }))

beforeEach(() => {
    window.history.replaceState(null, '', '/profile')
    server.accounts = []
    vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
            Response.json({ accounts: server.accounts }, { status: 200 }),
        ),
    )
    authMock.linkSocial.mockReset()
    authMock.linkSocial.mockResolvedValue({ data: { url: 'x' }, error: null })
    authMock.unlinkAccount.mockReset()
    authMock.unlinkAccount.mockImplementation(
        async ({ accountId }: { accountId: string }) => {
            server.accounts = server.accounts.filter(
                row => row.id !== accountId,
            )
            return { data: { status: true }, error: null }
        },
    )
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

describe('SignInMethodsSection', () => {
    it('keeps the only sign-in method visible but disabled, with the reason', async () => {
        server.accounts = [{ id: 'acc-google', providerId: 'google' }]
        render(<SignInMethodsSection />)

        const disconnect = await screen.findByRole('button', {
            name: 'Disconnect Google',
        })
        expect(disconnect).toHaveProperty('disabled', true)
        expect(
            screen.getByText(
                /only way to sign in, so it cannot be disconnected/,
            ),
        ).toBeTruthy()
        expect(
            screen
                .getByRole('link', { name: 'Set a password' })
                .getAttribute('href'),
        ).toBe('/forgot-password')
    })

    it('connects a missing provider through linkSocial and comes back to this section', async () => {
        server.accounts = [{ id: 'acc-pw', providerId: 'credential' }]
        render(<SignInMethodsSection />)

        fireEvent.click(
            await screen.findByRole('button', { name: 'Connect Apple' }),
        )

        expect(authMock.linkSocial).toHaveBeenCalledWith({
            provider: 'apple',
            callbackURL: '/profile?connect=done#sign-in-methods',
            errorCallbackURL: '/profile?connect=failed#sign-in-methods',
        })
    })

    it('disconnects by the account row id and re-reads what the server kept', async () => {
        server.accounts = [
            { id: 'acc-pw', providerId: 'credential' },
            { id: 'acc-apple', providerId: 'apple' },
        ]
        render(<SignInMethodsSection />)

        fireEvent.click(
            await screen.findByRole('button', { name: 'Disconnect Apple' }),
        )

        expect(await screen.findByText('Apple disconnected.')).toBeTruthy()
        expect(authMock.unlinkAccount).toHaveBeenCalledWith({
            accountId: 'acc-apple',
        })
        expect(
            screen.getByRole('button', {
                name: 'Disconnect Email and password',
            }),
        ).toHaveProperty('disabled', true)
    })

    it('tells the person why a Connect that came back failed and clears the marker', async () => {
        server.accounts = [{ id: 'acc-pw', providerId: 'credential' }]
        window.history.replaceState(
            null,
            '',
            '/profile?connect=failed&error=account_already_linked_to_different_user',
        )
        render(<SignInMethodsSection />)

        expect(
            await screen.findByText(/different Caramel account/),
        ).toBeTruthy()
        expect(window.location.search).toBe('')
    })

    it('says a stale session must sign in again when the server refuses a disconnect', async () => {
        server.accounts = [
            { id: 'acc-pw', providerId: 'credential' },
            { id: 'acc-apple', providerId: 'apple' },
        ]
        authMock.unlinkAccount.mockResolvedValueOnce({
            data: null,
            error: { code: 'SESSION_NOT_FRESH' },
        })
        render(<SignInMethodsSection />)

        fireEvent.click(
            await screen.findByRole('button', { name: 'Disconnect Apple' }),
        )

        expect(
            await screen.findByText(
                /sign out and back in, then disconnect Apple/,
            ),
        ).toBeTruthy()
    })
})
