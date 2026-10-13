import { POST } from '@/app/api/ext/installed/route'
import {
    FIRST_TOUCH_COOKIE_NAME,
    serializeFirstTouchCookieValue,
} from '@/lib/analytics/firstTouchRecord'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/ext/installed: the server half of the /welcome handshake. The
// PostHog wrapper, Sentry and the rate limiter are TEST DOUBLES (…Mock); the
// real withRoute (origin check, zod body, error mapping) runs.

const { posthogServerMock } = vi.hoisted(() => ({
    posthogServerMock: {
        captureServerEvent: vi.fn(),
        getServerPosthogProjectToken: vi.fn(),
    },
}))
vi.mock('@/lib/analytics/posthogServer', () => posthogServerMock)

const { sentryMock } = vi.hoisted(() => ({
    sentryMock: { captureException: vi.fn(), captureMessage: vi.fn() },
}))
vi.mock('@sentry/nextjs', () => sentryMock)

vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

const IID = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'phc_test_token'

function installRequest(
    body: unknown,
    headers: Record<string, string> = {},
): NextRequest {
    return new NextRequest('http://localhost/api/ext/installed', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    })
}

const validBody = {
    store: 'chrome',
    extension_version: '1.4.6',
    iid: IID,
}

beforeEach(() => {
    posthogServerMock.captureServerEvent.mockReset().mockResolvedValue(true)
    posthogServerMock.getServerPosthogProjectToken
        .mockReset()
        .mockReturnValue(TOKEN)
    sentryMock.captureException.mockReset()
    sentryMock.captureMessage.mockReset()
})

describe('POST /api/ext/installed', () => {
    it('captures extension_installed with the install id as the event uuid and replies { captured: true }', async () => {
        const res = await POST(installRequest(validBody))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ captured: true })
        expect(posthogServerMock.captureServerEvent).toHaveBeenCalledTimes(1)
        expect(
            posthogServerMock.captureServerEvent.mock.calls[0]![0],
        ).toMatchObject({
            event: 'extension_installed',
            uuid: IID,
            distinctId: IID,
            properties: {
                store: 'chrome',
                extension_version: '1.4.6',
                iid: IID,
                source: 'chrome_web_store_organic',
                capture_path: 'server',
                $process_person_profile: false,
            },
        })
    })

    it('source and first_* come from the cm_ft cookie when the visitor has one', async () => {
        const cookie = `${FIRST_TOUCH_COOKIE_NAME}=${serializeFirstTouchCookieValue(
            {
                utm_source: 'tiktok_ads',
                ttclid: 't1',
                captured_at: '2026-10-01T00:00:00.000Z',
            },
        )}`
        await POST(installRequest(validBody, { cookie }))

        expect(
            posthogServerMock.captureServerEvent.mock.calls[0]![0].properties,
        ).toMatchObject({
            source: 'tiktok_ads',
            first_utm_source: 'tiktok_ads',
            first_ttclid: 't1',
        })
    })

    it('distinct id: body.distinct_id, else the PostHog cookie, else the install id', async () => {
        await POST(installRequest({ ...validBody, distinct_id: 'browser-id' }))
        expect(
            posthogServerMock.captureServerEvent.mock.calls[0]![0].distinctId,
        ).toBe('browser-id')

        const phCookie = `ph_${TOKEN}_posthog=${encodeURIComponent(JSON.stringify({ distinct_id: 'cookie-id' }))}`
        await POST(installRequest(validBody, { cookie: phCookie }))
        expect(
            posthogServerMock.captureServerEvent.mock.calls[1]![0].distinctId,
        ).toBe('cookie-id')

        await POST(installRequest(validBody))
        expect(
            posthogServerMock.captureServerEvent.mock.calls[2]![0].distinctId,
        ).toBe(IID)
    })

    it('replies { captured: false } (never a bare 200 ok) when PostHog did not take the event', async () => {
        posthogServerMock.captureServerEvent.mockResolvedValue(false)
        const res = await POST(installRequest(validBody))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ captured: false })
    })

    it.each([
        ['an unknown store', { ...validBody, store: 'opera' }],
        ['a non-uuid install id', { ...validBody, iid: 'not-a-uuid' }],
        ['a malformed version', { ...validBody, extension_version: 'latest' }],
        ['a missing field', { store: 'chrome', iid: IID }],
        [
            'an oversize distinct_id',
            { ...validBody, distinct_id: 'x'.repeat(201) },
        ],
    ])('rejects %s with a 4xx and captures nothing', async (_label, body) => {
        const res = await POST(installRequest(body))
        expect(res.status).toBeGreaterThanOrEqual(400)
        expect(res.status).toBeLessThan(500)
        expect(posthogServerMock.captureServerEvent).not.toHaveBeenCalled()
    })

    it('rejects a cross-site Origin (same-origin only) and captures nothing', async () => {
        const res = await POST(
            installRequest(validBody, { origin: 'https://evil.example' }),
        )
        expect(res.status).toBe(403)
        expect(posthogServerMock.captureServerEvent).not.toHaveBeenCalled()
    })
})
