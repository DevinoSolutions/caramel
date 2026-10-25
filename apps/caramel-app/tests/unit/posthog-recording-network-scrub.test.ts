import { initPosthogInstance } from '@/lib/analytics/identity'
import type { PosthogTarget } from '@/lib/analytics/posthogDataset'
import { scrubRecordedNetworkRequest } from '@/lib/analytics/recordingNetworkScrub'
import { FILTERED } from '@/lib/sentryPiiScrub'
import type { PostHog } from 'posthog-js'
import { describe, expect, it, vi } from 'vitest'

// T-7505: PostHog session recordings record each network request's URL, and the
// store searches carry what a shopper typed in it. The hook strips it.

const TYPED = 'my-private-typed-text'
const TYPED_ENCODED = 'my-private%20typed%20text'

type Request = Parameters<typeof scrubRecordedNetworkRequest>[0]

function request(overrides: Partial<Request>): Request {
    // MOCK: a hand-built captured request, not a recorded one.
    return {
        name: 'https://grabcaramel.com/api/coupons/stores?limit=20',
        entryType: 'resource',
        initiatorType: 'fetch',
        method: 'GET',
        status: 200,
        startTime: 1,
        duration: 5,
        ...overrides,
    } as Request
}

function scrub(name: string): string {
    return scrubRecordedNetworkRequest(request({ name }))?.name ?? ''
}

describe('scrubRecordedNetworkRequest', () => {
    it.each([
        ['q', 'coupons/stores'],
        ['search', 'coupons'],
        ['key_words', 'coupons'],
        ['query', 'sites/search-supported'],
    ])('removes the %s value from a recorded request URL', (param, route) => {
        const out = scrub(
            `https://grabcaramel.com/api/${route}?${param}=${TYPED_ENCODED}&limit=20`,
        )
        expect(out).toBe(
            `https://grabcaramel.com/api/${route}?${param}=${FILTERED}&limit=20`,
        )
        expect(out).not.toContain('typed')
    })

    it('scrubs several search params in one URL, and a relative URL', () => {
        expect(
            scrub(`/api/coupons?search=${TYPED}&key_words=red,blue&page=2`),
        ).toBe(`/api/coupons?search=${FILTERED}&key_words=${FILTERED}&page=2`)
    })

    it('keeps method, status and timing, and leaves an unrelated URL alone', () => {
        const out = scrubRecordedNetworkRequest(
            request({
                name: 'https://grabcaramel.com/api/coupons?site=nike.com&page=2',
            }),
        )
        expect(out).toMatchObject({
            name: 'https://grabcaramel.com/api/coupons?site=nike.com&page=2',
            method: 'GET',
            status: 200,
            startTime: 1,
            duration: 5,
        })
    })

    it('scrubs the page URL of an initial navigation entry and keeps the entry', () => {
        const out = scrubRecordedNetworkRequest(
            request({
                name: `https://grabcaramel.com/coupons?search=${TYPED_ENCODED}`,
                isInitial: true,
                entryType: 'navigation',
            }),
        )
        expect(out).not.toBeNull()
        expect(out?.name).toBe(
            `https://grabcaramel.com/coupons?search=${FILTERED}`,
        )
        expect(out?.isInitial).toBe(true)
    })

    it('scrubs typed text in a JSON request body, so enabling payload capture later does not reopen it', () => {
        const out = scrubRecordedNetworkRequest(
            request({
                name: 'https://grabcaramel.com/api/sites/search-supported',
                method: 'POST',
                requestBody: `{"query":"${TYPED}","other":"kept"}`,
            }),
        )
        expect(out?.requestBody).not.toContain(TYPED)
        expect(out?.requestBody).toContain('"other":"kept"')
    })

    it('also strips credentials from a recorded URL', () => {
        expect(scrub('https://grabcaramel.com/cb?code=abc123&state=xyz')).toBe(
            `https://grabcaramel.com/cb?code=${FILTERED}&state=${FILTERED}`,
        )
    })
})

describe('PostHog init wires the network mask into session recording', () => {
    it('passes maskCapturedNetworkRequestFn, alongside the existing input masking', () => {
        // MOCK: fake PostHog client that records its init options.
        const client = {
            init: vi.fn(),
            register: vi.fn(),
            get_session_id: vi.fn(),
            get_distinct_id: vi.fn(),
            startSessionRecording: vi.fn(),
        }
        initPosthogInstance(
            client as unknown as PostHog,
            {
                token: 'phc_test',
                environment: 'test',
            } as unknown as PosthogTarget,
            { isE2E: false, deferRecording: false },
        )
        const options = client.init.mock.calls[0]?.[1]
        expect(options.session_recording.maskCapturedNetworkRequestFn).toBe(
            scrubRecordedNetworkRequest,
        )
        expect(options.session_recording.maskAllInputs).toBe(true)
    })
})
