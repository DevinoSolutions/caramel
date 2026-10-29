import { GET as couponsGET } from '@/app/api/coupons/route'
import { GET as storesGET } from '@/app/api/coupons/stores/route'
import { POST as searchSupportedPOST } from '@/app/api/sites/search-supported/route'
import { withoutSearchText } from '@/lib/api/withoutSearchText'
import * as Sentry from '@sentry/nextjs'
import { NextRequest } from 'next/server'
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type MockInstance,
} from 'vitest'

// T-7505: a search route that fails must not put the shopper's typed text in a
// log line or a Sentry event, even when the database error echoes it. The
// repo layer is ANNOUNCED-FAKED (it throws an error that quotes the typed
// value, the worst case); the routes are real.

const TYPED = 'my-private-typed-text'

const repo = vi.hoisted(() => ({
    listCoupons: vi.fn(),
    listStoreOptions: vi.fn(),
    searchSupportedSites: vi.fn(),
}))
vi.mock('@/lib/couponsRepo', () => repo)
vi.mock('@/lib/couponSignals', () => ({ attachSignals: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ default: {} }))
vi.mock('@/lib/rateLimit', () => ({
    checkRateLimit: async () => null,
    isTrustedServer: () => false,
    isOriginAllowed: () => true,
    isExtensionOrigin: () => false,
    forbiddenOrigin: () => new Response('forbidden', { status: 403 }),
}))
vi.mock('@sentry/nextjs', () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setUser: vi.fn(),
}))

const leakyError = () =>
    Object.assign(
        new Error(
            `Raw query failed. Message: invalid input near "${TYPED}" (pattern %${encodeURIComponent(TYPED)}%)`,
        ),
        { code: 'P2010' },
    )

let errorLog: MockInstance<typeof console.error>

beforeEach(() => {
    vi.clearAllMocks()
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = leakyError()
    repo.listCoupons.mockRejectedValue(err)
    repo.listStoreOptions.mockRejectedValue(err)
    repo.searchSupportedSites.mockRejectedValue(err)
})
afterEach(() => errorLog.mockRestore())

function nothingTypedLeaked() {
    const sentry = JSON.stringify(
        vi.mocked(Sentry.captureException).mock.calls.map(([e, hint]) => ({
            message: (e as Error).message,
            stack: (e as Error).stack,
            hint,
        })),
    )
    const logged = JSON.stringify(
        errorLog.mock.calls.map(args =>
            args.map(a =>
                a instanceof Error ? { m: a.message, s: a.stack } : a,
            ),
        ),
    )
    for (const text of [sentry, logged]) {
        expect(text).not.toContain(TYPED)
        expect(text).not.toContain(encodeURIComponent(TYPED))
    }
    // The failure is still reported and still identifiable.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1)
    expect(sentry).toContain('Raw query failed')
}

describe('search routes: a failure never carries the typed text', () => {
    it('GET /api/coupons?search=&key_words=', async () => {
        const res = await couponsGET(
            new NextRequest(
                `http://localhost/api/coupons?search=${encodeURIComponent(TYPED)}&key_words=${encodeURIComponent(TYPED)}`,
            ),
        )
        expect(res.status).toBe(500)
        nothingTypedLeaked()
    })

    it('GET /api/coupons/stores?q=', async () => {
        const res = await storesGET(
            new NextRequest(
                `http://localhost/api/coupons/stores?q=${encodeURIComponent(TYPED)}`,
            ),
        )
        expect(res.status).toBe(500)
        nothingTypedLeaked()
    })

    it('POST /api/sites/search-supported { query }', async () => {
        const res = await searchSupportedPOST(
            new NextRequest('http://localhost/api/sites/search-supported', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: TYPED }),
            }),
        )
        expect(res.status).toBe(500)
        nothingTypedLeaked()
    })
})

describe('withoutSearchText', () => {
    it('keeps name and code, replaces raw and encoded values, leaves the original alone', () => {
        const original = leakyError()
        original.name = 'PrismaClientKnownRequestError'

        const safe = withoutSearchText(original, [TYPED])

        expect(safe).not.toBe(original)
        expect(safe.name).toBe('PrismaClientKnownRequestError')
        expect((safe as Error & { code?: string }).code).toBe('P2010')
        expect(safe.message).not.toContain(TYPED)
        expect(safe.message).toContain('Raw query failed')
        expect(safe.message).toContain('[Filtered search text]')
        expect(original.message).toContain(TYPED)
    })

    it('drops the text of a non-Error throw and ignores empty or one-character values', () => {
        expect(
            withoutSearchText(`boom ${TYPED}`, [TYPED]).message,
        ).not.toContain(TYPED)
        const safe = withoutSearchText(new Error('plain failure'), [
            undefined,
            '',
            'a',
        ])
        expect(safe.message).toBe('plain failure')
    })
})
