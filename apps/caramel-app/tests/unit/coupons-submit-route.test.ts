import { POST } from '@/app/api/coupons/submit/route'
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
// store itself accepted the code, stamps "worked").
const {
    envMock,
    getSessionMock,
    submitShopperCouponMock,
    recordWorkedMock,
    checkRateLimitMock,
} = vi.hoisted(() => ({
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
        }) => ({ couponId: '900000000000000001', created: true }),
    ),
    recordWorkedMock: vi.fn(async (_couponId: string) => {}),
    checkRateLimitMock: vi.fn(async () => null as unknown),
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

function signedInAs(userId: string) {
    getSessionMock.mockImplementation(async () => ({
        session: { id: `session-${userId}` },
        user: { id: userId },
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
    }))
    recordWorkedMock.mockReset()
    recordWorkedMock.mockImplementation(async () => {})
    checkRateLimitMock.mockReset()
    checkRateLimitMock.mockImplementation(async () => null)
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
        expect(recordWorkedMock).toHaveBeenCalledWith('900000000000000001')
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
        expect(recordWorkedMock).toHaveBeenCalledWith('42')
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
