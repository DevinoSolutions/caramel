import { POST } from '@/app/api/coupons/submit/route'
import {
    admitReport,
    resetReportDedupeForTests,
} from '@/lib/couponReportDedupe'
import {
    admitCouponReportVelocity,
    resetReportVelocityForTests,
} from '@/lib/couponReportVelocity'
import {
    MIN_CHECKOUT_CONSENT_PROMPT_VERSION,
    ShopperSubmissionLimitError,
    UnknownStoreError,
} from '@/lib/shopperCoupons'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/coupons/submit — the route a signed-in shopper's code travels
// through, from the website form (cookie session, same origin) AND from the
// extension background (bearer token). The data layer (submitShopperCoupon) and
// the trust signal (recordWorked) are mocked: their own behavior is pinned in
// shopper-coupons.test.ts / couponsRepo.test.ts / the integration suite. What
// this file pins is the ROUTE's contract: the gates, the status codes, and the
// one rule that separates the two sources (only a checkout capture, where the
// store itself accepted the code, stamps "worked"). The stamp POLICY
// (checkoutWorkedStamp.ts: reputation gate, dedupe, daily cap, velocity cap) runs
// for REAL here over a fake coupon_reports table (ANNOUNCED FAKE: `reportRows`
// below), so the route-to-policy wiring is exercised, not assumed.
interface CapturedEvent {
    event: string
    distinctId: string
    properties?: Record<string, unknown>
}

const {
    envMock,
    getSessionMock,
    submitShopperCouponMock,
    recordWorkedMock,
    checkRateLimitMock,
    captureMock,
    reportRows,
    sentryMessageMock,
    executeRawMock,
    stampedAt,
} = vi.hoisted(() => ({
    executeRawMock: vi.fn(async () => 0),
    // ANNOUNCED FAKE of coupon_signals.last_worked_at, per coupon id: set by the
    // recordWorked double (a real stamp), read by the dedupe (N3).
    stampedAt: new Map<string, Date>(),
    // The coupon_reports rows the stamp policy counts and writes (fake table).
    reportRows: [] as {
        couponId: string
        userId: string
        outcome: string
        createdAt: Date
    }[],
    sentryMessageMock: vi.fn(),
    envMock: { SHOPPER_CODE_CAPTURE_ENABLED: false } as Record<string, unknown>,
    getSessionMock: vi.fn(
        async (_opts: { headers: Headers }) => null as unknown,
    ),
    submitShopperCouponMock: vi.fn(
        async (_args: {
            base: string
            code: string
            source: 'checkout' | 'manual'
            userId: string
        }) => ({
            couponId: '900000000000000001',
            created: true,
            submittedByUser: true,
        }),
    ),
    recordWorkedMock: vi.fn(
        async (_couponId: string, _reporter: unknown, _client?: unknown) =>
            true,
    ),
    checkRateLimitMock: vi.fn(async () => null as unknown),
    captureMock: vi.fn(async (_args: CapturedEvent) => true),
}))

// The outcome telemetry goes through the shared server capture helper; it is
// replaced so nothing leaves the process, and after() (which needs a Next
// request scope vitest does not have) runs its task inline so the capture is
// still asserted. Same shape as agent-setup.test.ts.
vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: captureMock,
}))
vi.mock('next/server', async importOriginal => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: (task: () => unknown) => {
        void task()
    },
}))

// The real env (withRoute and rateLimit read it too) with the capture flag
// overridable per test.
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env, {
        SHOPPER_CODE_CAPTURE_ENABLED: false,
    })
    return { ...actual, env: envMock }
})
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))
vi.mock('@/lib/couponsRepo', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    submitShopperCoupon: submitShopperCouponMock,
}))
// ANNOUNCED FAKE: the policy's reads and writes of coupon_reports go to the
// in-memory `reportRows`; the transaction hands the callback this same client.
vi.mock('@/lib/prisma', () => {
    const couponReport = {
        count: vi.fn(
            async (args: {
                where: {
                    userId: string
                    outcome: string
                    createdAt: { gt: Date }
                }
            }) =>
                reportRows.filter(
                    row =>
                        row.userId === args.where.userId &&
                        row.outcome === args.where.outcome &&
                        row.createdAt > args.where.createdAt.gt,
                ).length,
        ),
        findFirst: vi.fn(
            async (args: {
                where: {
                    couponId: string
                    userId: string
                    outcome: string
                    createdAt: { gt: Date }
                }
            }) =>
                reportRows
                    .filter(
                        row =>
                            row.couponId === args.where.couponId &&
                            row.userId === args.where.userId &&
                            row.outcome === args.where.outcome &&
                            row.createdAt > args.where.createdAt.gt,
                    )
                    .sort(
                        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
                    )[0] ?? null,
        ),
        create: vi.fn(
            async (args: {
                data: { couponId: string; userId: string; outcome: string }
            }) => {
                const row = { ...args.data, createdAt: new Date() }
                reportRows.push(row)
                return row
            },
        ),
    }
    const couponSignal = {
        findUnique: vi.fn(async (args: { where: { couponId: string } }) => {
            const at = stampedAt.get(args.where.couponId)
            return at ? { lastWorkedAt: at } : null
        }),
    }
    const client = {
        couponReport,
        couponSignal,
        // lockShopperUser's pg_advisory_xact_lock statement.
        $executeRaw: executeRawMock,
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
            fn(client),
    }
    return { default: client }
})
vi.mock('@sentry/nextjs', () => ({
    captureException: vi.fn(),
    captureMessage: sentryMessageMock,
    setUser: vi.fn(),
}))
vi.mock('@/lib/couponSignals', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    recordWorked: recordWorkedMock,
}))
// isOriginAllowed stays real; only the rate-limit round trip is stubbed.
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: checkRateLimitMock }
})

