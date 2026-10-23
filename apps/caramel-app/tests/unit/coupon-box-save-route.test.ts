import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/extension/coupon-box-save: every rule, in the contract's order,
// and every answer. The writes and the catalog reads run on real Postgres in
// tests/integration/coupon-box-save.itest.ts.
//
// T-6221: the route needs a signed-in session (a forged Origin alone is 401),
// a save is a proposal that is served only when distinct users agree, the
// write budget answers 429, and the apply/toggle selector may not be a
// form-submit control.

// MOCK (announced): the database calls the route makes, the session lookup
// and the supported-stores cache. What they are asked, and whether they are
// asked at all, is what these tests measure. The proposals table is an
// in-memory FAKE (`proposals`) that answers the three queries
// couponBoxSave.recordBoxProposal makes (findUnique, count, createMany) the
// way Postgres would, so the quorum and the budgets are measured through the
// real logic, not asserted on a canned count.
type ProposalRow = {
    storeName: string
    boxHash: string
    userId: string
    createdAt: Date
}
type ProposalWhere = Partial<Omit<ProposalRow, 'createdAt'>> & {
    createdAt?: { gt: Date }
}
const {
    envMock,
    knownMock,
    servedMock,
    insertMock,
    resetCacheMock,
    getSessionMock,
    sentry,
    proposals,
} = vi.hoisted(() => ({
    envMock: {} as Record<string, unknown>,
    knownMock: vi.fn(
        async (
            _names: readonly string[],
            _shopLabel: string | null,
        ): Promise<string[]> => ['shop-example.com'],
    ),
    servedMock: vi.fn(async (_host: string) => false),
    insertMock: vi.fn(
        async (_config: unknown): Promise<{ inserted: boolean }> => ({
            inserted: true,
        }),
    ),
    resetCacheMock: vi.fn(),
    getSessionMock: vi.fn(
        async (_opts: { headers: Headers }): Promise<unknown> => null,
    ),
    sentry: {
        addBreadcrumb: vi.fn(),
        captureException: vi.fn(),
        captureMessage: vi.fn(),
    },
    proposals: [] as Array<
        {
            host: string
            input: string
            apply: string | null
            toggle: string | null
            total: string
        } & {
            storeName: string
            boxHash: string
            userId: string
            createdAt: Date
        }
    >,
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
    resetSupportedStoresCache: resetCacheMock,
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))
vi.mock('@/lib/prisma', () => {
    const matches = (row: ProposalRow, where: ProposalWhere) =>
        (where.storeName === undefined || row.storeName === where.storeName) &&
        (where.boxHash === undefined || row.boxHash === where.boxHash) &&
        (where.userId === undefined || row.userId === where.userId) &&
        (where.createdAt === undefined || row.createdAt > where.createdAt.gt)
    return {
        default: {
            couponBoxProposal: {
                findUnique: async (args: {
                    where: {
                        storeName_boxHash_userId: Pick<
                            ProposalRow,
                            'storeName' | 'boxHash' | 'userId'
                        >
                    }
                }) =>
                    proposals.find(r =>
                        matches(r, args.where.storeName_boxHash_userId),
                    ) ?? null,
                update: async (args: {
                    where: {
                        storeName_boxHash_userId: Pick<
                            ProposalRow,
                            'storeName' | 'boxHash' | 'userId'
                        >
                    }
                    data: { createdAt: Date }
                }) => {
                    const row = proposals.find(r =>
                        matches(r, args.where.storeName_boxHash_userId),
                    )
                    if (!row) throw new Error('no proposal to renew')
                    row.createdAt = args.data.createdAt
                    return row
                },
                count: async (args: { where: ProposalWhere }) =>
                    proposals.filter(r => matches(r, args.where)).length,
                createMany: async (args: {
                    data: Array<Omit<(typeof proposals)[number], 'createdAt'>>
                    skipDuplicates: boolean
                }) => {
                    for (const d of args.data) {
                        const dup = proposals.some(
                            r =>
                                r.storeName === d.storeName &&
                                r.boxHash === d.boxHash &&
                                r.userId === d.userId,
                        )
                        if (!dup)
                            proposals.push({ ...d, createdAt: new Date() })
                    }
                },
            },
        },
    }
})
vi.mock('@sentry/nextjs', () => ({
    ...sentry,
    setUser: vi.fn(),
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

import { OPTIONS, POST } from '@/app/api/extension/coupon-box-save/route'
import { checkRateLimit } from '@/lib/rateLimit'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const QUORUM = 3

const goodBody = (
    box: Record<string, unknown> = {},
    host = 'www.shop-example.com',
) => ({
    host,
    box: {
        input: '#promo',
        apply: 'button[name="apply"]',
        toggle: null,
        total: '.order-total',
        ...box,
    },
})

/** The test names the signed-in user in `x-test-user`; absent = no session. */
getSessionMock.mockImplementation(async opts => {
    const id = opts.headers.get('x-test-user')
    return id ? { user: { id }, session: { id: 'session' } } : null
})

function post(
    body: unknown,
    {
        origin = EXT_ORIGIN,
        user = 'user-1',
    }: { origin?: string | null; user?: string | null } = {},
) {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
    }
    if (origin) headers.origin = origin
    if (user) headers['x-test-user'] = user
    return POST(
        new NextRequest('http://localhost/api/extension/coupon-box-save', {
            method: 'POST',
            headers,
            body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
    )
}

/** QUORUM distinct users post the same box; returns the last answer. */
async function postFromQuorum(body: unknown) {
    let last: Response | null = null
    for (let i = 1; i <= QUORUM; i++) {
        last = await post(body, { user: `quorum-user-${i}` })
    }
    if (!last) throw new Error('QUORUM is 0')
    return last
}

beforeEach(() => {
    envMock.COUPON_BOX_SAVE_ENABLED = true
    envMock.COUPON_BOX_SAVE_MIN_AGREEING_INSTALLS = QUORUM
    envMock.COUPON_BOX_SAVE_USER_DAILY_CAP = 10
    envMock.COUPON_BOX_SAVE_STORE_DAILY_CAP = 20
    envMock.COUPON_BOX_SAVE_GLOBAL_DAILY_CAP = 500
    proposals.length = 0
    knownMock.mockReset()
    knownMock.mockImplementation(async () => ['shop-example.com'])
    servedMock.mockReset()
    servedMock.mockImplementation(async () => false)
    insertMock.mockReset()
    insertMock.mockImplementation(async () => ({ inserted: true }))
    resetCacheMock.mockReset()
    sentry.addBreadcrumb.mockReset()
    sentry.captureMessage.mockReset()
})

describe('POST /api/extension/coupon-box-save', () => {
    it('the quorum-th distinct user publishes the box under the catalog store, mapped to the store_configs columns, and leaves the supported-stores cache alone', async () => {
        const res = await postFromQuorum(goodBody())

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            saved: true,
            store: 'shop-example.com',
            status: 'published',
        })
        expect(insertMock).toHaveBeenCalledTimes(1)
        expect(insertMock).toHaveBeenCalledWith({
            storeName: 'shop-example.com',
            couponInputXpath: '#promo',
            applyButtonXpath: 'button[name="apply"]',
            showInputXpath: null,
            priceContainerXpath: '.order-total',
        })
        expect(servedMock).toHaveBeenCalledWith('www.shop-example.com')
        expect(resetCacheMock).not.toHaveBeenCalled()
        expect(res.headers.get('cache-control')).toBe('private, no-store')
    })

    it('an Enter-only box (apply null) stores its input as the apply selector; the toggle is show_input', async () => {
        await postFromQuorum(
            goodBody({ apply: null, toggle: 'button.reveal-promo' }),
        )

        expect(insertMock).toHaveBeenCalledWith({
            storeName: 'shop-example.com',
            couponInputXpath: '#promo',
            applyButtonXpath: '#promo',
            showInputXpath: 'button.reveal-promo',
            priceContainerXpath: '.order-total',
        })
    })

    it('QUARANTINE: below the quorum the box is recorded as pending and never written to store_configs', async () => {
        for (let i = 1; i < QUORUM; i++) {
            const res = await post(goodBody(), { user: `u${i}` })
            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({
                saved: true,
                store: 'shop-example.com',
                status: 'pending',
            })
        }

        expect(proposals).toHaveLength(QUORUM - 1)
        expect(insertMock).not.toHaveBeenCalled()
    })

    it('QUARANTINE: one user repeating the save is one proposal and never reaches the quorum', async () => {
        for (let i = 0; i < QUORUM + 2; i++) await post(goodBody())

        expect(proposals).toHaveLength(1)
        expect(insertMock).not.toHaveBeenCalled()
    })

    it('QUARANTINE: different boxes do not add up; each needs its own quorum', async () => {
        await post(goodBody({ input: '#a' }), { user: 'u1' })
        await post(goodBody({ input: '#b' }), { user: 'u2' })
        await post(goodBody({ input: '#c' }), { user: 'u3' })

        expect(insertMock).not.toHaveBeenCalled()
    })

    it('QUARANTINE: a squatter pending box does not block the box real installs agree on', async () => {
        await post(goodBody({ input: '#squat' }), { user: 'squatter' })

        const res = await postFromQuorum(goodBody())

        expect(await res.json()).toMatchObject({ status: 'published' })
        expect(insertMock).toHaveBeenCalledTimes(1)
        expect(insertMock).toHaveBeenCalledWith(
            expect.objectContaining({ couponInputXpath: '#promo' }),
        )
    })

    it('1. flag off: 404 disabled, the body is never read and nothing is asked', async () => {
        envMock.COUPON_BOX_SAVE_ENABLED = false

        const res = await post('not even json')

        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ saved: false, reason: 'disabled' })
        expect(knownMock).not.toHaveBeenCalled()
        expect(servedMock).not.toHaveBeenCalled()
        expect(insertMock).not.toHaveBeenCalled()
        expect(proposals).toHaveLength(0)
    })

    it.each([
        ['not JSON', '{nope'],
        ['no box', { host: 'www.shop-example.com' }],
        ['no input', goodBody({ input: undefined })],
        ['an empty input', goodBody({ input: '' })],
        ['a selector list', goodBody({ input: '#a, #b' })],
        ['a :has() selector', goodBody({ input: 'form:has(input)' })],
        ['an XPath', goodBody({ input: '//input[@id="promo"]' })],
        ['an email in a selector', goodBody({ total: '[data-user="a@b.co"]' })],
        ['no order total', goodBody({ total: null })],
        [
            'a long number in a value',
            goodBody({ apply: '[data-phone="5551234567"]' }),
        ],
        [
            'an apply that places the order',
            goodBody({ apply: 'button#place-order' }),
        ],
        ['a toggle that pays', goodBody({ toggle: 'button.pay-now' })],
        // T-6221: form-submit controls the old word-only check let through.
        [
            'an apply button[type=submit]',
            goodBody({ apply: 'button[type=submit]' }),
        ],
        [
            'an apply button[type="submit"] under a cart footer',
            goodBody({ apply: '.cart__footer button[type="submit"]' }),
        ],
        [
            'an apply input[type=submit]',
            goodBody({ apply: 'input[type=submit]' }),
        ],
        [
            'an apply input[type=image]',
            goodBody({ apply: 'input[type=image]' }),
        ],
        [
            'a toggle button[type=submit]',
            goodBody({ toggle: 'button[type=submit]' }),
        ],
        [
            'an apply with a [form] attribute',
            goodBody({ apply: 'button[form]' }),
        ],
        [
            'an apply with a [formaction] attribute',
            goodBody({ apply: 'button[formaction="/pay"]' }),
        ],
        [
            'a bare button under a cart footer',
            goodBody({ apply: '.cart__footer button' }),
        ],
        [
            'a place-order spelled in pieces',
            goodBody({ apply: 'button[id^=check][id$=out]' }),
        ],
        // T-6221 review: generic selectors name no risky word but click
        // the first such control on a checkout.
        ['an apply that is just button.btn', goodBody({ apply: 'button.btn' })],
        [
            'an apply that is [name=commit]',
            goodBody({ apply: '[name=commit]' }),
        ],
        [
            'an apply with a payment aria-label',
            goodBody({ apply: '.btn[aria-label="Continue to payment"]' }),
        ],
        ['a toggle that is a.btn', goodBody({ toggle: 'a.btn' })],
        ['a code in the body', { ...goodBody(), code: 'SAVE10' }],
        ['an amount in the box', goodBody({ amount: 5 })],
        ['a host with a path', goodBody({}, 'shop-example.com/cart')],
        ['a host with a space', goodBody({}, 'shop example.com')],
    ])('2. %s: 400 invalid_selector, nothing asked', async (_name, body) => {
        const res = await post(body)

        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({
            saved: false,
            reason: 'invalid_selector',
        })
        expect(knownMock).not.toHaveBeenCalled()
        expect(insertMock).not.toHaveBeenCalled()
        expect(proposals).toHaveLength(0)
    })

    it('a body over 4 KiB: 413 too_large', async () => {
        const res = await post(goodBody({ input: `#${'a'.repeat(5000)}` }))

        expect(res.status).toBe(413)
        expect(await res.json()).toEqual({ saved: false, reason: 'too_large' })
        expect(insertMock).not.toHaveBeenCalled()
    })

    it('3. a host the catalog does not know: 404 unknown_store, never a served-config read or a write', async () => {
        knownMock.mockImplementation(async () => [])

        const res = await post(goodBody())

        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({
            saved: false,
            reason: 'unknown_store',
        })
        expect(servedMock).not.toHaveBeenCalled()
        expect(insertMock).not.toHaveBeenCalled()
        expect(proposals).toHaveLength(0)
    })

    it('3. a host that names no registrable store (localhost, a bare suffix) is unknown without a query', async () => {
        for (const host of ['localhost', 'co.uk']) {
            const res = await post(goodBody({}, host))
            expect(res.status).toBe(404)
            expect(await res.json()).toEqual({
                saved: false,
                reason: 'unknown_store',
            })
        }
        expect(knownMock).not.toHaveBeenCalled()
    })

    it('4. a store with a served config: 409 has_config, nothing recorded or written', async () => {
        servedMock.mockImplementation(async () => true)

        const res = await post(goodBody())

        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ saved: false, reason: 'has_config' })
        expect(insertMock).not.toHaveBeenCalled()
        expect(proposals).toHaveLength(0)
        expect(resetCacheMock).not.toHaveBeenCalled()
    })

    it('5. the quorum is reached but the insert finds a row already there (a racing save, or an unserved config): 409 has_config, the cache is kept', async () => {
        insertMock.mockImplementation(async () => ({ inserted: false }))

        const res = await postFromQuorum(goodBody())

        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ saved: false, reason: 'has_config' })
        expect(resetCacheMock).not.toHaveBeenCalled()
    })

    it('a database failure is a 500, never a quiet answer', async () => {
        insertMock.mockImplementation(async () => {
            throw new Error('connection lost')
        })

        const res = await postFromQuorum(goodBody())

        expect(res.status).toBe(500)
        expect(resetCacheMock).not.toHaveBeenCalled()
    })
})

