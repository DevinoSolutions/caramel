import { OPTIONS, POST, dynamic } from '@/app/api/extension/activity/route'
import {
    EXTENSION_ACTIVITY_EVENT,
    extensionActivityEventUuid,
    isAcceptedActivityDay,
    utcDay,
} from '@/lib/extensionActivity'
import { NextRequest, NextResponse } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/extension/activity — the Google Chrome extension's once-per-UTC-day
// ping (contract: src/lib/extensionActivity.ts). Mocks only the edges: the
// PostHog capture boundary, the better-auth session lookup, the rate-limit
// round-trip, and the env flag. withRoute's origin/CORS/body gates run for
// real. The extension half is apps/caramel-extension/tests/extension-activity.test.mjs.
type CaptureArgs = {
    event: string
    distinctId: string
    properties?: Record<string, unknown>
    uuid?: string
}

const {
    envMock,
    captureMock,
    captureConfiguredMock,
    getSessionMock,
    checkRateLimitMock,
} = vi.hoisted(() => ({
    envMock: {} as Record<string, unknown>,
    captureMock: vi.fn(async (_args: CaptureArgs) => true),
    captureConfiguredMock: vi.fn(() => true),
    getSessionMock: vi.fn(async (_args: unknown) => null as unknown),
    checkRateLimitMock: vi.fn(async () => null as unknown),
}))

vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env)
    return { ...actual, env: envMock }
})
vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: captureMock,
    isServerCaptureConfigured: captureConfiguredMock,
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: checkRateLimitMock }
})

const NOW = Date.parse('2026-10-05T12:00:00Z')
const DAILY_ID = 'a'.repeat(32) + '0123456789abcdef'.repeat(2)
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

function validBody(overrides: Record<string, unknown> = {}) {
    return {
        dailyId: DAILY_ID,
        day: '2026-10-05',
        extensionVersion: '1.4.3',
        browser: 'chrome',
        ...overrides,
    }
}

function activityRequest(
    body: unknown,
    headers: Record<string, string> = {},
): NextRequest {
    return new NextRequest('http://localhost/api/extension/activity', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            origin: EXT_ORIGIN,
            ...headers,
        },
        body: JSON.stringify(body),
    })
}

const capturedArgs = () => captureMock.mock.calls[0]![0]

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    envMock.EXTENSION_DAU_TELEMETRY_ENABLED = true
    captureMock.mockReset()
    captureMock.mockResolvedValue(true)
    captureConfiguredMock.mockReset()
    captureConfiguredMock.mockReturnValue(true)
    getSessionMock.mockReset()
    getSessionMock.mockResolvedValue(null)
    checkRateLimitMock.mockReset()
    checkRateLimitMock.mockResolvedValue(null)
})

afterEach(() => {
    vi.useRealTimers()
})

describe('POST /api/extension/activity — capture', () => {
    it('guest: captures extension_active on the daily id, signed_in false → 200 recorded', async () => {
        const res = await POST(activityRequest(validBody()))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ status: 'recorded' })
        expect(captureMock).toHaveBeenCalledTimes(1)
        expect(capturedArgs()).toEqual({
            event: EXTENSION_ACTIVITY_EVENT,
            distinctId: DAILY_ID,
            uuid: extensionActivityEventUuid(DAILY_ID),
            properties: {
                day: '2026-10-05',
                extension_version: '1.4.3',
                browser: 'chrome',
                signed_in: false,
                platform: 'extension',
                activity_trigger: 'popup_open',
                $process_person_profile: false,
                $geoip_disable: true,
            },
        })
    })

    it('valid session: signed_in true — and nothing about the account reaches PostHog', async () => {
        getSessionMock.mockResolvedValue({
            user: { id: 'user-42', email: 'sam@example.com', name: 'Sam' },
            session: { id: 'sess-1', token: 'tok-secret' },
        })

        const res = await POST(
            activityRequest(validBody(), {
                authorization: 'Bearer tok-secret',
            }),
        )

        expect(await res.json()).toEqual({ status: 'recorded' })
        const args = capturedArgs()
        expect(args.properties?.signed_in).toBe(true)
        expect(args.distinctId).toBe(DAILY_ID)
        const wire = JSON.stringify(args)
        for (const secret of [
            'user-42',
            'sam@example.com',
            'Sam',
            'sess-1',
            'tok-secret',
            EXT_ORIGIN,
        ]) {
            expect(wire).not.toContain(secret)
        }
    })

    it('invalid/expired bearer resolves to no session: counted as a guest, never refused', async () => {
        getSessionMock.mockResolvedValue(null)

        const res = await POST(
            activityRequest(validBody(), { authorization: 'Bearer expired' }),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ status: 'recorded' })
        expect(capturedArgs().properties?.signed_in).toBe(false)
    })

    it('a thrown session lookup (auth DB down) is a loud 500, not a silent guest — the extension retries after its cooldown', async () => {
        getSessionMock.mockRejectedValue(new Error('db down'))

        await expect(POST(activityRequest(validBody()))).rejects.toThrow(
            'db down',
        )
        expect(captureMock).not.toHaveBeenCalled()
    })

    it('capture failure (captureServerEvent false) → 502 capture_failed, never "recorded"', async () => {
        captureMock.mockResolvedValue(false)

        const res = await POST(activityRequest(validBody()))

        expect(res.status).toBe(502)
        expect(await res.json()).toEqual({ status: 'capture_failed' })
    })

    it('the event uuid is deterministic per daily id (a resend after a lost response carries the same uuid) and RFC-shaped', () => {
        const uuid = extensionActivityEventUuid(DAILY_ID)
        expect(uuid).toBe(extensionActivityEventUuid(DAILY_ID))
        expect(uuid).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        )
        expect(extensionActivityEventUuid('b'.repeat(64))).not.toBe(uuid)
    })
})