// What extension 1.4.9+ sends for a shopper who accepted the prompt: the stored
// checkoutCodeSharingConsent record (code-sharing-consent.js).
const VALID_CONSENT = {
    choice: 'accepted',
    promptVersion: MIN_CHECKOUT_CONSENT_PROMPT_VERSION,
    at: '2026-10-06T12:00:00.000Z',
}

function submitRequest(
    body: unknown,
    headers: Record<string, string> = {},
): NextRequest {
    return new NextRequest('http://localhost/api/coupons/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    })
}

// An account old enough to be established (accountReputation.ts, default 7 days).
const OLD_ACCOUNT = new Date('2026-01-01T00:00:00.000Z')

function signedInAs(userId: string, createdAt: Date = OLD_ACCOUNT) {
    getSessionMock.mockImplementation(async () => ({
        session: { id: `session-${userId}` },
        user: { id: userId, createdAt },
    }))
}

beforeEach(() => {
    envMock.SHOPPER_CODE_CAPTURE_ENABLED = false
    getSessionMock.mockReset()
    getSessionMock.mockImplementation(async () => null)
    submitShopperCouponMock.mockReset()
    submitShopperCouponMock.mockImplementation(async () => ({
        couponId: '900000000000000001',
        created: true,
        submittedByUser: true,
    }))
    reportRows.length = 0
    sentryMessageMock.mockReset()
    executeRawMock.mockClear()
    resetReportDedupeForTests()
    resetReportVelocityForTests()
    stampedAt.clear()
    recordWorkedMock.mockReset()
    // A real stamp: last_worked_at moves to now.
    recordWorkedMock.mockImplementation(async (couponId: string) => {
        stampedAt.set(couponId, new Date())
        return true
    })
    checkRateLimitMock.mockReset()
    checkRateLimitMock.mockImplementation(async () => null)
    captureMock.mockReset()
    captureMock.mockImplementation(async () => true)
})

describe('POST /api/coupons/submit — gates', () => {
    it('no session → 401, nothing written', async () => {
        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(401)
        expect(getSessionMock).toHaveBeenCalledTimes(1)
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })

    it('a cross-origin browser request → 403 before the session is even read', async () => {
        signedInAs('user-1')

        const res = await POST(
            submitRequest(
                { site: 'ebay.com', code: 'SAVE10', source: 'manual' },
                { origin: 'https://evil.example', host: 'localhost' },
            ),
        )

        expect(res.status).toBe(403)
        // withRoute's order: origin gate first, so neither the session nor the
        // rate limiter is consulted for a request that is already refused.
        expect(getSessionMock).not.toHaveBeenCalled()
        expect(checkRateLimitMock).not.toHaveBeenCalled()
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
    })

    it('a same-origin website request (the Add a code form) is allowed: manual → 200', async () => {
        signedInAs('user-1')

        const res = await POST(
            submitRequest(
                { site: 'ebay.com', code: 'SAVE10', source: 'manual' },
                { origin: 'http://localhost', host: 'localhost' },
            ),
        )

        expect(res.status).toBe(200)
        expect(submitShopperCouponMock).toHaveBeenCalledTimes(1)
    })

    it('an extension-origin request is allowed through the origin gate', async () => {
        signedInAs('user-1')

        const res = await POST(
            submitRequest(
                { site: 'ebay.com', code: 'SAVE10', source: 'manual' },
                { origin: 'chrome-extension://abcdefghijklmnop' },
            ),
        )

        expect(res.status).toBe(200)
    })

    it("passes the caller's bearer header to the session lookup (the extension's auth)", async () => {
        signedInAs('user-1')

        await POST(
            submitRequest(
                { site: 'ebay.com', code: 'SAVE10', source: 'manual' },
                { authorization: 'Bearer ext-session-token' },
            ),
        )

        expect(getSessionMock).toHaveBeenCalledTimes(1)
        const headers = getSessionMock.mock.calls[0]![0].headers
        expect(headers.get('authorization')).toBe('Bearer ext-session-token')
    })

    it("is throttled in the 'mutation' bucket", async () => {
        signedInAs('user-1')

        await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(checkRateLimitMock).toHaveBeenCalledWith(
            expect.anything(),
            'mutation',
        )
    })

    it('a rate-limited caller → the limiter response, nothing written', async () => {
        signedInAs('user-1')
        const { NextResponse } = await import('next/server')
        checkRateLimitMock.mockImplementation(async () =>
            NextResponse.json({ error: 'Too many requests' }, { status: 429 }),
        )

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(429)
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
    })
})

describe('POST /api/coupons/submit — validation', () => {
    beforeEach(() => signedInAs('user-1'))

    it.each([
        [
            'an unknown source',
            { site: 'ebay.com', code: 'SAVE10', source: 'bot' },
        ],
        ['a missing site', { code: 'SAVE10', source: 'manual' }],
        ['an empty site', { site: '', code: 'SAVE10', source: 'manual' }],
        [
            'a site over 253 chars',
            { site: 'a'.repeat(254), code: 'SAVE10', source: 'manual' },
        ],
        ['a missing code', { site: 'ebay.com', source: 'manual' }],
        [
            'a non-string code',
            { site: 'ebay.com', code: 12345, source: 'manual' },
        ],
    ])('%s → 422 (body schema), nothing written', async (_label, body) => {
        const res = await POST(submitRequest(body))

        expect(res.status).toBe(422)
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
    })

    it.each([
        ['too short', 'ab'],
        ['contains spaces', 'a b c'],
        ['markup', '<script>'],
        ['over 40 chars', 'A'.repeat(41)],
        ['blank', '   '],
    ])(
        'a code that is %s → 422 invalid-code, nothing written',
        async (_l, code) => {
            const res = await POST(
                submitRequest({ site: 'ebay.com', code, source: 'manual' }),
            )

            expect(res.status).toBe(422)
            expect(await res.json()).toEqual({ error: 'invalid-code' })
            expect(submitShopperCouponMock).not.toHaveBeenCalled()
        },
    )

    it.each(['co.uk', 'localhost', 'not a host', 'foo.example'])(
        'a site that names no registrable store (%s) → 422 not-a-store, nothing written',
        async site => {
            const res = await POST(
                submitRequest({ site, code: 'SAVE10', source: 'manual' }),
            )

            expect(res.status).toBe(422)
            expect(await res.json()).toEqual({ error: 'not-a-store' })
            expect(submitShopperCouponMock).not.toHaveBeenCalled()
        },
    )
})

describe('POST /api/coupons/submit — manual source', () => {
    beforeEach(() => signedInAs('user-1'))

    it('submits for the RESOLVED base domain, returns Unverified, and never stamps "worked"', async () => {
        const res = await POST(
            submitRequest({
                site: 'WWW.Shop.eBay.com',
                code: '  SAVE10 ',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            couponId: '900000000000000001',
            created: true,
            status: 'unverified',
        })
        expect(submitShopperCouponMock).toHaveBeenCalledTimes(1)
        // base = the registrable domain (what the store page canonicalizes
        // to); the code is the trimmed one, case untouched; userId is users.id.
        expect(submitShopperCouponMock).toHaveBeenCalledWith({
            base: 'ebay.com',
            code: 'SAVE10',
            source: 'manual',
            userId: 'user-1',
        })
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })

    it('works with the capture flag OFF (the flag gates checkout capture only)', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = false

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(200)
        expect(submitShopperCouponMock).toHaveBeenCalledTimes(1)
    })

    it('a duplicate (created:false) is still a 200 and reports the existing id', async () => {
        submitShopperCouponMock.mockImplementation(async () => ({
            couponId: '42',
            created: false,
            submittedByUser: false,
        }))

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            couponId: '42',
            created: false,
            status: 'unverified',
        })
    })
})

