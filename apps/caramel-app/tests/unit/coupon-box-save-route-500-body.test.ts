import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The save route answers untrusted callers, so a 500 body must not carry the internal
// error text (driver, host:port, SQL fragment). The route answers a fixed
// message; the real error goes to Sentry through handleRouteError.

// MOCK (announced): the same seams the route's own unit test mocks (the
// session, the proposals table, the catalog reads and the config write).
const { envMock, knownMock, servedMock, insertMock, findProposalMock } =
    vi.hoisted(() => ({
        envMock: {} as Record<string, unknown>,
        findProposalMock: vi.fn(
            async (_args: unknown): Promise<unknown> => null,
        ),
        knownMock: vi.fn(async (): Promise<string[]> => ['shop-example.com']),
        servedMock: vi.fn(async () => false),
        insertMock: vi.fn(async (): Promise<{ inserted: boolean }> => ({
            inserted: true,
        })),
    }))
vi.mock('@/lib/prisma', () => ({
    default: { couponBoxProposal: { findUnique: findProposalMock } },
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: {
        api: {
            getSession: vi.fn(async () => ({
                user: { id: 'user-1' },
                session: { id: 's' },
            })),
        },
    },
}))
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env)
    return { ...actual, env: envMock }
})
vi.mock('@/lib/couponsRepo', () => ({
    findCatalogStoreNames: knownMock,
    hasServedStoreConfig: servedMock,
}))
vi.mock('@/lib/catalog/applyCatalogRows', () => ({
    AUTO_DETECT_CONFIG_MAX_AGE_DAYS: 30,
    insertAutoDetectedStoreConfig: insertMock,
}))
vi.mock('@/lib/supportedStoresCache', () => ({
    resetSupportedStoresCache: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    setUser: vi.fn(),
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

import { POST } from '@/app/api/extension/coupon-box-save/route'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const INTERNAL =
    'connect ECONNREFUSED 10.0.0.5:5432 — Invalid `prisma.$queryRaw()` invocation: INSERT INTO store_configs'

function post(body: unknown) {
    return POST(
        new NextRequest('http://localhost/api/extension/coupon-box-save', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: EXT_ORIGIN },
            body: JSON.stringify(body),
        }),
    )
}

beforeEach(() => {
    envMock.COUPON_BOX_SAVE_ENABLED = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('coupon-box-save 500 body', () => {
    it('a database failure answers 500 without the internal error text', async () => {
        findProposalMock.mockImplementation(async () => {
            throw new Error(INTERNAL)
        })
        const res = await post({
            host: 'www.shop-example.com',
            box: { input: '#promo', apply: null, toggle: null, total: '.t' },
        })
        expect(res.status).toBe(500)
        const body = (await res.json()) as { error: string }
        expect(body.error).not.toContain('10.0.0.5')
        expect(body.error).not.toContain('prisma')
        expect(body.error).not.toContain('store_configs')
    })
})
