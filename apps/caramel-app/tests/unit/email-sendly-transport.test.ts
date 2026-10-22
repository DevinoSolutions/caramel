import { sendEmail } from '@/lib/email'
import { SendlyError } from 'sendly-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Transport-level pins for src/lib/email.ts against the REAL `sendly-sdk`.
//
// email-replyTo.test.ts replaces the SDK class, so it cannot catch a wrong
// path, header, payload shape, receipt handling or error mapping. Here the SDK
// is the genuine 1.1.0 client and ONLY the network is faked.
//
// MOCK ANNOUNCEMENT: `fetch` is replaced (vi.stubGlobal) by
// fakeSendlyApiForUnitTests below, standing in for api.sendly.now - nothing
// leaves the process. The SDK reads globalThis.fetch when the client is
// constructed, and email.ts builds a fresh client per sendEmail call, so the
// stub is picked up. `@/lib/env` is mocked with a plain object.

const { envMock } = vi.hoisted(() => ({
    envMock: {
        SENDLY_API_KEY: 'sk_test_fake_key_for_unit_tests' as string | undefined,
        SENDLY_BASE_URL: undefined as string | undefined,
        SENDLY_FROM_EMAIL: 'no_reply@grabcaramel.com',
        SENDLY_FROM_NAME: 'Caramel',
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

interface CapturedRequest {
    url: string
    method: string
    authorization: string
    contentType: string
    body: {
        from: { email: string; name: string }
        to: string
        subject: string
        body: string
        reply?: string
        text?: string
    }
}

type Responder = (request: CapturedRequest) => Response | Promise<Response>

/** A 202 receipt as POST /api/v1/emails answers it. */
const receipt = (to: string, status = 'PENDING', id = `em_${to}`) =>
    Response.json(
        { id, status, to, from: 'no_reply@grabcaramel.com' },
        { status: 202 },
    )

/** The Sendly error body: `{ success: false, error: { message, code } }`. */
const apiError = (status: number, code: string, message: string) =>
    Response.json({ success: false, error: { message, code } }, { status })

let requests: CapturedRequest[]

/** MOCK: installs a fake api.sendly.now as the global fetch. */
function fakeSendlyApiForUnitTests(responder: Responder) {
    requests = []
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers)
            const captured: CapturedRequest = {
                url: String(input),
                method: init?.method ?? 'GET',
                authorization: headers.get('authorization') ?? '',
                contentType: headers.get('content-type') ?? '',
                body: JSON.parse(String(init?.body ?? '{}')),
            }
            requests.push(captured)
            return responder(captured)
        }),
    )
}

beforeEach(() => {
    envMock.SENDLY_API_KEY = 'sk_test_fake_key_for_unit_tests'
    envMock.SENDLY_BASE_URL = undefined
})
afterEach(() => {
    vi.unstubAllGlobals()
})

describe('sendEmail over the real SDK - request', () => {
    it('POSTs one JSON send to /api/v1/emails with a bearer key, the Caramel sender, the body and reply', async () => {
        fakeSendlyApiForUnitTests(request => receipt(request.body.to))

        await sendEmail({
            to: 'shopper@example.com',
            subject: 'Verify your email',
            html: '<p>hello</p>',
            text: 'hello (never transmitted: Sendly takes ONE body)',
            replyTo: 'customer@example.com',
        })

        expect(requests).toHaveLength(1)
        const [request] = requests
        expect(request!.url).toBe('https://api.sendly.now/api/v1/emails')
        expect(request!.method).toBe('POST')
        expect(request!.authorization).toBe(
            'Bearer sk_test_fake_key_for_unit_tests',
        )
        expect(request!.contentType).toBe('application/json')
        expect(request!.body).toEqual({
            from: { email: 'no_reply@grabcaramel.com', name: 'Caramel' },
            to: 'shopper@example.com',
            subject: 'Verify your email',
            body: '<p>hello</p>',
            reply: 'customer@example.com',
        })
    })

    it('honours SENDLY_BASE_URL and omits reply when none is given', async () => {
        envMock.SENDLY_BASE_URL = 'https://staging.sendly.example/'
        fakeSendlyApiForUnitTests(request => receipt(request.body.to))

        await sendEmail({ to: 'a@x.com', subject: 's', html: '<p>x</p>' })

        expect(requests[0]!.url).toBe(
            'https://staging.sendly.example/api/v1/emails',
        )
        expect('reply' in requests[0]!.body).toBe(false)
    })

    it('sends one request per recipient, each carrying only its own address', async () => {
        fakeSendlyApiForUnitTests(request => receipt(request.body.to))

        await sendEmail({
            to: ['a@x.com', 'b@y.com'],
            subject: 's',
            html: '<p>x</p>',
        })

        expect(requests.map(request => request.body.to).sort()).toEqual([
            'a@x.com',
            'b@y.com',
        ])
    })
})