describe('POST /api/coupons/submit — checkout source', () => {
    beforeEach(() => signedInAs('user-1'))

    it('flag OFF → 403 capture-disabled, and neither the repo nor recordWorked is touched', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = false

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'checkout',
                consent: VALID_CONSENT,
            }),
        )

        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'capture-disabled' })
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })

    it('flag ON → submits, then stamps the coupon "worked", and returns status worked', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        const res = await POST(
            submitRequest({
                site: 'checkout.ebay.com',
                code: 'SAVE10',
                source: 'checkout',
                consent: VALID_CONSENT,
            }),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            couponId: '900000000000000001',
            created: true,
            status: 'worked',
        })
        expect(submitShopperCouponMock).toHaveBeenCalledWith({
            base: 'ebay.com',
            code: 'SAVE10',
            source: 'checkout',
            userId: 'user-1',
        })
        expect(recordWorkedMock).toHaveBeenCalledTimes(1)
        expect(recordWorkedMock).toHaveBeenCalledWith(
            '900000000000000001',
            { kind: 'user', userId: 'user-1', established: true },
            expect.anything(),
            { forceStamp: true },
        )
        // The write order matters: the row must exist before it is stamped.
        expect(
            submitShopperCouponMock.mock.invocationCallOrder[0]!,
        ).toBeLessThan(recordWorkedMock.mock.invocationCallOrder[0]!)
    })

    // The Caramel website is the one non-extension Origin the origin gate lets
    // through to the handler (same-origin), so it is where the handler's own
    // checkout-source rule is what refuses the request.
    it('a checkout capture from the Caramel website (same-origin) → 403 checkout-source-extension-only, flag ON, nothing written', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        const res = await POST(
            submitRequest(
                {
                    site: 'ebay.com',
                    code: 'SAVE10',
                    source: 'checkout',
                    consent: VALID_CONSENT,
                },
                { origin: 'http://localhost', host: 'localhost' },
            ),
        )

        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({
            error: 'checkout-source-extension-only',
        })
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })

    // Any other web origin never reaches the handler: withRoute's origin gate
    // refuses it first, so a checkout capture from there is refused as well.
    it.each(['https://evil.example', 'http://shop.example'])(
        'a checkout capture from another web origin (%s) → 403, flag ON, nothing written',
        async origin => {
            envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

            const res = await POST(
                submitRequest(
                    {
                        site: 'ebay.com',
                        code: 'SAVE10',
                        source: 'checkout',
                        consent: VALID_CONSENT,
                    },
                    { origin, host: 'localhost' },
                ),
            )

            expect(res.status).toBe(403)
            expect(submitShopperCouponMock).not.toHaveBeenCalled()
            expect(recordWorkedMock).not.toHaveBeenCalled()
        },
    )

    it.each([
        'chrome-extension://abcdefghijklmnop',
        'moz-extension://11111111-2222-3333-4444-555555555555',
        'safari-web-extension://AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
    ])(
        'a checkout capture from an extension Origin (%s) is accepted',
        async origin => {
            envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

            const res = await POST(
                submitRequest(
                    {
                        site: 'ebay.com',
                        code: 'SAVE10',
                        source: 'checkout',
                        consent: VALID_CONSENT,
                    },
                    { origin },
                ),
            )

            expect(res.status).toBe(200)
            expect(recordWorkedMock).toHaveBeenCalledTimes(1)
        },
    )

    it('a checkout capture with NO Origin header is accepted (a background fetch may omit it)', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'checkout',
                consent: VALID_CONSENT,
            }),
        )

        expect(res.status).toBe(200)
    })

    it('the extension-only rule is about checkout: a manual add from a web page is unaffected', async () => {
        const res = await POST(
            submitRequest(
                { site: 'ebay.com', code: 'SAVE10', source: 'manual' },
                { origin: 'http://localhost', host: 'localhost' },
            ),
        )

        expect(res.status).toBe(200)
    })

    it('flag ON, duplicate of an existing coupon → still stamps THAT coupon worked', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true
        submitShopperCouponMock.mockImplementation(async () => ({
            couponId: '42',
            created: false,
            submittedByUser: false,
        }))

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'checkout',
                consent: VALID_CONSENT,
            }),
        )

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            couponId: '42',
            created: false,
            status: 'worked',
        })
        expect(recordWorkedMock).toHaveBeenCalledWith(
            '42',
            { kind: 'user', userId: 'user-1', established: true },
            expect.anything(),
            { forceStamp: true },
        )
    })

    it('a recordWorked failure is NOT swallowed: the route fails (500) rather than reporting a stamp that never landed', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true
        recordWorkedMock.mockImplementation(async () => {
            throw new Error('signals table unavailable')
        })
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'checkout',
                consent: VALID_CONSENT,
            }),
        )

        expect(res.status).toBe(500)
        errorSpy.mockRestore()
    })

    it('recordWorked finding no catalog row (false) is NOT swallowed either: 500, never a "worked" that did not land', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true
        recordWorkedMock.mockImplementation(async () => false)
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'checkout',
                consent: VALID_CONSENT,
            }),
        )

        expect(res.status).toBe(500)
        errorSpy.mockRestore()
    })
})

