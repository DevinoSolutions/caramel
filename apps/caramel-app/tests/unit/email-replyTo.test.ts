import { sendEmail } from '@/lib/email'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins for the email.ts extension the support flow needs: a real `text` part
// and an optional `replyTo` — WITHOUT regressing the existing text-only
// callers (sites/suggest) that relied on text being folded into html. The
// usesend SDK + env are mocked so nothing leaves the process.
const { sendMock } = vi.hoisted(() => ({
    sendMock: vi.fn(async (_payload: Record<string, unknown>) => ({
        data: { emailId: 'e1' },
        error: null,
    })),
}))
vi.mock('usesend-js', () => ({
    UseSend: class {
        emails = { send: sendMock }
    },
}))
vi.mock('@/lib/env', () => ({
    env: {
        USESEND_API_KEY: 'test-key',
        USESEND_FROM_EMAIL: 'no_reply@grabcaramel.com',
        USESEND_FROM_NAME: 'Caramel',
    },
}))

beforeEach(() => {
    sendMock.mockClear()
})

describe('sendEmail — replyTo + real text field', () => {
    it('passes replyTo through and keeps from as the verified Caramel sender (never the replyTo)', async () => {
        await sendEmail({
            to: 'support@unotes.net',
            subject: 'hi',
            text: 'a message',
            replyTo: 'customer@example.com',
        })

        const payload = sendMock.mock.calls[0]![0] as {
            from: string
            replyTo?: string
            text?: string
        }
        expect(payload.replyTo).toBe('customer@example.com')
        expect(payload.from).toBe('Caramel <no_reply@grabcaramel.com>')
        expect(payload.text).toBe('a message')
    })

    it('sends a real text part AND (backward-compat) folds text into html', async () => {
        await sendEmail({
            to: 'support@unotes.net',
            subject: 'hi',
            text: 'plain body',
        })

        const payload = sendMock.mock.calls[0]![0] as {
            html?: string
            text?: string
        }
        expect(payload.text).toBe('plain body')
        // sites/suggest historically had no html; the fold keeps a body.
        expect(payload.html).toBe('plain body')
    })

    it('omits replyTo entirely when not provided', async () => {
        await sendEmail({
            to: 'support@unotes.net',
            subject: 'hi',
            html: '<p>hi</p>',
        })

        const payload = sendMock.mock.calls[0]![0] as Record<string, unknown>
        expect('replyTo' in payload).toBe(false)
    })
})
