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

    it('never sends a text-only caller’s raw text as the html body', async () => {
        // This pin used to assert the OPPOSITE — that html === the raw text —
        // as "backward compat". That fold is what shipped the malformed support
        // notification: HTML collapses newlines, so the operator's mail arrived
        // as one unstyled run-on wall (measured on the real production message,
        // whose html and text fields were byte-identical, 586 bytes each).
        await sendEmail({
            to: 'support@unotes.net',
            subject: 'hi',
            text: 'line one\nline two',
        })

        const payload = sendMock.mock.calls[0]![0] as {
            html?: string
            text?: string
        }
        expect(payload.text).toBe('line one\nline two')
        expect(payload.html).not.toBe('line one\nline two')
        // The line break survives as markup rather than collapsing.
        expect(payload.html).toContain('line one<br />line two')
    })

    it('escapes a text-only body so user input can never become markup', async () => {
        // The support message is user input. Folding it into html raw made a
        // report containing tags an injection into the operator's inbox.
        await sendEmail({
            to: 'support@unotes.net',
            subject: 'hi',
            text: 'Message:\n<script>alert(1)</script> & "quoted"',
        })

        const payload = sendMock.mock.calls[0]![0] as { html?: string }
        expect(payload.html).not.toContain('<script>')
        expect(payload.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
        expect(payload.html).toContain('&amp;')
        expect(payload.html).toContain('&quot;quoted&quot;')
    })

    it('leaves a caller-supplied html body exactly as given', async () => {
        await sendEmail({
            to: 'support@unotes.net',
            subject: 'hi',
            html: '<p>designed</p>',
            text: 'designed',
        })

        const payload = sendMock.mock.calls[0]![0] as {
            html?: string
            text?: string
        }
        expect(payload.html).toBe('<p>designed</p>')
        expect(payload.text).toBe('designed')
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