describe('POST /api/coupons/submit — checkout consent gate', () => {
    beforeEach(() => signedInAs('user-1'))

    const checkout = { site: 'ebay.com', code: 'SAVE10', source: 'checkout' }

    // The headline case: the server flag is global, so with it ON an extension
    // build that predates the consent prompt (1.4.3-1.4.7, which capture by
    // default and send no consent field) must be refused, and nothing written.
    it('OLD BUILD: flag ON, checkout with NO consent field → 403 consent-required, nothing written or stamped', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        const res = await POST(submitRequest(checkout))

        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'consent-required' })
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })

    it('OLD BUILD from an extension Origin, flag ON → the same 403 consent-required', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        const res = await POST(
            submitRequest(checkout, {
                origin: 'chrome-extension://abcdefghijklmnop',
            }),
        )

        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'consent-required' })
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
    })

    it.each([
        ['declined', { ...VALID_CONSENT, choice: 'declined' }],
        ['an unknown choice', { ...VALID_CONSENT, choice: 'maybe' }],
        [
            'a promptVersion below the server floor',
            {
                ...VALID_CONSENT,
                promptVersion: MIN_CHECKOUT_CONSENT_PROMPT_VERSION - 1,
            },
        ],
        [
            'a non-integer promptVersion',
            { ...VALID_CONSENT, promptVersion: 1.5 },
        ],
        ['a string promptVersion', { ...VALID_CONSENT, promptVersion: '1' }],
        ['a missing choice', { promptVersion: 1, at: VALID_CONSENT.at }],
        ['a missing at', { choice: 'accepted', promptVersion: 1 }],
        ['an unparseable at', { ...VALID_CONSENT, at: 'soon' }],
        ['a numeric at', { ...VALID_CONSENT, at: 1_800_000_000_000 }],
        ['an unknown extra key', { ...VALID_CONSENT, extra: true }],
        ['an empty object', {}],
        ['null', null],
        ['a bare true', true],
        ['the string "accepted"', 'accepted'],
        ['an array', [VALID_CONSENT]],
    ])(
        'flag ON, consent that is %s → 403 consent-required, nothing written',
        async (_label, consent) => {
            envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

            const res = await POST(submitRequest({ ...checkout, consent }))

            expect(res.status).toBe(403)
            expect(await res.json()).toEqual({ error: 'consent-required' })
            expect(submitShopperCouponMock).not.toHaveBeenCalled()
            expect(recordWorkedMock).not.toHaveBeenCalled()
        },
    )

    it('flag ON, valid accepted consent → reaches the write and stamps worked', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        const res = await POST(
            submitRequest({ ...checkout, consent: VALID_CONSENT }),
        )

        expect(res.status).toBe(200)
        expect(submitShopperCouponMock).toHaveBeenCalledTimes(1)
        expect(recordWorkedMock).toHaveBeenCalledTimes(1)
    })

    it('a NEWER promptVersion than the floor is accepted', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        const res = await POST(
            submitRequest({
                ...checkout,
                consent: {
                    ...VALID_CONSENT,
                    promptVersion: MIN_CHECKOUT_CONSENT_PROMPT_VERSION + 1,
                },
            }),
        )

        expect(res.status).toBe(200)
    })

    // Order: the flag check comes first, so an OFF server answers what it always
    // did (and 1.4.9 clients clear their cached flag on it) whether or not the
    // request carries consent.
    it('flag OFF, old build (no consent) → 403 capture-disabled, as before', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = false

        const res = await POST(submitRequest(checkout))

        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'capture-disabled' })
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
    })

    it('flag OFF, valid consent → still 403 capture-disabled (consent never overrides the flag)', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = false

        const res = await POST(
            submitRequest({ ...checkout, consent: VALID_CONSENT }),
        )

        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'capture-disabled' })
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
    })

    it('no session is still 401 before any consent is considered', async () => {
        getSessionMock.mockImplementation(async () => null)
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        const res = await POST(submitRequest(checkout))

        expect(res.status).toBe(401)
        expect(submitShopperCouponMock).not.toHaveBeenCalled()
    })

    it('MANUAL needs no consent: the website form (no consent field) still works, flag ON or OFF', async () => {
        for (const flag of [true, false]) {
            envMock.SHOPPER_CODE_CAPTURE_ENABLED = flag
            submitShopperCouponMock.mockClear()

            const res = await POST(
                submitRequest({
                    site: 'ebay.com',
                    code: 'SAVE10',
                    source: 'manual',
                }),
            )

            expect(res.status).toBe(200)
            expect(submitShopperCouponMock).toHaveBeenCalledTimes(1)
        }
    })

    it('MANUAL ignores a garbage consent field entirely (never 403 consent-required)', async () => {
        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
                consent: { choice: 'declined', junk: 1 },
            }),
        )

        expect(res.status).toBe(200)
        expect(submitShopperCouponMock).toHaveBeenCalledTimes(1)
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })
})