describe('coupon-box-save: only a signed-in install may call it (T-6221)', () => {
    it('a forged extension Origin with no credential is 401 and nothing is read, asked or written', async () => {
        const res = await post(goodBody(), { user: null })

        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'Unauthorized' })
        expect(knownMock).not.toHaveBeenCalled()
        expect(servedMock).not.toHaveBeenCalled()
        expect(insertMock).not.toHaveBeenCalled()
        expect(proposals).toHaveLength(0)
    })

    it('PAIR: the same body with a session is accepted', async () => {
        const res = await post(goodBody(), { user: 'user-1' })

        expect(res.status).toBe(200)
        expect(proposals).toHaveLength(1)
    })

    it('a session with the wrong Origin is still 403 before the session is read', async () => {
        const web = await post(goodBody(), { origin: 'https://evil.example' })
        const none = await post(goodBody(), { origin: null })

        expect(web.status).toBe(403)
        expect(none.status).toBe(403)
        expect(getSessionMock).not.toHaveBeenCalled()
        expect(proposals).toHaveLength(0)
    })

    it('is rate-limited as a mutation', async () => {
        await post(goodBody())

        expect(checkRateLimit).toHaveBeenCalledWith(
            expect.anything(),
            'mutation',
        )
    })

    it('answers a preflight (OPTIONS) with 204, no credential needed', async () => {
        const res = await OPTIONS(
            new NextRequest('http://localhost/api/extension/coupon-box-save', {
                method: 'OPTIONS',
                headers: { origin: EXT_ORIGIN },
            }),
        )

        expect(res.status).toBe(204)
    })
})

