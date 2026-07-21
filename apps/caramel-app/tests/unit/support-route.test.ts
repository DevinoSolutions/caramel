import { POST } from '@/app/api/support/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Unit pins for the support/feedback flow's server route. Mirrors the house
// style (coupons-report.test.ts): mock the two destinations (email + PostHog),
// Sentry, and the better-auth session; stub only the rate-limit round-trip and
// keep isOriginAllowed real (a no-Origin request passes, like the extension's
// host_permissions fetch). Proves the partial-failure matrix, honeypot,
// session-identity override, the shared feedback_id, replyTo policy, and that
// no request-header secrets leak into either destination.
const { sendEmailMock } = vi.hoisted(() => ({
    sendEmailMock: vi.fn(async (_payload: Record<string, unknown>) => {}),
}))
vi.mock('@/lib/email', () => ({ sendEmail: sendEmailMock }))

const { captureServerEventMock } = vi.hoisted(() => ({
    captureServerEventMock: vi.fn(
        async (_args: {
            event: string
            distinctId: string
            properties?: Record<string, unknown>
        }) => true,
    ),
}))
vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: captureServerEventMock,
}))

const { captureExceptionMock } = vi.hoisted(() => ({
    captureExceptionMock: vi.fn(
        (_error: unknown, _context?: Record<string, unknown>) => 'evt_test',
    ),
}))
vi.mock('@sentry/nextjs', () => ({ captureException: captureExceptionMock }))

const { getSessionMock } = vi.hoisted(() => ({
    getSessionMock: vi.fn(async () => null as unknown),
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))

vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

const FEEDBACK_ID = '11111111-1111-4111-8111-111111111111'

type SupportBody = Record<string, unknown>

function supportRequest(
    body: SupportBody,
    headers: Record<string, string> = {},
) {
    return new NextRequest('http://localhost/api/support', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    })
}

function validBody(overrides: SupportBody = {}): SupportBody {
    return {
        feedback_id: FEEDBACK_ID,
        feedback_type: 'problem',
        message: 'The coupon did not apply at checkout.',
        wants_reply: false,
        ...overrides,
    }
}

beforeEach(() => {
    sendEmailMock.mockReset()
    sendEmailMock.mockResolvedValue(undefined)
    captureServerEventMock.mockReset()
    captureServerEventMock.mockResolvedValue(true)
    captureExceptionMock.mockClear()
    getSessionMock.mockReset()
    getSessionMock.mockResolvedValue(null)
})