describe('POST /api/coupons/submit — failures', () => {
    beforeEach(() => signedInAs('user-1'))

    it('a valid registrable domain Caramel does not know (UnknownStoreError) → 422 not-a-store, nothing stamped', async () => {
        submitShopperCouponMock.mockImplementation(async () => {
            throw new UnknownStoreError()
        })

        const res = await POST(
            submitRequest({
                site: 'my-spam-site.xyz',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(422)
        expect(await res.json()).toEqual({ error: 'not-a-store' })
        // It DID resolve to a registrable domain; the repo is what refused it.
        expect(submitShopperCouponMock).toHaveBeenCalledWith(
            expect.objectContaining({ base: 'my-spam-site.xyz' }),
        )
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })

    it('an unknown store on a checkout capture also never stamps worked', async () => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true
        submitShopperCouponMock.mockImplementation(async () => {
            throw new UnknownStoreError()
        })

        const res = await POST(
            submitRequest({
                site: 'my-spam-site.xyz',
                code: 'SAVE10',
                source: 'checkout',
                consent: VALID_CONSENT,
            }),
        )

        expect(res.status).toBe(422)
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })

    it('ShopperSubmissionLimitError → 429 daily-limit', async () => {
        submitShopperCouponMock.mockImplementation(async () => {
            throw new ShopperSubmissionLimitError()
        })

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(429)
        expect(await res.json()).toEqual({ error: 'daily-limit' })
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })

    it('any other repo error → 500 through handleRouteError (not swallowed)', async () => {
        submitShopperCouponMock.mockImplementation(async () => {
            throw new Error('connection reset')
        })
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(res.status).toBe(500)
        expect(recordWorkedMock).not.toHaveBeenCalled()
        errorSpy.mockRestore()
    })
})

// Outcome telemetry: ONE `coupon_submit_outcome` event per request, at every
// exit, carrying {outcome, submit_source, status, store?} and nothing that
// identifies the shopper. This is how a zero-rows production result becomes
// "no qualifying event" or "N refusals of kind X" instead of a guess.
describe('POST /api/coupons/submit — outcome telemetry', () => {
    const SECRET_CODE = 'SUPERSECRET-CODE-77'

    function lastEvent(): CapturedEvent {
        expect(captureMock).toHaveBeenCalledTimes(1)
        return captureMock.mock.calls[0]![0]
    }

    function expectOutcome(
        outcome: string,
        source: string,
        status: number,
    ): Record<string, unknown> {
        const event = lastEvent()
        expect(event.event).toBe('coupon_submit_outcome')
        expect(event.properties).toMatchObject({
            outcome,
            submit_source: source,
            status,
        })
        return event.properties ?? {}
    }

    it('created: a new manual code', async () => {
        signedInAs('user-1')

        await POST(
            submitRequest({
                site: 'www.ebay.com',
                code: SECRET_CODE,
                source: 'manual',
            }),
        )

        const props = expectOutcome('created', 'manual', 200)
        expect(props.store).toBe('ebay.com')
    })

    it('already-listed: the dedupe returned created:false (200, no row)', async () => {
        signedInAs('user-1')
        submitShopperCouponMock.mockImplementation(async () => ({
            couponId: '900000000000000001',
            created: false,
            submittedByUser: false,
        }))

        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: SECRET_CODE,
                source: 'checkout',
                consent: VALID_CONSENT,
            }),
        )

        expect(res.status).toBe(200)
        expectOutcome('already-listed', 'checkout', 200)
    })

    it('capture-disabled: checkout with the flag off', async () => {
        signedInAs('user-1')

        await POST(
            submitRequest({
                site: 'ebay.com',
                code: SECRET_CODE,
                source: 'checkout',
                consent: VALID_CONSENT,
            }),
        )

        expectOutcome('capture-disabled', 'checkout', 403)
    })

    it('consent-required: flag on, checkout without consent proof', async () => {
        signedInAs('user-1')
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        await POST(
            submitRequest({
                site: 'ebay.com',
                code: SECRET_CODE,
                source: 'checkout',
            }),
        )

        expectOutcome('consent-required', 'checkout', 403)
    })

    it('unauthenticated: no session is recorded with source unknown (body never read)', async () => {
        await POST(
            submitRequest({
                site: 'ebay.com',
                code: SECRET_CODE,
                source: 'manual',
            }),
        )

        expectOutcome('unauthenticated', 'unknown', 401)
    })

    it('origin-not-allowed: withRoute origin gate, handler never ran', async () => {
        signedInAs('user-1')

        await POST(
            submitRequest(
                { site: 'ebay.com', code: SECRET_CODE, source: 'manual' },
                { origin: 'https://evil.example', host: 'localhost' },
            ),
        )

        expectOutcome('origin-not-allowed', 'unknown', 403)
    })

    it('bad-origin: checkout from a non-extension Origin (flag on)', async () => {
        signedInAs('user-1')
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true

        await POST(
            submitRequest(
                {
                    site: 'ebay.com',
                    code: SECRET_CODE,
                    source: 'checkout',
                    consent: VALID_CONSENT,
                },
                { origin: 'http://localhost', host: 'localhost' },
            ),
        )

        expectOutcome('bad-origin', 'checkout', 403)
    })

    it('rate-limited and invalid-body: withRoute refusals are recorded too', async () => {
        signedInAs('user-1')
        checkRateLimitMock.mockImplementation(async () =>
            Response.json({ error: 'Too many requests' }, { status: 429 }),
        )
        await POST(
            submitRequest({
                site: 'ebay.com',
                code: SECRET_CODE,
                source: 'manual',
            }),
        )
        expectOutcome('rate-limited', 'unknown', 429)

        captureMock.mockClear()
        checkRateLimitMock.mockImplementation(async () => null)
        await POST(submitRequest({ site: 'ebay.com', source: 'bogus' }))
        expectOutcome('invalid-body', 'unknown', 422)
    })

    it('invalid-code, not-a-store (both flavours) and daily-limit', async () => {
        signedInAs('user-1')

        await POST(
            submitRequest({ site: 'ebay.com', code: '   ', source: 'manual' }),
        )
        expectOutcome('invalid-code', 'manual', 422)

        captureMock.mockClear()
        await POST(
            submitRequest({
                site: 'not a domain',
                code: SECRET_CODE,
                source: 'manual',
            }),
        )
        expectOutcome('not-a-store', 'manual', 422)

        captureMock.mockClear()
        submitShopperCouponMock.mockImplementation(async () => {
            throw new UnknownStoreError()
        })
        await POST(
            submitRequest({
                site: 'unknown-store.com',
                code: SECRET_CODE,
                source: 'manual',
            }),
        )
        const props = expectOutcome('not-a-store', 'manual', 422)
        expect(props.store).toBe('unknown-store.com')

        captureMock.mockClear()
        submitShopperCouponMock.mockImplementation(async () => {
            throw new ShopperSubmissionLimitError()
        })
        await POST(
            submitRequest({
                site: 'ebay.com',
                code: SECRET_CODE,
                source: 'manual',
            }),
        )
        expectOutcome('daily-limit', 'manual', 429)
    })

    it('server-error: an unexpected repo error is recorded and still a 500', async () => {
        signedInAs('user-1')
        submitShopperCouponMock.mockImplementation(async () => {
            throw new Error('connection reset')
        })
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: SECRET_CODE,
                source: 'manual',
            }),
        )

        expect(res.status).toBe(500)
        expectOutcome('server-error', 'manual', 500)
        errorSpy.mockRestore()
    })

    it('never carries the code, the user id or the client IP', async () => {
        signedInAs('user-private-id-42')
        const res = await POST(
            submitRequest(
                { site: 'ebay.com', code: SECRET_CODE, source: 'manual' },
                { 'x-forwarded-for': '203.0.113.9' },
            ),
        )

        expect(res.status).toBe(200)
        const serialized = JSON.stringify(lastEvent())
        expect(serialized).not.toContain(SECRET_CODE)
        expect(serialized).not.toContain('user-private-id-42')
        expect(serialized).not.toContain('203.0.113.9')
        expect(lastEvent().properties).toMatchObject({
            $process_person_profile: false,
        })
    })

    it('telemetry failure never reaches the shopper: same response, and the failure is logged with context', async () => {
        signedInAs('user-1')
        captureMock.mockImplementation(async () => {
            throw new Error('posthog unreachable')
        })
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const res = await POST(
            submitRequest({
                site: 'ebay.com',
                code: SECRET_CODE,
                source: 'manual',
            }),
        )
        await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled())

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ created: true })
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('[coupon-submit-outcome]'),
            expect.any(Error),
            { outcome: 'created', source: 'manual' },
        )
        errorSpy.mockRestore()
    })

    it('an unsent event (capture disabled / failed) is warned about with the outcome, not silent', async () => {
        signedInAs('user-1')
        captureMock.mockImplementation(async () => false)
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        await POST(
            submitRequest({
                site: 'ebay.com',
                code: SECRET_CODE,
                source: 'manual',
            }),
        )
        await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('[coupon-submit-outcome]'),
            { outcome: 'created', source: 'manual' },
        )
        warnSpy.mockRestore()
    })
})

