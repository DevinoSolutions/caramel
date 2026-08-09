import { POST } from '@/app/api/account/savings/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/account/savings — the extension's opt-in savings push.
//
// The two properties that actually matter here are idempotency and honest
// reporting, and they are both properties of REPEATED or PARTIALLY-BAD input,
// which is exactly the input a hand-run happy path never produces. So the
// prisma mock below is stateful: it enforces the real UNIQUE(client_event_id)
// constraint in memory, which is what lets "send the same batch twice" be a
// test rather than a hope.

interface SavingsRow {
    userId: string
    couponId: string | null
    store: string
    code: string
    amountCents: number
    currency: string
    occurredAt: Date
    clientEventId: string
}

const { prismaMock, db, defaults } = vi.hoisted(() => {
    const state = {
        savings: [] as SavingsRow[],
        /** Catalog coupon ids this deployment has ingested. */
        coupons: new Set<string>(),
        /** users rows, keyed by id. Absent = no such user, which the route
         * must treat as "no consent" rather than as permission. */
        users: new Map<string, { savingsSyncEnabled: boolean }>(),
    }

    // Held separately so beforeEach can mockReset() and re-arm. A test that
    // overrides one of these with mockResolvedValue would otherwise leak its
    // override into every test after it — which it did, and the symptom was a
    // LATER test failing on state the earlier one had changed.
    const impl = {
        findSavings: async (args: {
            where: { clientEventId: { in: string[] } }
        }) =>
            state.savings
                .filter(row =>
                    args.where.clientEventId.in.includes(row.clientEventId),
                )
                .map(row => ({ clientEventId: row.clientEventId })),

        // Models the real ON CONFLICT DO NOTHING: a row whose client_event_id
        // already exists is skipped, not duplicated and not thrown. Without
        // skipDuplicates it throws, exactly as Postgres would.
        createSavings: async (args: {
            data: SavingsRow[]
            skipDuplicates?: boolean
        }) => {
            let count = 0
            for (const row of args.data) {
                const clash = state.savings.some(
                    existing => existing.clientEventId === row.clientEventId,
                )
                if (clash) {
                    if (args.skipDuplicates) continue
                    throw new Error(
                        'Unique constraint failed on the fields: (`client_event_id`)',
                    )
                }
                state.savings.push(row)
                count++
            }
            return { count }
        },

        findCoupons: async (args: { where: { id: { in: string[] } } }) =>
            args.where.id.in
                .filter(id => state.coupons.has(id))
                .map(id => ({ id })),

        findUser: async (args: { where: { id: string } }) =>
            state.users.get(args.where.id) ?? null,
    }

    return {
        db: state,
        defaults: impl,
        prismaMock: {
            savingsEvent: {
                findMany: vi.fn(impl.findSavings),
                createMany: vi.fn(impl.createSavings),
            },
            coupon: { findMany: vi.fn(impl.findCoupons) },
            user: { findUnique: vi.fn(impl.findUser) },
        },
    }
})
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

