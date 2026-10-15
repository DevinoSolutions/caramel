import { OPTIONS, POST } from '@/app/api/extension/telemetry/route'
import {
    CODE_SHARE_FUNNEL_EVENT,
    CODE_SHARE_FUNNEL_STEP_REASONS,
    MIN_USAGE_DIAGNOSTICS_CONSENT_PROMPT_VERSION,
} from '@/lib/analytics/codeShareFunnel'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/extension/telemetry — the opt-in, anonymous report of where the
// checkout code-sharing offer stops. The PostHog wrapper and the rate limiter
// are TEST DOUBLES; the real withRoute (origin gate, strict zod body, error
// mapping) and the real consent-proof gate run. What this file pins:
//   - no accepted consent proof => 403 `consent-required` and NOTHING emitted,
//   - the body is strict (an unknown key anywhere is refused, so a `code` can
//     never ride along),
//   - the emitted properties are EXACTLY the allowlist,
//   - the distinct id is the random per-install telemetry id, never a user.

interface CapturedEvent {
    event: string
    distinctId: string
    uuid?: string
    properties?: Record<string, unknown>
}

const { captureMock, checkRateLimitMock, getSessionMock } = vi.hoisted(() => ({
    captureMock: vi.fn(async (_args: CapturedEvent) => true),
    checkRateLimitMock: vi.fn(async () => null as unknown),
    getSessionMock: vi.fn(async () => null as unknown),
}))

vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: captureMock,
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: checkRateLimitMock }
})
// The route is anonymous: it must never resolve a session. If it ever does,
// this double records the call and the test below fails.
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))

const TELEMETRY_ID = '3f2b8c1e-7d4a-4c2e-9b6f-1a2b3c4d5e6f'
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

const VALID_CONSENT = {
    choice: 'accepted',
    promptVersion: MIN_USAGE_DIAGNOSTICS_CONSENT_PROMPT_VERSION,
}

function validEvent(overrides: Record<string, unknown> = {}) {
    return {
        step: 'capture_armed',
        store: 'example.com',
        extVersion: '1.4.14',
        browser: 'chrome',
        sharingPromptVersion: 1,
        ...overrides,
    }
}

function validBody(overrides: Record<string, unknown> = {}) {
    return {
        id: TELEMETRY_ID,
        event: validEvent(),
        consent: VALID_CONSENT,
        ...overrides,
    }
}

function telemetryRequest(
    body: unknown,
    headers: Record<string, string> = { origin: EXTENSION_ORIGIN },
): NextRequest {
    return new NextRequest('http://localhost/api/extension/telemetry', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    })
}

beforeEach(() => {
    captureMock.mockReset().mockResolvedValue(true)
    checkRateLimitMock.mockReset().mockResolvedValue(null)
    getSessionMock.mockReset().mockResolvedValue(null)
})

describe('POST /api/extension/telemetry: the happy path', () => {
    it('emits one extension_code_share_funnel event keyed by the telemetry id and replies { captured: true }', async () => {
        const res = await POST(telemetryRequest(validBody()))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ captured: true })
        expect(captureMock).toHaveBeenCalledTimes(1)
        const call = captureMock.mock.calls[0]![0]
        expect(call.event).toBe(CODE_SHARE_FUNNEL_EVENT)
        expect(call.event).toBe('extension_code_share_funnel')
        expect(call.distinctId).toBe(TELEMETRY_ID)
        // Not an idempotency-keyed event: no uuid.
        expect(call.uuid).toBeUndefined()
    })

    it('the emitted properties are EXACTLY the allowlist (and no person profile is minted)', async () => {
        await POST(telemetryRequest(validBody()))

        expect(captureMock.mock.calls[0]![0].properties).toEqual({
            step: 'capture_armed',
            store: 'example.com',
            ext_version: '1.4.14',
            browser: 'chrome',
            sharing_prompt_version: 1,
            $process_person_profile: false,
        })
    })

    it('a reason rides along only on the steps that take one', async () => {
        await POST(
            telemetryRequest(
                validBody({
                    event: validEvent({
                        step: 'submit_skipped',
                        reason: 'signed-out',
                    }),
                }),
            ),
        )

        expect(captureMock.mock.calls[0]![0].properties).toEqual({
            step: 'submit_skipped',
            reason: 'signed-out',
            store: 'example.com',
            ext_version: '1.4.14',
            browser: 'chrome',
            sharing_prompt_version: 1,
            $process_person_profile: false,
        })
    })

    it('every step and reason in the vocabulary is accepted', async () => {
        for (const [step, reasons] of Object.entries(
            CODE_SHARE_FUNNEL_STEP_REASONS,
        )) {
            for (const reason of reasons.length ? reasons : [undefined]) {
                const res = await POST(
                    telemetryRequest(
                        validBody({ event: validEvent({ step, reason }) }),
                    ),
                )
                expect(res.status, `${step}/${reason}`).toBe(200)
            }
        }
    })

    it('is anonymous: no session is resolved, whatever credentials the request carries', async () => {
        await POST(
            telemetryRequest(validBody(), {
                origin: EXTENSION_ORIGIN,
                authorization: 'Bearer user-session-token',
                cookie: 'better-auth.session_token=abc',
            }),
        )

        expect(getSessionMock).not.toHaveBeenCalled()
        const props = JSON.stringify(captureMock.mock.calls[0]![0])
        expect(props).not.toMatch(/user-session-token|session_token/)
    })

    it('replies { captured: false } (200) when PostHog did not take the event, so the extension can log it', async () => {
        captureMock.mockResolvedValue(false)

        const res = await POST(telemetryRequest(validBody()))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ captured: false })
    })
})