describe('POST /api/extension/activity — switches', () => {
    it('kill switch off → 200 disabled, nothing captured', async () => {
        envMock.EXTENSION_DAU_TELEMETRY_ENABLED = false

        const res = await POST(activityRequest(validBody()))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ status: 'disabled' })
        expect(captureMock).not.toHaveBeenCalled()
    })

    it('PostHog dataset disabled/unconfigured → 200 disabled, nothing captured', async () => {
        captureConfiguredMock.mockReturnValue(false)

        const res = await POST(activityRequest(validBody()))

        expect(await res.json()).toEqual({ status: 'disabled' })
        expect(captureMock).not.toHaveBeenCalled()
    })

    it('the flag is read per request (force-dynamic)', () => {
        expect(dynamic).toBe('force-dynamic')
    })
})

describe('POST /api/extension/activity — refusals', () => {
    it.each([
        ['dailyId not 64 hex', { dailyId: 'abc' }],
        ['dailyId uppercase', { dailyId: DAILY_ID.toUpperCase() }],
        ['day malformed', { day: '2026-10-5' }],
        ['day impossible', { day: '2026-02-30' }],
        ['day two days ago', { day: '2026-10-03' }],
        ['day two days ahead', { day: '2026-10-07' }],
        ['bad version', { extensionVersion: '1.4.3-beta' }],
        ['browser edge', { browser: 'edge' }],
        ['browser firefox', { browser: 'firefox' }],
        ['client-sent signed_in', { signed_in: true }],
        ['extra identifying field', { url: 'https://shop.example/cart' }],
        ['seed smuggled in', { seed: 'f'.repeat(64) }],
    ])('%s → 422, nothing captured', async (_label, overrides) => {
        const res = await POST(activityRequest(validBody(overrides)))

        expect(res.status).toBe(422)
        expect(captureMock).not.toHaveBeenCalled()
    })

    it('missing field → 422', async () => {
        const { dailyId: _omit, ...rest } = validBody()
        const res = await POST(activityRequest(rest))
        expect(res.status).toBe(422)
    })

    it('a web page (non-extension Origin) is refused 403', async () => {
        const res = await POST(
            activityRequest(validBody(), {
                origin: 'https://evil.example',
            }),
        )
        expect(res.status).toBe(403)
        expect(captureMock).not.toHaveBeenCalled()
    })

    it('no Origin at all is refused 403 (strict extension gate, no missing-Origin bypass)', async () => {
        const req = new NextRequest('http://localhost/api/extension/activity', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validBody()),
        })
        expect((await POST(req)).status).toBe(403)
    })

    it('is rate-limited as a mutation → 429 passthrough, nothing captured', async () => {
        checkRateLimitMock.mockResolvedValue(
            NextResponse.json({ error: 'Too many requests' }, { status: 429 }),
        )

        const res = await POST(activityRequest(validBody()))

        expect(res.status).toBe(429)
        expect(checkRateLimitMock).toHaveBeenCalledWith(
            expect.anything(),
            'mutation',
        )
        expect(captureMock).not.toHaveBeenCalled()
    })

    it('answers a preflight (OPTIONS) with 204', async () => {
        const res = await OPTIONS(
            new NextRequest('http://localhost/api/extension/activity', {
                method: 'OPTIONS',
                headers: { origin: EXT_ORIGIN },
            }),
        )
        expect(res.status).toBe(204)
    })
})

describe('extensionActivity day window', () => {
    it('accepts yesterday, today and tomorrow (UTC) around midnight, nothing further', () => {
        const nearMidnight = Date.parse('2026-10-06T00:00:10Z')
        expect(utcDay(nearMidnight)).toBe('2026-10-06')
        expect(isAcceptedActivityDay('2026-10-05', nearMidnight)).toBe(true)
        expect(isAcceptedActivityDay('2026-10-06', nearMidnight)).toBe(true)
        expect(isAcceptedActivityDay('2026-10-07', nearMidnight)).toBe(true)
        expect(isAcceptedActivityDay('2026-10-04', nearMidnight)).toBe(false)
        expect(isAcceptedActivityDay('2026-10-08', nearMidnight)).toBe(false)
    })
})