const { envMock } = vi.hoisted(() => ({
    envMock: {
        CHROME_EXTENSION_ORIGIN: 'chrome-extension://known-id' as
            | string
            | undefined,
        FIREFOX_EXTENSION_ORIGIN: undefined as string | undefined,
        SAFARI_EXTENSION_ORIGIN: undefined as string | undefined,
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

const { getSessionMock } = vi.hoisted(() => ({
    getSessionMock: vi.fn(async () => null as unknown),
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))

vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

interface IngestResponse {
    accepted: number
    duplicates: number
    stored: string[]
    rejected: { index: number; clientEventId: string | null; reason: string }[]
}

function request(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/account/savings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

/** A valid event; override any field to make it invalid in exactly one way. */
function event(overrides: Record<string, unknown> = {}) {
    return {
        clientEventId: 'evt-1',
        store: 'shop.com',
        code: 'SAVE10',
        amountCents: 1250,
        currency: 'USD',
        occurredAt: '2026-08-09T12:00:00.000Z',
        ...overrides,
    }
}

async function post(body: unknown) {
    const res = await POST(request(body))
    return { res, json: (await res.json()) as IngestResponse }
}

/** Signed in AND consented — the only state in which an ingest can succeed, so
 * it is the default for every test that is about something else. */
function signedIn(id = 'user-1') {
    getSessionMock.mockResolvedValue({ user: { id }, session: { id: 'sess' } })
    db.users.set(id, { savingsSyncEnabled: true })
}

beforeEach(() => {
    db.savings.length = 0
    db.coupons.clear()
    db.users.clear()
    prismaMock.user.findUnique.mockReset()
    prismaMock.user.findUnique.mockImplementation(defaults.findUser)
    prismaMock.savingsEvent.findMany.mockReset()
    prismaMock.savingsEvent.findMany.mockImplementation(defaults.findSavings)
    prismaMock.savingsEvent.createMany.mockReset()
    prismaMock.savingsEvent.createMany.mockImplementation(
        defaults.createSavings,
    )
    prismaMock.coupon.findMany.mockReset()
    prismaMock.coupon.findMany.mockImplementation(defaults.findCoupons)
    getSessionMock.mockReset()
    getSessionMock.mockResolvedValue(null)
})

describe('a signed-out caller cannot push savings', () => {
    it('401s with no session, and writes nothing', async () => {
        const res = await POST(request({ events: [event()] }))
        expect(res.status).toBe(401)
        expect(prismaMock.savingsEvent.createMany).not.toHaveBeenCalled()
        expect(db.savings).toHaveLength(0)
    })
})

describe('a well-formed batch is stored once', () => {
    it('stores every event and reports each id back', async () => {
        signedIn()
        const { res, json } = await post({
            events: [
                event({ clientEventId: 'a' }),
                event({ clientEventId: 'b', store: 'other.com' }),
            ],
        })

        expect(res.status).toBe(200)
        expect(json.accepted).toBe(2)
        expect(json.duplicates).toBe(0)
        expect(json.stored).toEqual(['a', 'b'])
        expect(json.rejected).toEqual([])
        expect(db.savings.map(row => row.clientEventId)).toEqual(['a', 'b'])
    })

    it('stamps the row with the signed-in user, never a client-supplied one', async () => {
        signedIn('user-42')
        await post({
            events: [event({ clientEventId: 'a', userId: 'somebody-else' })],
        })
        expect(db.savings[0]!.userId).toBe('user-42')
    })

    it('uppercases the currency so usd and USD are one total, not two', async () => {
        signedIn()
        await post({ events: [event({ currency: 'usd' })] })
        expect(db.savings[0]!.currency).toBe('USD')
    })

    it('accepts an automatic discount, which has no code', async () => {
        signedIn()
        const { json } = await post({ events: [event({ code: '' })] })
        expect(json.accepted).toBe(1)
        expect(db.savings[0]!.code).toBe('')
    })
})

describe('replaying a batch does not duplicate anything', () => {
    it('stores nothing the second time and still reports the ids stored', async () => {
        signedIn()
        const batch = {
            events: [
                event({ clientEventId: 'a' }),
                event({ clientEventId: 'b' }),
            ],
        }

        const first = await post(batch)
        expect(first.json.accepted).toBe(2)

        // The retry a client makes when it never saw the first response.
        const second = await post(batch)
        expect(second.res.status).toBe(200)
        expect(second.json.accepted).toBe(0)
        expect(second.json.duplicates).toBe(2)
        // Still reported as stored — they ARE stored, and a client that read
        // this as "not stored" would retry them forever.
        expect(second.json.stored).toEqual(['a', 'b'])

        expect(db.savings).toHaveLength(2)
    })

    it('does not duplicate when a later batch re-sends one earlier id among new ones', async () => {
        signedIn()
        await post({ events: [event({ clientEventId: 'a' })] })

        const { json } = await post({
            events: [
                event({ clientEventId: 'a' }),
                event({ clientEventId: 'b' }),
            ],
        })

        expect(json.accepted).toBe(1)
        expect(json.duplicates).toBe(1)
        expect(db.savings.map(row => row.clientEventId)).toEqual(['a', 'b'])
    })

    it('collapses an id repeated inside one batch instead of inserting it twice', async () => {
        signedIn()
        const { json } = await post({
            events: [
                event({ clientEventId: 'a' }),
                event({ clientEventId: 'a' }),
            ],
        })

        expect(db.savings).toHaveLength(1)
        expect(json.stored).toEqual(['a'])
        // The repeat is not an error: its id ends up stored either way, so the
        // "every id lands in stored or rejected" contract still holds.
        expect(json.rejected).toEqual([])
    })

    it('survives the pre-check missing a row that already exists', async () => {
        signedIn()
        await post({ events: [event({ clientEventId: 'a' })] })
        expect(db.savings).toHaveLength(1)

        // The state a concurrent flush produces: the row IS in the table, but
        // the pre-flight SELECT does not see it — the other request had not
        // committed when this one read. Simulated directly rather than with two
        // real in-flight requests, because the interleaving that matters is the
        // read/write ordering, not the parallelism, and this way it happens
        // every run instead of sometimes.
        prismaMock.savingsEvent.findMany.mockResolvedValue([])

        const { res, json } = await post({
            events: [event({ clientEventId: 'a' })],
        })

        // No 500 on the unique-constraint violation…
        expect(res.status).toBe(200)
        // …still exactly one row…
        expect(db.savings).toHaveLength(1)
        // …and the id is still reported stored, because it IS stored. A client
        // told otherwise would retry it forever.
        expect(json.stored).toEqual(['a'])
        expect(json.accepted).toBe(0)
    })

    it('always hands createMany the conflict clause — the last line of defence', async () => {
        signedIn()
        await post({ events: [event({ clientEventId: 'a' })] })
        expect(
            prismaMock.savingsEvent.createMany.mock.calls[0]![0].skipDuplicates,
        ).toBe(true)
    })

    it('never sends a duplicate to createMany at all', async () => {
        signedIn()
        await post({ events: [event({ clientEventId: 'a' })] })
        await post({
            events: [
                event({ clientEventId: 'a' }),
                event({ clientEventId: 'b' }),
            ],
        })

        const secondInsert =
            prismaMock.savingsEvent.createMany.mock.calls[1]![0]
        expect(secondInsert.data.map(row => row.clientEventId)).toEqual(['b'])
    })
})

describe('one bad row does not cost the good rows beside it', () => {
    it('stores the valid events and reports the invalid one with a reason', async () => {
        signedIn()
        const { res, json } = await post({
            events: [
                event({ clientEventId: 'good-1' }),
                event({ clientEventId: 'bad', amountCents: -500 }),
                event({ clientEventId: 'good-2' }),
            ],
        })

        expect(res.status).toBe(200)
        expect(json.stored).toEqual(['good-1', 'good-2'])
        expect(json.rejected).toHaveLength(1)
        expect(json.rejected[0]!.index).toBe(1)
        expect(json.rejected[0]!.clientEventId).toBe('bad')
        expect(json.rejected[0]!.reason).toContain('amountCents')
        expect(db.savings.map(row => row.clientEventId)).toEqual([
            'good-1',
            'good-2',
        ])
    })

    it('accounts for EVERY submitted id — nothing is silently dropped', async () => {
        signedIn()
        const ids = ['a', 'b', 'c', 'd']
        const { json } = await post({
            events: [
                event({ clientEventId: 'a' }),
                event({ clientEventId: 'b', currency: 'DOLLARS' }),
                event({ clientEventId: 'c', occurredAt: 'not-a-date' }),
                event({ clientEventId: 'd' }),
            ],
        })

        const accountedFor = [
            ...json.stored,
            ...json.rejected.map(row => row.clientEventId),
        ]
        expect(new Set(accountedFor)).toEqual(new Set(ids))
    })

    it('still answers 200 when every row was rejected — the REQUEST was fine', async () => {
        signedIn()
        const { res, json } = await post({
            events: [event({ amountCents: 0 })],
        })
        expect(res.status).toBe(200)
        expect(json.accepted).toBe(0)
        expect(json.stored).toEqual([])
        expect(json.rejected).toHaveLength(1)
        expect(prismaMock.savingsEvent.createMany).not.toHaveBeenCalled()
    })

    it('names the row by index even when its id is unreadable', async () => {
        signedIn()
        const { json } = await post({ events: [{ nonsense: true }] })
        expect(json.rejected[0]!.index).toBe(0)
        expect(json.rejected[0]!.clientEventId).toBeNull()
    })
})

describe('validation of a single event', () => {
    const cases: [string, Record<string, unknown>][] = [
        ['a missing idempotency key', { clientEventId: undefined }],
        ['an empty idempotency key', { clientEventId: '   ' }],
        ['a zero amount', { amountCents: 0 }],
        ['a negative amount', { amountCents: -1 }],
        ['a fractional amount', { amountCents: 12.5 }],
        ['an amount above the sanity ceiling', { amountCents: 10_000_001 }],
        ['a two-letter currency', { currency: 'US' }],
        ['a four-letter currency', { currency: 'USDD' }],
        ['a numeric currency', { currency: '840' }],
        ['an empty store', { store: '' }],
        ['an unparseable timestamp', { occurredAt: 'yesterday' }],
    ]

    for (const [label, override] of cases) {
        it(`rejects ${label}`, async () => {
            signedIn()
            const { json } = await post({ events: [event(override)] })
            expect(json.rejected).toHaveLength(1)
            expect(db.savings).toHaveLength(0)
        })
    }

    it('rejects an event dated beyond the clock-skew allowance', async () => {
        signedIn()
        const { json } = await post({
            events: [
                event({
                    occurredAt: new Date(
                        Date.now() + 60 * 60 * 1000,
                    ).toISOString(),
                }),
            ],
        })
        expect(json.rejected[0]!.reason).toContain('future')
    })

    it('tolerates a device clock that runs a couple of minutes fast', async () => {
        signedIn()
        const { json } = await post({
            events: [
                event({
                    occurredAt: new Date(
                        Date.now() + 2 * 60 * 1000,
                    ).toISOString(),
                }),
            ],
        })
        expect(json.rejected).toEqual([])
        expect(json.accepted).toBe(1)
    })

    it('rejects an epoch timestamp — a corrupted clock, not history', async () => {
        signedIn()
        const { json } = await post({
            events: [event({ occurredAt: new Date(0).toISOString() })],
        })
        expect(json.rejected[0]!.reason).toContain('implausibly old')
    })
})

describe('the envelope is all-or-nothing', () => {
    it('422s a batch over the cap rather than truncating it', async () => {
        signedIn()
        const events = Array.from({ length: 101 }, (_, i) =>
            event({ clientEventId: `e-${i}` }),
        )
        const res = await POST(request({ events }))
        expect(res.status).toBe(422)
        // Truncating would drop rows the caller believed it handed over.
        expect(prismaMock.savingsEvent.createMany).not.toHaveBeenCalled()
    })

    it('accepts a batch exactly at the cap', async () => {
        signedIn()
        const events = Array.from({ length: 100 }, (_, i) =>
            event({ clientEventId: `e-${i}` }),
        )
        const { res, json } = await post({ events })
        expect(res.status).toBe(200)
        expect(json.accepted).toBe(100)
    })

    it('422s an empty batch', async () => {
        signedIn()
        const res = await POST(request({ events: [] }))
        expect(res.status).toBe(422)
    })

    it('422s a body that is not an events array', async () => {
        signedIn()
        const res = await POST(request({ events: 'nope' }))
        expect(res.status).toBe(422)
    })
})

describe('an unknown coupon id cannot take the batch down with it', () => {
    it('nulls the link and still stores the saving', async () => {
        signedIn()
        db.coupons.add('coupon-live')

        const { json } = await post({
            events: [
                event({ clientEventId: 'a', couponId: 'coupon-live' }),
                // Expired out of the catalog since the extension cached it. A
                // real FK violation here would fail the WHOLE createMany.
                event({ clientEventId: 'b', couponId: 'coupon-gone' }),
            ],
        })

        expect(json.accepted).toBe(2)
        expect(db.savings.find(r => r.clientEventId === 'a')!.couponId).toBe(
            'coupon-live',
        )
        expect(
            db.savings.find(r => r.clientEventId === 'b')!.couponId,
        ).toBeNull()
    })

    it('does not query the catalog when no event names a coupon', async () => {
        signedIn()
        await post({ events: [event()] })
        expect(prismaMock.coupon.findMany).not.toHaveBeenCalled()
    })
})

// The device setting is a CACHE of consent, not the gate. Anything holding a
// bearer token can POST this route — a stale extension build that never saw
// the user turn sync off, most of all — so the account column decides, per
// request. Proven live before it was fixed: a user with sync off had an event
// stored and displayed back to them.
describe('the account consent flag gates the ingest, not the device setting', () => {
    // Positive first, deliberately: the negatives below all assert "nothing was
    // written", which is also what a route broken in any OTHER way produces.
    // This pins that the exact same batch DOES store when consent is on, so a
    // green negative means the gate worked rather than that nothing works.
    it('stores the batch when the account has savings sync ON', async () => {
        signedIn('user-consents')
        const { res, json } = await post({
            events: [event({ clientEventId: 'consented' })],
        })

        expect(res.status).toBe(200)
        expect(json.accepted).toBe(1)
        expect(db.savings.map(row => row.clientEventId)).toEqual(['consented'])
    })

    it('refuses that same batch with 403 savings_sync_disabled when consent is OFF', async () => {
        signedIn('user-declines')
        db.users.set('user-declines', { savingsSyncEnabled: false })

        const res = await POST(request({ events: [event()] }))
        const body = (await res.json()) as { error?: string }

        expect(res.status).toBe(403)
        // A machine-readable code, not prose: the extension branches on this
        // exact string to stop sweeping instead of retrying forever.
        expect(body.error).toBe('savings_sync_disabled')
        expect(db.savings).toHaveLength(0)
        expect(prismaMock.savingsEvent.createMany).not.toHaveBeenCalled()
    })

    it('refuses before touching the events at all — a valid batch is not half-processed', async () => {
        signedIn('user-declines')
        db.users.set('user-declines', { savingsSyncEnabled: false })

        await POST(request({ events: [event()] }))

        expect(prismaMock.savingsEvent.findMany).not.toHaveBeenCalled()
    })

    it('reads the flag from the users table, never off the session object', async () => {
        // better-auth projects only the fields it knows onto session.user, so
        // a custom column arrives there as undefined — indistinguishable from
        // a real false. A gate reading the session would refuse EVERY user.
        getSessionMock.mockResolvedValue({
            user: { id: 'user-1', savingsSyncEnabled: false },
            session: { id: 'sess' },
        })
        db.users.set('user-1', { savingsSyncEnabled: true })

        const { res, json } = await post({ events: [event()] })

        expect(res.status).toBe(200)
        expect(json.accepted).toBe(1)
        expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            select: { savingsSyncEnabled: true },
        })
    })

    it('fails closed when the user row cannot be read', async () => {
        // The session names user-ghost; the users table has no such row.
        // Absence of a recorded consent is not consent.
        getSessionMock.mockResolvedValue({
            user: { id: 'user-ghost' },
            session: { id: 'sess' },
        })

        const res = await POST(request({ events: [event()] }))

        expect(res.status).toBe(403)
        expect(db.savings).toHaveLength(0)
    })

    it('still 401s a signed-out caller rather than 403 — the gate did not replace auth', async () => {
        const res = await POST(request({ events: [event()] }))
        expect(res.status).toBe(401)
        expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
    })
})