describe('coupon-box-save: the daily write budget (T-6221)', () => {
    it('the per-user cap: the user at the cap is 429 user_budget and nothing more is written', async () => {
        envMock.COUPON_BOX_SAVE_USER_DAILY_CAP = 2
        await post(goodBody({ input: '#a' }))
        await post(goodBody({ input: '#b' }))

        const res = await post(goodBody({ input: '#c' }))

        expect(res.status).toBe(429)
        expect(await res.json()).toEqual({
            saved: false,
            reason: 'user_budget',
        })
        expect(proposals).toHaveLength(2)
        expect(insertMock).not.toHaveBeenCalled()
        // Sentry: a breadcrumb every time, ONE message per hour per cap kind
        // (this is the first user-cap hit in this file; the module keeps the
        // throttle between tests).
        await post(goodBody({ input: '#d' }))
        expect(sentry.addBreadcrumb).toHaveBeenCalledTimes(2)
        expect(sentry.captureMessage).toHaveBeenCalledTimes(1)
        expect(sentry.captureMessage).toHaveBeenCalledWith(
            'coupon-box-save user daily write cap reached',
            expect.objectContaining({
                tags: expect.objectContaining({ cap_scope: 'user' }),
            }),
        )
    })

    it('the cap is per user: another user is not affected', async () => {
        envMock.COUPON_BOX_SAVE_USER_DAILY_CAP = 1
        await post(goodBody({ input: '#a' }), { user: 'u1' })

        const res = await post(goodBody({ input: '#b' }), { user: 'u2' })

        expect(res.status).toBe(200)
    })

    it('repeating a save already made is no new write and spends no budget', async () => {
        envMock.COUPON_BOX_SAVE_USER_DAILY_CAP = 1
        await post(goodBody())

        const again = await post(goodBody())

        expect(again.status).toBe(200)
        expect(proposals).toHaveLength(1)
    })

    it('a repeat save renews the proposal (created_at = now) and spends no budget', async () => {
        envMock.COUPON_BOX_SAVE_USER_DAILY_CAP = 1
        await post(goodBody())
        const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
        proposals[0]!.createdAt = old

        const again = await post(goodBody())

        expect(again.status).toBe(200)
        expect(proposals).toHaveLength(1)
        expect(proposals[0]!.createdAt.getTime()).toBeGreaterThan(
            old.getTime() + 39 * 24 * 60 * 60 * 1000,
        )
    })

    it('RENEWAL: after the 30-day window the same users re-promote the same box by saving again', async () => {
        await postFromQuorum(goodBody())
        expect(insertMock).toHaveBeenCalledTimes(1)
        const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
        for (const row of proposals) row.createdAt = old
        insertMock.mockClear()

        // The rows are outside the corroboration window until each user
        // saves again; only the last one reaches the quorum.
        for (let i = 1; i < QUORUM; i++) {
            const res = await post(goodBody(), { user: `quorum-user-${i}` })
            expect(await res.json()).toMatchObject({ status: 'pending' })
        }
        expect(insertMock).not.toHaveBeenCalled()
        const last = await post(goodBody(), { user: `quorum-user-${QUORUM}` })

        expect(await last.json()).toMatchObject({ status: 'published' })
        expect(insertMock).toHaveBeenCalledTimes(1)
    })

    it('the per-store cap: 429 store_budget once the store has taken its share', async () => {
        envMock.COUPON_BOX_SAVE_STORE_DAILY_CAP = 2
        await post(goodBody({ input: '#a' }), { user: 'u1' })
        await post(goodBody({ input: '#b' }), { user: 'u2' })

        const res = await post(goodBody({ input: '#c' }), { user: 'u3' })

        expect(res.status).toBe(429)
        expect(await res.json()).toEqual({
            saved: false,
            reason: 'store_budget',
        })
        expect(proposals).toHaveLength(2)
        // First store-cap hit in this file: one throttled Sentry message.
        expect(sentry.captureMessage).toHaveBeenCalledTimes(1)
        expect(sentry.captureMessage).toHaveBeenCalledWith(
            'coupon-box-save store daily write cap reached',
            expect.objectContaining({
                tags: expect.objectContaining({ cap_scope: 'store' }),
            }),
        )
    })

    it('the global cap: 429 global_budget, nothing written, and Sentry hears about it', async () => {
        envMock.COUPON_BOX_SAVE_GLOBAL_DAILY_CAP = 1
        await post(goodBody({ input: '#a' }), { user: 'u1' })

        const res = await post(goodBody({ input: '#b' }), { user: 'u2' })

        expect(res.status).toBe(429)
        expect(await res.json()).toEqual({
            saved: false,
            reason: 'global_budget',
        })
        expect(proposals).toHaveLength(1)
        expect(sentry.addBreadcrumb).toHaveBeenCalledWith(
            expect.objectContaining({ category: 'coupon-box-save' }),
        )
        expect(sentry.captureMessage).toHaveBeenCalledTimes(1)
    })

    it('a cap of 0 refuses every save on that axis', async () => {
        envMock.COUPON_BOX_SAVE_USER_DAILY_CAP = 0

        const res = await post(goodBody())

        expect(res.status).toBe(429)
        expect(proposals).toHaveLength(0)
    })
})