describe('sendEmail over the real SDK - API and transport errors', () => {
    it('throws with the HTTP status, Sendly error code and a SendlyError cause on a 4xx', async () => {
        fakeSendlyApiForUnitTests(() =>
            apiError(422, 'validation_error', 'subject is required'),
        )

        const caught = await sendEmail({
            to: 'a@x.com',
            subject: 's',
            html: '<p>x</p>',
        }).catch((error: unknown) => error)

        expect(caught).toBeInstanceOf(Error)
        const error = caught as Error & { cause?: unknown }
        expect(error.message).toMatch(/Sendly email failed/)
        expect(error.message).toMatch(/status=422/)
        expect(error.message).toMatch(/code=validation_error/)
        expect(error.cause).toBeInstanceOf(SendlyError)
    })

    it('throws on a 5xx and on a revoked key (401) instead of resolving', async () => {
        fakeSendlyApiForUnitTests(() =>
            apiError(503, 'internal_error', 'try later'),
        )
        await expect(
            sendEmail({ to: 'a@x.com', subject: 's', html: '<p>x</p>' }),
        ).rejects.toThrow(/status=503/)

        fakeSendlyApiForUnitTests(() =>
            apiError(401, 'unauthorized', 'invalid api key'),
        )
        await expect(
            sendEmail({ to: 'a@x.com', subject: 's', html: '<p>x</p>' }),
        ).rejects.toThrow(/status=401/)
    })

    it('throws when the network itself fails', async () => {
        fakeSendlyApiForUnitTests(() => {
            throw new Error('ECONNRESET')
        })
        await expect(
            sendEmail({ to: 'a@x.com', subject: 's', html: '<p>x</p>' }),
        ).rejects.toThrow(/Sendly email failed.*ECONNRESET/)
    })
})

describe('sendEmail over the real SDK - receipts', () => {
    it.each(['PENDING', 'SENDING', 'SENT', 'DELIVERED'])(
        'accepts a %s receipt',
        async status => {
            fakeSendlyApiForUnitTests(request =>
                receipt(request.body.to, status),
            )
            await expect(
                sendEmail({ to: 'a@x.com', subject: 's', html: '<p>x</p>' }),
            ).resolves.toBeUndefined()
        },
    )

    it.each([
        'FAILED',
        'BOUNCED',
        'REJECTED',
        'RENDERING_FAILURE',
        'CANCELLED',
    ])(
        'throws on a 202 receipt that already carries terminal status %s, naming receipt id and status',
        async status => {
            fakeSendlyApiForUnitTests(request =>
                receipt(request.body.to, status, 'em_receipt_42'),
            )

            const caught = await sendEmail({
                to: 'private-shopper@example.com',
                subject: 's',
                html: '<p>x</p>',
            }).catch((error: unknown) => error)

            const message = (caught as Error).message
            expect(message).toMatch(/Sendly email failed/)
            expect(message).toContain('em_receipt_42')
            expect(message).toContain(status)
            expect(message).not.toContain('private-shopper@example.com')
        },
    )

    it('throws when the receipt has no id/status, since acceptance cannot be confirmed', async () => {
        fakeSendlyApiForUnitTests(() => Response.json({}, { status: 202 }))
        await expect(
            sendEmail({ to: 'a@x.com', subject: 's', html: '<p>x</p>' }),
        ).rejects.toThrow(/without an id\/status/)
    })
})

describe('sendEmail over the real SDK - mixed recipient outcomes', () => {
    it('attempts every recipient and throws naming the API-rejected one', async () => {
        fakeSendlyApiForUnitTests(request =>
            request.body.to === 'b@y.com'
                ? apiError(422, 'validation_error', 'recipient is invalid')
                : receipt(request.body.to),
        )

        const caught = await sendEmail({
            to: ['a@x.com', 'b@y.com', 'c@z.com'],
            subject: 's',
            html: '<p>x</p>',
        }).catch((error: unknown) => error)

        expect(requests).toHaveLength(3)
        const message = (caught as Error).message
        expect(message).toMatch(/recipient 2\/3: .*status=422/)
        expect(message).not.toMatch(/recipient 1\/3/)
        expect(message).not.toMatch(/recipient 3\/3/)
        for (const address of ['a@x.com', 'b@y.com', 'c@z.com']) {
            expect(message).not.toContain(address)
        }
    })

    it('a failed receipt for one recipient fails the whole fan-out even though the others were accepted', async () => {
        fakeSendlyApiForUnitTests(request =>
            request.body.to === 'a@x.com'
                ? receipt(request.body.to, 'BOUNCED', 'em_bounced_1')
                : receipt(request.body.to, 'PENDING'),
        )

        const caught = await sendEmail({
            to: ['a@x.com', 'b@y.com'],
            subject: 's',
            html: '<p>x</p>',
        }).catch((error: unknown) => error)

        expect(requests).toHaveLength(2)
        const message = (caught as Error).message
        expect(message).toMatch(/recipient 1\/2: .*em_bounced_1.*BOUNCED/)
        expect(message).not.toMatch(/recipient 2\/2/)
    })

    it('reports an API error and a failed receipt together in one error', async () => {
        fakeSendlyApiForUnitTests(request => {
            if (request.body.to === 'a@x.com') {
                return apiError(503, 'internal_error', 'down')
            }
            if (request.body.to === 'b@y.com') {
                return receipt(request.body.to, 'REJECTED', 'em_rej_9')
            }
            return receipt(request.body.to)
        })

        const caught = await sendEmail({
            to: ['a@x.com', 'b@y.com', 'c@z.com'],
            subject: 's',
            html: '<p>x</p>',
        }).catch((error: unknown) => error)

        const error = caught as Error & { cause?: unknown }
        expect(error.message).toMatch(/recipient 1\/3: .*status=503/)
        expect(error.message).toMatch(/recipient 2\/3: .*em_rej_9.*REJECTED/)
        // The SendlyError is the cause even though a receipt failure also exists.
        expect(error.cause).toBeInstanceOf(SendlyError)
    })
})
