import { sendEmail } from '@/lib/email'
import { SendlyError, SendlyServerError } from 'sendly-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins for src/lib/email.ts, the single Sendly email module every send site
// uses (auth, support, site-suggestion notices): the sender stays the verified
// Caramel address, `replyTo` maps to Sendly's `reply`, a text-only caller gets
// ESCAPED HTML, an array `to` fans out one send per recipient, and EVERY
// failure throws with Sendly status/code context (no swallowed errors).
//
// MOCK ANNOUNCEMENT: `sendly-sdk`'s `Sendly` class is replaced below by
// FakeSendlyForUnitTests — nothing leaves the process and no real Sendly API
// is exercised. The real SendlyError classes are kept so instanceof-based error
// formatting is tested against the genuine types. `@/lib/env` is mocked too.
const { sendMock, ctorMock } = vi.hoisted(() => ({
    sendMock: vi.fn(async (_payload: Record<string, unknown>) => ({
        id: 'fake-email-id',
        status: 'PENDING',
        to: 'ignored@example.com',
        from: 'ignored@example.com',
    })),
    ctorMock: vi.fn(),
}))
vi.mock('sendly-sdk', async importOriginal => {
    const actual = await importOriginal<typeof import('sendly-sdk')>()
    class FakeSendlyForUnitTests {
        emails = { send: sendMock }
        constructor(options: Record<string, unknown>) {
            ctorMock(options)
        }
    }
    return { ...actual, Sendly: FakeSendlyForUnitTests }
})