describe('POST /api/support — support/feedback flow', () => {
    it('anonymous submit attempts BOTH destinations → 200 { analytics:ok, email:ok }', async () => {
        const res = await POST(supportRequest(validBody()))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            ok: true,
            analytics: 'ok',
            email: 'ok',
        })
        expect(captureServerEventMock).toHaveBeenCalledTimes(1)
        expect(captureServerEventMock.mock.calls[0]![0]).toMatchObject({
            event: 'support_request_submitted',
        })
        expect(sendEmailMock).toHaveBeenCalledTimes(1)
    })

    it('authenticated submit uses the SESSION user_id + email and IGNORES client-supplied identity', async () => {
        getSessionMock.mockResolvedValue({
            user: { id: 'user-1', email: 'real@user.com' },
            session: {},
        })

        const res = await POST(
            supportRequest(
                validBody({
                    wants_reply: true,
                    email: 'attacker@evil.com',
                    posthog_distinct_id: 'client-distinct',
                }),
            ),
        )

        expect(res.status).toBe(200)
        // PostHog: distinctId + bag identity come from the session.
        const phArgs = captureServerEventMock.mock.calls[0]![0] as {
            distinctId: string
            properties: Record<string, unknown>
        }
        expect(phArgs.distinctId).toBe('user-1')
        expect(phArgs.properties.user_id).toBe('user-1')
        // Email replyTo is the SESSION email, never the client-supplied one.
        const emailArg = sendEmailMock.mock.calls[0]![0] as {
            replyTo?: string
            text: string
        }
        expect(emailArg.replyTo).toBe('real@user.com')
        expect(emailArg.text).not.toContain('attacker@evil.com')
    })

    it('anonymous wants_reply without an email → 422, nothing sent', async () => {
        const res = await POST(supportRequest(validBody({ wants_reply: true })))

        expect(res.status).toBe(422)
        expect(sendEmailMock).not.toHaveBeenCalled()
        expect(captureServerEventMock).not.toHaveBeenCalled()
    })

    it('honeypot filled → 200 { ok:true }, email NOT sent', async () => {
        const res = await POST(
            supportRequest(validBody({ website: 'http://spam.example' })),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(sendEmailMock).not.toHaveBeenCalled()
    })

    it('rejects a missing message (422)', async () => {
        const res = await POST(supportRequest(validBody({ message: '   ' })))
        expect(res.status).toBe(422)
        expect(sendEmailMock).not.toHaveBeenCalled()
    })

    it('rejects an over-length message (422)', async () => {
        const res = await POST(
            supportRequest(validBody({ message: 'x'.repeat(4001) })),
        )
        expect(res.status).toBe(422)
    })

    it('email fails → 200 { analytics:ok, email:failed } + Sentry captured with feedback_id', async () => {
        sendEmailMock.mockRejectedValue(new Error('smtp down'))

        const res = await POST(supportRequest(validBody()))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            ok: true,
            analytics: 'ok',
            email: 'failed',
        })
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
        const ctx = captureExceptionMock.mock.calls[0]![1] as {
            contexts: { support: { feedback_id: string } }
        }
        expect(ctx.contexts.support.feedback_id).toBe(FEEDBACK_ID)
    })

    it('posthog fails (capture resolves false) → 200 { analytics:failed, email:ok }', async () => {
        captureServerEventMock.mockResolvedValue(false)

        const res = await POST(supportRequest(validBody()))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            ok: true,
            analytics: 'failed',
            email: 'ok',
        })
    })

    it('both destinations fail → 502 echoing feedback_id', async () => {
        captureServerEventMock.mockResolvedValue(false)
        sendEmailMock.mockRejectedValue(new Error('smtp down'))

        const res = await POST(supportRequest(validBody()))

        expect(res.status).toBe(502)
        expect(await res.json()).toEqual({
            ok: false,
            analytics: 'failed',
            email: 'failed',
            feedback_id: FEEDBACK_ID,
        })
    })

    it('the SAME feedback_id flows to BOTH the email text and the posthog properties', async () => {
        await POST(supportRequest(validBody()))

        const phProps = (
            captureServerEventMock.mock.calls[0]![0] as {
                properties: Record<string, unknown>
            }
        ).properties
        const emailText = (sendEmailMock.mock.calls[0]![0] as { text: string })
            .text
        expect(phProps.feedback_id).toBe(FEEDBACK_ID)
        expect(emailText).toContain(FEEDBACK_ID)
    })

    it('sets replyTo to the customer email only when wants_reply, and never a from = customer', async () => {
        // wants_reply true (anonymous, with email) → replyTo present.
        await POST(
            supportRequest(
                validBody({ wants_reply: true, email: 'me@example.com' }),
            ),
        )
        const withReply = sendEmailMock.mock.calls[0]![0] as {
            replyTo?: string
            from?: string
        }
        expect(withReply.replyTo).toBe('me@example.com')
        // The route never sets `from` (email.ts owns the verified sender).
        expect(withReply.from).toBeUndefined()

        sendEmailMock.mockClear()

        // wants_reply false → no replyTo at all.
        await POST(supportRequest(validBody({ wants_reply: false })))
        const noReply = sendEmailMock.mock.calls[0]![0] as { replyTo?: string }
        expect(noReply.replyTo).toBeUndefined()
    })

    it('never leaks request-header secrets (Cookie/Authorization) into either destination', async () => {
        await POST(
            supportRequest(validBody(), {
                cookie: 'session=super-secret-cookie-value',
                authorization: 'Bearer super-secret-token',
            }),
        )

        const phJson = JSON.stringify(
            (
                captureServerEventMock.mock.calls[0]![0] as {
                    properties: Record<string, unknown>
                }
            ).properties,
        )
        const emailText = (sendEmailMock.mock.calls[0]![0] as { text: string })
            .text

        for (const secret of [
            'super-secret-cookie-value',
            'super-secret-token',
        ]) {
            expect(phJson).not.toContain(secret)
            expect(emailText).not.toContain(secret)
        }
    })
})