// T-6222: a checkout "worked" stamp is client-asserted (Origin and the consent
// proof are forgeable), so it is policy-gated (checkoutWorkedStamp.ts). The
// policy runs for real here; recordWorked and the repo are the test doubles.
describe('POST /api/coupons/submit — checkout worked-stamp policy (T-6222)', () => {
    const YOUNG_ACCOUNT = new Date(Date.now() - 60 * 60 * 1000)
    const checkout = {
        site: 'ebay.com',
        code: 'SAVE10',
        source: 'checkout' as const,
        consent: VALID_CONSENT,
    }
    const SUPPLIER_ROW = {
        couponId: '42',
        created: false,
        submittedByUser: false,
    }

    beforeEach(() => {
        envMock.SHOPPER_CODE_CAPTURE_ENABLED = true
    })

    function lockCallCount(): number {
        // The fake client's $executeRaw is the advisory-lock statement.
        return executeRawMock.mock.calls.length
    }

    function eventOutcome(): unknown {
        return captureMock.mock.calls[0]![0].properties?.outcome
    }

    it('a NEW row may be stamped by a young account (the shopper listed it themselves)', async () => {
        signedInAs('user-1', YOUNG_ACCOUNT)

        const res = await POST(submitRequest(checkout))

        expect(await res.json()).toMatchObject({
            created: true,
            status: 'worked',
        })
        expect(recordWorkedMock).toHaveBeenCalledTimes(1)
        expect(recordWorkedMock).toHaveBeenCalledWith(
            '900000000000000001',
            { kind: 'user', userId: 'user-1', established: false },
            expect.anything(),
            { forceStamp: true },
        )
        expect(eventOutcome()).toBe('created')
    })

    it('an already-listed SUPPLIER code is NOT stamped by a young account: 200, status unverified, nothing recorded', async () => {
        signedInAs('user-1', YOUNG_ACCOUNT)
        submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)

        const res = await POST(submitRequest(checkout))

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            couponId: '42',
            created: false,
            status: 'unverified',
        })
        expect(recordWorkedMock).not.toHaveBeenCalled()
        expect(reportRows).toHaveLength(0)
        expect(eventOutcome()).toBe('worked-stamp-gated')
    })

    it('an already-listed code with NO Origin and NO reputation cannot be stamped either (the forged-request case)', async () => {
        // Exactly the T-6222 attack: any account POSTs an existing public code
        // with source "checkout", a valid-shaped consent and no Origin.
        signedInAs('attacker', YOUNG_ACCOUNT)
        submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)

        const res = await POST(submitRequest(checkout))

        expect((await res.json()).status).toBe('unverified')
        expect(recordWorkedMock).not.toHaveBeenCalled()
    })

    it('an ESTABLISHED account may stamp an already-listed code, and the stamp is attributed', async () => {
        signedInAs('user-1')
        submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)

        const res = await POST(submitRequest(checkout))

        expect(await res.json()).toMatchObject({ status: 'worked' })
        expect(recordWorkedMock).toHaveBeenCalledTimes(1)
        expect(reportRows).toHaveLength(1)
        expect(reportRows[0]).toMatchObject({
            couponId: '42',
            userId: 'user-1',
            outcome: 'worked',
        })
    })

    it('a young account may re-stamp ITS OWN earlier submission (created:false, submittedByUser:true)', async () => {
        signedInAs('user-1', YOUNG_ACCOUNT)
        submitShopperCouponMock.mockImplementation(async () => ({
            couponId: '900000000000000009',
            created: false,
            submittedByUser: true,
        }))

        const res = await POST(submitRequest(checkout))

        expect((await res.json()).status).toBe('worked')
        expect(recordWorkedMock).toHaveBeenCalledTimes(1)
    })

    it('DEDUPE: the same account stamping the same coupon twice stamps once; the repeat still answers worked', async () => {
        signedInAs('user-1')
        submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)

        const first = await POST(submitRequest(checkout))
        const second = await POST(submitRequest(checkout))

        expect((await first.json()).status).toBe('worked')
        expect((await second.json()).status).toBe('worked')
        expect(recordWorkedMock).toHaveBeenCalledTimes(1)
        expect(reportRows).toHaveLength(1)
    })

    it('a different account stamping the same coupon is its own stamp', async () => {
        submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)
        signedInAs('user-1')
        await POST(submitRequest(checkout))
        signedInAs('user-2')
        await POST(submitRequest(checkout))

        expect(recordWorkedMock).toHaveBeenCalledTimes(2)
    })

    it('DAILY CAP: an account at COUPON_WORKED_STAMPS_PER_USER_PER_DAY stamps nothing more, existing codes included, and a Sentry warning says so', async () => {
        signedInAs('user-1')
        submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)
        const cap = envMock.COUPON_WORKED_STAMPS_PER_USER_PER_DAY as number
        for (let n = 0; n < cap; n++) {
            reportRows.push({
                couponId: `${1000 + n}`,
                userId: 'user-1',
                outcome: 'worked',
                createdAt: new Date(Date.now() - 60_000),
            })
        }

        const res = await POST(submitRequest(checkout))

        expect(await res.json()).toMatchObject({ status: 'unverified' })
        expect(recordWorkedMock).not.toHaveBeenCalled()
        expect(reportRows).toHaveLength(cap)
        expect(eventOutcome()).toBe('worked-stamp-capped')
        expect(sentryMessageMock).toHaveBeenCalledTimes(1)
        expect(sentryMessageMock.mock.calls[0]![1]).toMatchObject({
            level: 'warning',
            tags: { budget: 'worked-stamp-daily' },
        })
        // The dedupe slot went back: once the day's stamps age out, the same
        // account can stamp this coupon.
        reportRows.length = 0
        const retry = await POST(submitRequest(checkout))
        expect((await retry.json()).status).toBe('worked')
    })

    it('DAILY CAP: stamps older than 24h do not count', async () => {
        signedInAs('user-1')
        submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)
        const cap = envMock.COUPON_WORKED_STAMPS_PER_USER_PER_DAY as number
        for (let n = 0; n < cap; n++) {
            reportRows.push({
                couponId: `${1000 + n}`,
                userId: 'user-1',
                outcome: 'worked',
                createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
            })
        }

        const res = await POST(submitRequest(checkout))

        expect((await res.json()).status).toBe('worked')
    })

    it('DAILY CAP: the count is per account, and failed outcomes do not count', async () => {
        signedInAs('user-1')
        submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)
        const cap = envMock.COUPON_WORKED_STAMPS_PER_USER_PER_DAY as number
        for (let n = 0; n < cap; n++) {
            reportRows.push({
                couponId: `${1000 + n}`,
                userId: 'someone-else',
                outcome: 'worked',
                createdAt: new Date(),
            })
            reportRows.push({
                couponId: `${2000 + n}`,
                userId: 'user-1',
                outcome: 'failed',
                createdAt: new Date(),
            })
        }

        const res = await POST(submitRequest(checkout))

        expect((await res.json()).status).toBe('worked')
    })

    it('VELOCITY: once the coupon has its hourly cap of counted worked reports, a further stamp is refused (capped)', async () => {
        signedInAs('user-1')
        submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)
        const max = envMock.COUPON_REPORT_MAX_PER_COUPON_PER_HOUR as number
        for (let n = 0; n < max; n++) {
            admitCouponReportVelocity('worked', '42', 'established')
        }

        const res = await POST(submitRequest(checkout))

        expect(await res.json()).toMatchObject({ status: 'unverified' })
        expect(recordWorkedMock).not.toHaveBeenCalled()
        expect(eventOutcome()).toBe('worked-stamp-capped')
    })

    it('a stamp that FAILS frees its dedupe and velocity slots: the retry stamps (500 first, no attribution row left)', async () => {
        signedInAs('user-1')
        submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)
        recordWorkedMock.mockImplementationOnce(async () => {
            throw new Error('signals table unavailable')
        })
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const failed = await POST(submitRequest(checkout))
        expect(failed.status).toBe(500)
        expect(reportRows).toHaveLength(0)

        const retry = await POST(submitRequest(checkout))
        expect((await retry.json()).status).toBe('worked')
        expect(recordWorkedMock).toHaveBeenCalledTimes(2)
        errorSpy.mockRestore()
    })

    it('the PERSISTED coupon_reports row is the truth: after a restart (dedupe memory empty) a repeat inside 24h is not re-stamped and writes no second row', async () => {
        signedInAs('user-1')
        submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)

        await POST(submitRequest(checkout))
        resetReportDedupeForTests()
        resetReportVelocityForTests()
        const again = await POST(submitRequest(checkout))

        expect((await again.json()).status).toBe('worked')
        expect(recordWorkedMock).toHaveBeenCalledTimes(1)
        expect(reportRows).toHaveLength(1)
    })

    it('the stamp transaction takes the per-shopper advisory lock first (the daily count cannot race)', async () => {
        signedInAs('user-1')
        submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)

        await POST(submitRequest(checkout))

        expect(lockCallCount()).toBe(1)
    })

    it('a stamp that is refused before the transaction (gated) takes no lock and opens none', async () => {
        signedInAs('user-1', YOUNG_ACCOUNT)
        submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)

        await POST(submitRequest(checkout))

        expect(lockCallCount()).toBe(0)
    })

    // N3: POST /api/coupons/<id>/report also writes a 'worked' attribution row
    // for a LOW-TRUST account whose report moved nothing. That row must not make a
    // later checkout capture look already stamped.
    describe('the persisted dedupe only counts a stamp that really happened (N3)', () => {
        const priorRow = (ageMs: number) =>
            reportRows.push({
                couponId: '42',
                userId: 'user-1',
                outcome: 'worked',
                createdAt: new Date(Date.now() - ageMs),
            })

        it('an UNSTAMPED attribution row (no last_worked_at) does not dedupe: the capture stamps, reuses that row, and answers worked', async () => {
            signedInAs('user-1')
            submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)
            priorRow(60 * 60 * 1000)

            const res = await POST(submitRequest(checkout))

            expect(await res.json()).toMatchObject({ status: 'worked' })
            expect(recordWorkedMock).toHaveBeenCalledTimes(1)
            expect(stampedAt.has('42')).toBe(true)
            // Reused, not doubled: the daily count sees one row for this coupon.
            expect(reportRows).toHaveLength(1)
        })

        it("a stamp that PREDATES the row by more than the clock tolerance is somebody else's: still not a dedupe", async () => {
            signedInAs('user-1')
            submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)
            priorRow(60 * 60 * 1000)
            stampedAt.set('42', new Date(Date.now() - 3 * 60 * 60 * 1000))

            await POST(submitRequest(checkout))

            expect(recordWorkedMock).toHaveBeenCalledTimes(1)
        })

        it('a row whose stamp is at or after it (or inside the clock tolerance before it) IS a dedupe: no second stamp, status worked', async () => {
            signedInAs('user-1')
            submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)
            priorRow(60 * 60 * 1000)
            // The app writes the row a moment after the database stamps.
            stampedAt.set('42', new Date(Date.now() - 60 * 60 * 1000 - 20_000))

            const res = await POST(submitRequest(checkout))

            expect(await res.json()).toMatchObject({ status: 'worked' })
            expect(recordWorkedMock).not.toHaveBeenCalled()
            expect(reportRows).toHaveLength(1)
        })

        it('a row older than 24h never dedupes, stamped or not', async () => {
            signedInAs('user-1')
            submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)
            priorRow(25 * 60 * 60 * 1000)
            stampedAt.set('42', new Date(Date.now() - 25 * 60 * 60 * 1000))

            await POST(submitRequest(checkout))

            expect(recordWorkedMock).toHaveBeenCalledTimes(1)
            expect(reportRows).toHaveLength(2)
        })

        it('the in-memory "worked" slot the report route takes for an unstamped report does NOT dedupe the capture', async () => {
            signedInAs('user-1')
            submitShopperCouponMock.mockImplementation(async () => SUPPLIER_ROW)
            admitReport(
                'worked',
                { kind: 'user', userId: 'user-1', established: false },
                '42',
            )

            const res = await POST(submitRequest(checkout))

            expect(await res.json()).toMatchObject({ status: 'worked' })
            expect(recordWorkedMock).toHaveBeenCalledTimes(1)
        })
    })

    it('a MANUAL add never reaches the stamp policy', async () => {
        signedInAs('user-1')

        await POST(
            submitRequest({
                site: 'ebay.com',
                code: 'SAVE10',
                source: 'manual',
            }),
        )

        expect(recordWorkedMock).not.toHaveBeenCalled()
        expect(reportRows).toHaveLength(0)
    })
})