const { envMock } = vi.hoisted(() => ({
    envMock: {
        SENDLY_API_KEY: 'sk_test_fake_key' as string | undefined,
        SENDLY_BASE_URL: undefined as string | undefined,
        SENDLY_FROM_EMAIL: 'no_reply@grabcaramel.com',
        SENDLY_FROM_NAME: 'Caramel',
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

beforeEach(() => {
    sendMock.mockClear()
    ctorMock.mockClear()
    envMock.SENDLY_API_KEY = 'sk_test_fake_key'
    envMock.SENDLY_BASE_URL = undefined
})

type SentPayload = {
    from: { email: string; name: string }
    to: string
    subject: string
    body: string
    reply?: string
}
const sentPayload = (call = 0) => sendMock.mock.calls[call]![0] as SentPayload

describe('sendEmail — Sendly transport', () => {
    it('sends from the verified Caramel sender and maps replyTo to Sendly `reply` (never the sender)', async () => {
        await sendEmail({
            to: 'support@unotes.net',
            subject: 'hi',
            text: 'a message',
            replyTo: 'customer@example.com',
        })

        const payload = sentPayload()
        expect(payload.reply).toBe('customer@example.com')
        expect(payload.from).toEqual({
            email: 'no_reply@grabcaramel.com',
            name: 'Caramel',
        })
        expect(payload.to).toBe('support@unotes.net')
        expect(payload.subject).toBe('hi')
    })

    it('builds the client from SENDLY_API_KEY and passes SENDLY_BASE_URL only when set', async () => {
        await sendEmail({ to: 'a@x.com', subject: 's', html: '<p>x</p>' })
        expect(ctorMock).toHaveBeenLastCalledWith({
            apiKey: 'sk_test_fake_key',
        })

        envMock.SENDLY_BASE_URL = 'https://staging.sendly.example'
        await sendEmail({ to: 'a@x.com', subject: 's', html: '<p>x</p>' })
        expect(ctorMock).toHaveBeenLastCalledWith({
            apiKey: 'sk_test_fake_key',
            baseUrl: 'https://staging.sendly.example',
        })
    })

    it('never sends a text-only caller’s raw text as the html body', async () => {
        // The fold of raw text into html is what once shipped the malformed
        // support notification: HTML collapses newlines, so the operator's mail
        // arrived as one unstyled run-on wall.
        await sendEmail({
            to: 'support@unotes.net',
            subject: 'hi',
            text: 'line one\nline two',
        })

        const { body } = sentPayload()
        expect(body).not.toBe('line one\nline two')
        // The line break survives as markup rather than collapsing.
        expect(body).toContain('line one<br />line two')
    })

    it('escapes a text-only body so user input can never become markup', async () => {
        await sendEmail({
            to: 'support@unotes.net',
            subject: 'hi',
            text: 'Message:\n<script>alert(1)</script> & "quoted"',
        })

        const { body } = sentPayload()
        expect(body).not.toContain('<script>')
        expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
        expect(body).toContain('&amp;')
        expect(body).toContain('&quot;quoted&quot;')
    })

    it('leaves a caller-supplied html body exactly as given', async () => {
        await sendEmail({
            to: 'support@unotes.net',
            subject: 'hi',
            html: '<p>designed</p>',
            text: 'designed',
        })

        expect(sentPayload().body).toBe('<p>designed</p>')
    })

    it('omits reply entirely when not provided', async () => {
        await sendEmail({
            to: 'support@unotes.net',
            subject: 'hi',
            html: '<p>hi</p>',
        })

        expect('reply' in sentPayload()).toBe(false)
    })

    it('fans an array `to` out as one send per recipient', async () => {
        await sendEmail({
            to: ['a@x.com', 'b@y.com'],
            subject: 's',
            html: '<p>x</p>',
        })

        expect(sendMock).toHaveBeenCalledTimes(2)
        expect(sentPayload(0).to).toBe('a@x.com')
        expect(sentPayload(1).to).toBe('b@y.com')
    })
})

describe('sendEmail — failures are loud', () => {
    it('throws when SENDLY_API_KEY is missing, before any send', async () => {
        envMock.SENDLY_API_KEY = undefined
        await expect(
            sendEmail({ to: 'a@x.com', subject: 's', html: '<p>x</p>' }),
        ).rejects.toThrow(/SENDLY_API_KEY is not defined/)
        expect(sendMock).not.toHaveBeenCalled()
    })

    it('throws on an empty recipient list instead of silently sending nothing', async () => {
        await expect(
            sendEmail({ to: [], subject: 's', html: '<p>x</p>' }),
        ).rejects.toThrow(/no recipients/)
        expect(sendMock).not.toHaveBeenCalled()
    })

    it('rethrows a Sendly API error with status, code and requestId, keeping the cause', async () => {
        const apiError = new SendlyServerError(
            503,
            'internal_error',
            'Sendly is down',
            undefined,
            { request_id: 'req_123' } as never,
        )
        sendMock.mockRejectedValueOnce(apiError)

        const attempt = sendEmail({
            to: 'a@x.com',
            subject: 's',
            html: '<p>x</p>',
        })
        await expect(attempt).rejects.toThrow(/Sendly email failed/)
        await expect(attempt).rejects.toThrow(/status=503/)
        await expect(attempt).rejects.toThrow(/code=internal_error/)
        const caught = await attempt.catch((error: unknown) => error)
        expect((caught as Error & { cause?: unknown }).cause).toBeInstanceOf(
            SendlyError,
        )
    })

    it('attempts EVERY recipient, then throws one error naming each failed index', async () => {
        sendMock
            .mockRejectedValueOnce(new Error('first recipient boom'))
            .mockResolvedValueOnce({
                id: 'ok',
                status: 'PENDING',
                to: 'b@y.com',
                from: 'f@x.com',
            })
            .mockRejectedValueOnce(new Error('third recipient boom'))

        const attempt = sendEmail({
            to: ['a@x.com', 'b@y.com', 'c@z.com'],
            subject: 's',
            html: '<p>x</p>',
        })
        await expect(attempt).rejects.toThrow(
            /recipient 1\/3: first recipient boom/,
        )
        // All three were attempted: the middle success did not stop the third.
        expect(sendMock).toHaveBeenCalledTimes(3)
    })

    it('does not put the recipient address into the thrown message', async () => {
        sendMock.mockRejectedValueOnce(new Error('upstream refused'))
        const caught = await sendEmail({
            to: 'private-shopper@example.com',
            subject: 's',
            html: '<p>x</p>',
        }).catch((error: unknown) => error)
        expect((caught as Error).message).not.toContain(
            'private-shopper@example.com',
        )
    })
})
