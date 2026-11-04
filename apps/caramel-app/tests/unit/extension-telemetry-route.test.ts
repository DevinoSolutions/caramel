import { OPTIONS, POST } from '@/app/api/extension/telemetry/route'
import {
    CODE_SHARE_FUNNEL_EVENT,
    CODE_SHARE_FUNNEL_STEP_REASONS,
    MIN_USAGE_DIAGNOSTICS_CONSENT_PROMPT_VERSION,
} from '@/lib/analytics/codeShareFunnel'
import {
    EXTENSION_ACTIVE_EVENT,
    MIN_DAILY_ACTIVE_CONSENT_PROMPT_VERSION,
    dailyActiveEventUuid,
} from '@/lib/extensionActivity'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/extension/telemetry — the opt-in, pseudonymous usage diagnostics:
// where the checkout code-sharing offer stops, and (kind 'daily_active', at
// the end of this file) the Google Chrome popup-open daily-active event. The PostHog wrapper and the rate limiter
// are TEST DOUBLES; the real withRoute (origin gate, strict zod body, error
// mapping) and the real consent-proof gate run. What this file pins:
//   - no accepted consent proof => 403 `consent-required` and NOTHING emitted,
//   - the body is strict (an unknown key anywhere is refused, so a `code` can
//     never ride along),
//   - the emitted properties are EXACTLY the allowlist,
//   - the distinct id is the random per-device telemetry id, never a user.

interface CapturedEvent {
    event: string
    distinctId: string
    uuid?: string
    properties?: Record<string, unknown>
}

const { captureMock, checkRateLimitMock, getSessionMock, envMock } = vi.hoisted(
    () => ({
        envMock: { EXTENSION_DAU_TELEMETRY_ENABLED: false } as Record<
            string,
            unknown
        >,
        captureMock: vi.fn(async (_args: CapturedEvent) => true),
        checkRateLimitMock: vi.fn(
            async (_req: unknown, _kind: unknown) => null as unknown,
        ),
        getSessionMock: vi.fn(async () => null as unknown),
    }),
)

vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: captureMock,
}))
// The real env, with the daily-active switch under the test's control.
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env, {
        EXTENSION_DAU_TELEMETRY_ENABLED: false,
    })
    return { ...actual, env: envMock }
})
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: checkRateLimitMock }
})
// The route is unauthenticated: it must never resolve a session. If it ever does,
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
    envMock.EXTENSION_DAU_TELEMETRY_ENABLED = false
    vi.useRealTimers()
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

    it('is unauthenticated: no session is resolved, whatever credentials the request carries', async () => {
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

    it('draws on its OWN rate-limit bucket, never the shared mutation budget', async () => {
        await POST(telemetryRequest(validBody()))

        expect(checkRateLimitMock).toHaveBeenCalledTimes(1)
        expect(checkRateLimitMock.mock.calls[0]?.[1]).toBe('telemetry')
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

// ---------------------------------------------------------------------------
// kind 'daily_active' — the Google Chrome popup-open daily-active event
// (src/lib/extensionActivity.ts). Same route, same consent gate, same
// 'telemetry' bucket; its own strict variant, the server day policy and the
// EXTENSION_DAU_TELEMETRY_ENABLED switch (which never touches funnel events).

const SERVER_NOW = Date.parse('2026-10-22T12:00:00Z')

function dailyActive(overrides: Record<string, unknown> = {}) {
    return {
        kind: 'daily_active',
        day: '2026-10-22',
        extVersion: '1.4.18',
        browser: 'chrome',
        ...overrides,
    }
}

// A yes given on the first card that named daily activity.
const DAILY_CONSENT = {
    choice: 'accepted',
    promptVersion: MIN_DAILY_ACTIVE_CONSENT_PROMPT_VERSION,
}

const dailyBody = (eventOverrides: Record<string, unknown> = {}) =>
    validBody({ event: dailyActive(eventOverrides), consent: DAILY_CONSENT })

describe('POST /api/extension/telemetry: daily_active', () => {
    beforeEach(() => {
        envMock.EXTENSION_DAU_TELEMETRY_ENABLED = true
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(SERVER_NOW)
    })

    it('captures extension_active under the diagnostics id with exactly the reviewed properties', async () => {
        const res = await POST(telemetryRequest(dailyBody()))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ captured: true })
        expect(captureMock).toHaveBeenCalledTimes(1)
        const call = captureMock.mock.calls[0]![0]
        expect(call.event).toBe(EXTENSION_ACTIVE_EVENT)
        expect(call.event).toBe('extension_active')
        expect(call.distinctId).toBe(TELEMETRY_ID)
        expect(call.uuid).toBe(dailyActiveEventUuid(TELEMETRY_ID, '2026-10-22'))
        expect(call.properties).toEqual({
            day: '2026-10-22',
            ext_version: '1.4.18',
            browser: 'chrome',
            platform: 'extension',
            activity_trigger: 'popup_open',
            $process_person_profile: false,
            $geoip_disable: true,
        })
    })

    it('a retry of the same id and day carries the same event uuid; another day or id does not', async () => {
        await POST(telemetryRequest(dailyBody()))
        await POST(telemetryRequest(dailyBody()))
        const [a, b] = captureMock.mock.calls.map(c => c[0].uuid)
        expect(a).toBe(b)
        expect(a).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        )
        expect(dailyActiveEventUuid(TELEMETRY_ID, '2026-10-23')).not.toBe(a)
        expect(
            dailyActiveEventUuid(
                '5c1f0d7e-2b3a-4f6c-8d9e-0a1b2c3d4e5f',
                '2026-10-22',
            ),
        ).not.toBe(a)
    })

    it('unauthenticated: credentials on the request change nothing and no session is read', async () => {
        await POST(
            telemetryRequest(dailyBody(), {
                origin: EXTENSION_ORIGIN,
                authorization: 'Bearer user-session-token',
                cookie: 'better-auth.session_token=abc',
            }),
        )

        expect(getSessionMock).not.toHaveBeenCalled()
        expect(JSON.stringify(captureMock.mock.calls[0]![0])).not.toMatch(
            /user-session-token|session_token|signed_in/,
        )
    })

    it('server flag off: { captured: false } and NO capture', async () => {
        envMock.EXTENSION_DAU_TELEMETRY_ENABLED = false

        const res = await POST(telemetryRequest(dailyBody()))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ captured: false })
        expect(captureMock).not.toHaveBeenCalled()
    })

    it('server flag off never disables the code-share funnel', async () => {
        envMock.EXTENSION_DAU_TELEMETRY_ENABLED = false

        const res = await POST(telemetryRequest(validBody()))

        expect(await res.json()).toEqual({ captured: true })
        expect(captureMock.mock.calls[0]![0].event).toBe(
            CODE_SHARE_FUNNEL_EVENT,
        )
    })

    it.each([
        ['missing', undefined],
        ['declined', { choice: 'declined', promptVersion: 1 }],
        ['below the floor', { choice: 'accepted', promptVersion: 0 }],
        [
            'a v1 yes (checkout diagnostics only: the card did not name daily activity)',
            { choice: 'accepted', promptVersion: 1 },
        ],
    ])(
        'consent proof %s: 403 consent-required, no capture',
        async (_label, consent) => {
            const body: Record<string, unknown> = dailyBody()
            if (consent === undefined) delete body.consent
            else body.consent = consent

            const res = await POST(telemetryRequest(body))

            expect(res.status).toBe(403)
            expect(await res.json()).toEqual({ error: 'consent-required' })
            expect(captureMock).not.toHaveBeenCalled()
        },
    )

    it.each([
        ['signed_in', { signed_in: true }],
        ['a user id', { userId: 'u-1' }],
        ['an email', { email: 'a@b.co' }],
        ['a url', { url: 'https://shop.example/cart' }],
        ['a store', { store: 'example.com' }],
        ['a funnel step', { step: 'capture_armed' }],
        ['a dailyId', { dailyId: 'a'.repeat(64) }],
        ['another browser', { browser: 'edge' }],
        ['another kind', { kind: 'weekly_active' }],
        ['a non-version extVersion', { extVersion: 'latest' }],
        ['a day that is not a date', { day: '22/10/2026' }],
        ['no day', { day: undefined }],
    ])(
        'strict variant: %s is refused (422), no capture',
        async (_label, overrides) => {
            const res = await POST(telemetryRequest(dailyBody(overrides)))

            expect(res.status).toBe(422)
            expect(captureMock).not.toHaveBeenCalled()
        },
    )

    it('a funnel event cannot borrow `kind` (strict both ways)', async () => {
        const res = await POST(
            telemetryRequest(
                validBody({ event: validEvent({ kind: 'daily_active' }) }),
            ),
        )

        expect(res.status).toBe(422)
        expect(captureMock).not.toHaveBeenCalled()
    })

    it.each([
        ['yesterday at noon', SERVER_NOW, '2026-10-21', 422],
        ['tomorrow at noon', SERVER_NOW, '2026-10-23', 422],
        ['an invalid calendar day', SERVER_NOW, '2026-02-30', 422],
        [
            'yesterday, 2 minutes after midnight',
            Date.parse('2026-10-22T00:02:00Z'),
            '2026-10-21',
            200,
        ],
        [
            'tomorrow, 2 minutes before midnight',
            Date.parse('2026-10-22T23:58:00Z'),
            '2026-10-23',
            200,
        ],
        [
            'yesterday, 10 minutes after midnight (past the 5-minute skew)',
            Date.parse('2026-10-22T00:10:00Z'),
            '2026-10-21',
            422,
        ],
    ])('day policy: %s → %s', async (_label, serverNow, day, status) => {
        vi.setSystemTime(serverNow)

        const res = await POST(telemetryRequest(dailyBody({ day })))

        expect(res.status).toBe(status)
        expect(captureMock).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
    })

    it('draws on the isolated telemetry rate-limit bucket', async () => {
        await POST(telemetryRequest(dailyBody()))

        expect(checkRateLimitMock.mock.calls[0]?.[1]).toBe('telemetry')
    })
})