describe('POST /api/extension/telemetry: no accepted consent proof => 403 and nothing emitted', () => {
    it.each([
        ['no consent field', undefined],
        ['null', null],
        ['declined', { choice: 'declined', promptVersion: 1 }],
        ['a version below the floor', { choice: 'accepted', promptVersion: 0 }],
        ['no version', { choice: 'accepted' }],
        ['a string', 'accepted'],
        [
            'an unknown extra key (strict)',
            { choice: 'accepted', promptVersion: 1, at: '2026-10-15' },
        ],
        ['a fractional version', { choice: 'accepted', promptVersion: 1.5 }],
    ])('%s', async (_label, consent) => {
        const body: Record<string, unknown> = validBody()
        if (consent === undefined) delete body.consent
        else body.consent = consent

        const res = await POST(telemetryRequest(body))

        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'consent-required' })
        expect(captureMock).not.toHaveBeenCalled()
    })
})

describe('POST /api/extension/telemetry: the body is strict (422, nothing emitted)', () => {
    it.each([
        ['a code in the event', { event: validEvent({ code: 'SAVE10' }) }],
        [
            'a url in the event',
            { event: validEvent({ url: 'https://x.co/c' }) },
        ],
        ['a user id in the event', { event: validEvent({ userId: 'u-1' }) }],
        ['an unknown top-level key', { userId: 'u-1' }],
        ['an unknown step', { event: validEvent({ step: 'code_typed' }) }],
        [
            'a reason on a step that takes none',
            { event: validEvent({ reason: 'signed-out' }) },
        ],
        [
            'no reason on a step that needs one',
            { event: validEvent({ step: 'submit_skipped' }) },
        ],
        [
            'a reason that belongs to another step',
            {
                event: validEvent({
                    step: 'store_not_accepted',
                    reason: 'signed-out',
                }),
            },
        ],
        [
            'a store that is a URL',
            { event: validEvent({ store: 'https://example.com/cart' }) },
        ],
        [
            'a store with a path',
            { event: validEvent({ store: 'example.com/cart' }) },
        ],
        [
            'a store with a code in it',
            { event: validEvent({ store: 'example.com?code=SAVE10' }) },
        ],
        ['a missing store', { event: validEvent({ store: undefined }) }],
        [
            'a non-version extVersion',
            { event: validEvent({ extVersion: 'latest' }) },
        ],
        ['an unknown browser', { event: validEvent({ browser: 'opera' }) }],
        [
            'a zero prompt version',
            { event: validEvent({ sharingPromptVersion: 0 }) },
        ],
        ['an id that is not a uuid', { id: 'user-42' }],
        ['a missing id', { id: undefined }],
        ['a missing event', { event: undefined }],
    ])('%s', async (_label, overrides) => {
        const res = await POST(telemetryRequest(validBody(overrides)))

        expect(res.status).toBe(422)
        expect(captureMock).not.toHaveBeenCalled()
    })

    it('a body that is not JSON is a 422 too', async () => {
        const res = await POST(
            new NextRequest('http://localhost/api/extension/telemetry', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    origin: EXTENSION_ORIGIN,
                },
                body: 'not json',
            }),
        )

        expect(res.status).toBe(422)
        expect(captureMock).not.toHaveBeenCalled()
    })
})

describe('POST /api/extension/telemetry: who may call it', () => {
    it('refuses a request with no Origin (extension-only, unlike the website routes)', async () => {
        const res = await POST(telemetryRequest(validBody(), {}))

        expect(res.status).toBe(403)
        expect(captureMock).not.toHaveBeenCalled()
    })

    it('refuses a web page, the Caramel site included', async () => {
        for (const origin of ['https://evil.example', 'http://localhost']) {
            const res = await POST(telemetryRequest(validBody(), { origin }))
            expect(res.status, origin).toBe(403)
        }
        expect(captureMock).not.toHaveBeenCalled()
    })

    it.each([
        'chrome-extension://abc',
        'moz-extension://abc',
        'safari-web-extension://abc',
    ])('accepts the %s protocol', async origin => {
        const res = await POST(telemetryRequest(validBody(), { origin }))
        expect(res.status).toBe(200)
    })

    it('is rate limited: a blocked request emits nothing', async () => {
        checkRateLimitMock.mockResolvedValue(
            new Response(JSON.stringify({ error: 'Too many requests' }), {
                status: 429,
            }),
        )

        const res = await POST(telemetryRequest(validBody()))

        expect(res.status).toBe(429)
        expect(captureMock).not.toHaveBeenCalled()
    })

    it('answers the preflight (204)', async () => {
        const res = await OPTIONS(
            new NextRequest('http://localhost/api/extension/telemetry', {
                method: 'OPTIONS',
                headers: { origin: EXTENSION_ORIGIN },
            }),
        )

        expect(res.status).toBe(204)
    })
})
