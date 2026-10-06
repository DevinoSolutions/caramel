// @vitest-environment jsdom
import { endClientSession } from '@/lib/auth/endClientSession'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The one browser sign-out path, shared by the header and by pages that find
// the server rejecting their session (CARAMEL-N). The identity reset must come
// BEFORE the session goes away, and a failed sign-out must be reported, never
// swallowed.
const { signOutMock, resetIdentityMock, captureExceptionMock } = vi.hoisted(
    () => ({
        signOutMock: vi.fn(),
        resetIdentityMock: vi.fn(),
        captureExceptionMock: vi.fn(),
    }),
)
vi.mock('@/lib/auth/client', () => ({ signOut: signOutMock }))
vi.mock('@/lib/analytics/identity', () => ({
    resetPosthogIdentity: resetIdentityMock,
}))
vi.mock('@sentry/nextjs', () => ({ captureException: captureExceptionMock }))

beforeEach(() => {
    signOutMock.mockReset()
    resetIdentityMock.mockReset()
    captureExceptionMock.mockReset()
})

describe('endClientSession', () => {
    it('resets the analytics identity before signing out, and returns true on success', async () => {
        const order: string[] = []
        resetIdentityMock.mockImplementation(() => order.push('reset'))
        signOutMock.mockImplementation(async () => {
            order.push('signOut')
            return { data: { success: true }, error: null }
        })

        await expect(endClientSession()).resolves.toBe(true)
        expect(order).toEqual(['reset', 'signOut'])
        expect(captureExceptionMock).not.toHaveBeenCalled()
    })

    it('reports a sign-out the server refused, and returns false', async () => {
        signOutMock.mockResolvedValueOnce({
            data: null,
            error: { status: 500, statusText: 'Internal Server Error' },
        })

        await expect(endClientSession()).resolves.toBe(false)
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
        const [error, context] = captureExceptionMock.mock.calls[0] as [
            Error,
            { tags: Record<string, string> },
        ]
        expect(error.message).toContain('500')
        expect(context.tags).toEqual({ operation: 'client_sign_out' })
    })

    it('reports a sign-out that threw (network failure), and returns false', async () => {
        const failure = new Error('network down')
        signOutMock.mockRejectedValueOnce(failure)

        await expect(endClientSession()).resolves.toBe(false)
        expect(captureExceptionMock).toHaveBeenCalledWith(failure, {
            tags: { operation: 'client_sign_out' },
        })
    })
})
