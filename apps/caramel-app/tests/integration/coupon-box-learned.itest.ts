import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

// Learned coupon box against the REAL prisma client + a live, migrated
// Postgres: the write rule (who counts, how often, the per-network, per-box
// and per-store caps, which reporter is evicted), the serving rule, retention,
// per-store hashing, concurrency under the per-store lock, the served-config
// guard on real store_configs rows, and the once-ever, capped hand-over to the
// store pipeline. These are the security properties of a
// crowd-sourced write path, so they are proven on the database that enforces
// them, not on a fake.
//
// Private namespace: every store is `s<random>-learned-itest.com` (its own
// registrable domain under a real public suffix, so caps keyed by the store
// do not leak between tests and the pipeline hand-over's host check accepts
// it), and everything this file writes is deleted after each test.

// MOCK (announced): env. The learned path needs the pick switched on and a
// salt; the env singleton is parsed once at import, so the values are set on
// it here. Everything else in this file is real.
const { envOverrides } = vi.hoisted(() => ({
    envOverrides: {
        COUPON_BOX_LLM_ENABLED: true,
        COUPON_BOX_PICK_MODEL: 'test/box-model',
        COUPON_BOX_LEARNED_ENABLED: true,
        COUPON_BOX_LEARNED_SALT: 'itest-salt-itest-salt-itest-salt-0001',
    },
}))
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    return { ...actual, env: { ...actual.env, ...envOverrides } }
})
// The generic per-IP limiter is rateLimit.ts's own (pinned elsewhere); off so
// a test can post more than 30 reports a minute.
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})
// MOCK (announced): the pick's model call and its outcome event. The learned
// answer must never reach either; `chat` throwing proves it.
const { chatMock } = vi.hoisted(() => ({
    chatMock: vi.fn(async (): Promise<string> => {
        throw new Error('the model must not be called for a learned answer')
    }),
}))
vi.mock('@/lib/openrouter', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/openrouter')>()),
    chat: chatMock,
}))
vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: vi.fn(async () => true),
}))
// MOCK (announced): Sentry, so a test can count what the prune reports.
const { sentryCapture } = vi.hoisted(() => ({ sentryCapture: vi.fn() }))
vi.mock('@sentry/nextjs', async importOriginal => ({
    ...(await importOriginal<typeof import('@sentry/nextjs')>()),
    captureException: sentryCapture,
}))
vi.mock('next/server', async importOriginal => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: (task: () => unknown) => {
        void task()
    },
}))

import { POST as reportPOST } from '@/app/api/extension/coupon-box-learned/route'
import { POST as pickPOST } from '@/app/api/extension/coupon-box-pick/route'
import {
    findServableLearnedBox,
    handOverLearnedStore,
    LEARNED_BOX_RULES,
    pruneLearnedCouponBoxes,
    recordLearnedBoxReport,
    resetNearCapWarningsForTests,
    type CrossStoreNetwork,
    type LearnedBoxReport,
} from '@/lib/couponBoxLearned'
import { resetCouponBoxPickBudgetForTests } from '@/lib/couponBoxPickBudget'
import { hasServedStoreConfig } from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import { AUTO_DETECT_SUGGESTION_SOURCE } from '@/lib/siteSuggestions'
import type { Prisma } from '@prisma/client'

const SUFFIX = 'learned-itest.com'
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const freshDomain = () => `s${randomUUID().slice(0, 8)}-${SUFFIX}`
const IGNORED = { recorded: false, reason: 'ignored' } as const

const BOX = {
    input: '#promo-code',
    apply: 'button[name="apply-promo"]',
    toggle: null,
    enterOnly: false,
}

function report(
    domain: string,
    overrides: Partial<LearnedBoxReport> = {},
): LearnedBoxReport {
    return {
        installId: randomUUID(),
        domain,
        box: BOX,
        source: 'rules',
        evidence: 'total_dropped',
        outcome: 'confirmed',
        ...overrides,
    }
}

const failedReport = (domain: string) =>
    report(domain, { outcome: 'failed', evidence: null })

/** A network's hashes for the caps kept across stores. Each test network
 * sits in a block of its own unless one is named. */
const crossStore = (
    network: string,
    block: string = network,
): CrossStoreNetwork => ({
    network: `any-${network}`,
    block: `block-${block}`,
})

/** Record straight through the lib with explicit reporter hashes and clock. */
function record(
    r: LearnedBoxReport,
    install: string,
    network: string,
    now: Date,
    block: string = network,
) {
    return recordLearnedBoxReport({
        report: r,
        installHash: `install-${install}`,
        networkHash: `network-${network}`,
        blockHash: `store-block-${block}`,
        anyStoreNetwork: crossStore(network, block),
        now,
    })
}

/** `now` cut to the hour, the time network events are written with. */
const hourOf = (now: Date) => new Date(Math.floor(now.getTime() / HOUR) * HOUR)

/** Run `work`, recording every advisory-lock key the learned-box code asks
 * Postgres for inside its transactions. */
async function lockKeysTakenBy<T>(
    work: () => Promise<T>,
): Promise<{ result: T; keys: string[] }> {
    const keys: string[] = []
    const original = prisma.$transaction.bind(prisma) as (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: unknown,
    ) => Promise<unknown>
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: unknown,
    ) =>
        original(
            tx =>
                fn(
                    new Proxy(tx, {
                        get(target, prop) {
                            const value: unknown = Reflect.get(target, prop)
                            if (typeof value !== 'function') return value
                            const call = value as (
                                ...args: unknown[]
                            ) => unknown
                            if (
                                prop !== '$queryRaw' &&
                                prop !== '$executeRaw'
                            ) {
                                return call.bind(target)
                            }
                            return (
                                strings: TemplateStringsArray,
                                ...values: unknown[]
                            ) => {
                                if (strings.join('').includes('advisory')) {
                                    keys.push(...values.map(String))
                                }
                                return call.call(target, strings, ...values)
                            }
                        },
                    }),
                ),
            options,
        )) as never)
    try {
        return { result: await work(), keys }
    } finally {
        spy.mockRestore()
    }
}

/** Hold a transaction advisory lock, the way an in-flight report holds its
 * store's lock, until release() is awaited. */
async function holdAdvisoryLock(key: string) {
    let locked!: () => void
    let release!: () => void
    const isLocked = new Promise<void>(r => (locked = r))
    const released = new Promise<void>(r => (release = r))
    const holder = prisma.$transaction(
        async tx => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
            locked()
            await released
        },
        { timeout: 20_000 },
    )
    await isLocked
    return {
        release: async () => {
            release()
            await holder
        },
    }
}

/** The promise's value, or 'timed out' after `seconds`. */
function withinSeconds<T>(
    seconds: number,
    promise: Promise<T>,
): Promise<T | 'timed out'> {
    return Promise.race([
        promise,
        new Promise<'timed out'>(r =>
            setTimeout(() => r('timed out'), seconds * 1000),
        ),
    ])
}

/** One confirming install on each of `networks`. */
async function confirmOn(domain: string, networks: string[], now: Date) {
    for (const net of networks) {
        await record(report(domain), `on-${net}`, net, now)
    }
}

async function boxRow(domain: string) {
    return prisma.learnedCouponBox.findFirstOrThrow({ where: { domain } })
}

async function reporterInstalls(domain: string) {
    const rows = await prisma.learnedCouponBoxReporter.findMany({
        where: { box: { domain } },
        select: { installHash: true },
    })
    return rows.map(r => r.installHash)
}

function postReport(body: unknown, ip: string) {
    return reportPOST(
        new NextRequest('http://localhost/api/extension/coupon-box-learned', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin: EXT_ORIGIN,
                'cf-connecting-ip': ip,
            },
            body: JSON.stringify(body),
        }),
    )
}

function postPick(domain: string, acceptsLearned?: boolean) {
    return pickPOST(
        new NextRequest('http://localhost/api/extension/coupon-box-pick', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin: EXT_ORIGIN,
                'cf-connecting-ip': '198.51.100.7',
            },
            body: JSON.stringify({
                domain,
                outline: '- [1] textbox "Promo code"',
                ...(acceptsLearned === undefined ? {} : { acceptsLearned }),
            }),
        }),
    )
}

async function cleanup() {
    // Holds no store, so it is cleared whole: only this file writes it.
    await prisma.learnedCouponBoxNetworkEvent.deleteMany({})
    await prisma.learnedCouponBoxStore.deleteMany({
        where: { storeDomain: { endsWith: SUFFIX } },
    })
    await prisma.learnedCouponBox.deleteMany({
        where: { domain: { endsWith: SUFFIX } },
    })
    await prisma.learnedCouponBoxHandover.deleteMany({
        where: { domain: { endsWith: SUFFIX } },
    })
    await prisma.siteSuggestion.deleteMany({
        where: { domain: { endsWith: SUFFIX } },
    })
    await prisma.$executeRaw`DELETE FROM store_configs WHERE store_name LIKE ${'%' + SUFFIX}`
}

beforeEach(() => {
    chatMock.mockClear()
    sentryCapture.mockClear()
    resetCouponBoxPickBudgetForTests()
    resetNearCapWarningsForTests()
})
afterEach(cleanup)
afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

describe('learned coupon box: who counts (real Postgres)', () => {
    it('poisoning by ONE install: any number of confirmations never makes a box servable', async () => {
        const domain = freshDomain()
        const start = Date.now()
        for (let h = 0; h < 40 * 24; h += 6) {
            await record(
                report(domain),
                'attacker',
                'net-a',
                new Date(start + h * HOUR),
            )
        }
        // Counted at most once per 24h, so 40 days are ~40 confirmations.
        expect((await boxRow(domain)).confirmations).toBeLessThanOrEqual(41)
        expect(
            await findServableLearnedBox(domain, new Date(start + 40 * DAY)),
        ).toBeNull()
    })

    it('3 networks inside ONE wider block never make a box servable; a network in a second block does', async () => {
        const domain = freshDomain()
        const now = new Date()
        for (const [install, network] of [
            ['t1', 'tunnel-1'],
            ['t2', 'tunnel-2'],
            ['t3', 'tunnel-3'],
        ] as const) {
            await record(
                report(domain),
                install,
                network,
                now,
                'one-tunnel-provider',
            )
        }
        expect(await findServableLearnedBox(domain, now)).toBeNull()

        // A real shopper elsewhere confirms it.
        expect(
            await record(report(domain), 'shopper', 'home', now, 'home-isp'),
        ).toMatchObject({ recorded: true, servable: true })
        expect(await findServableLearnedBox(domain, now)).toEqual(BOX)
    })

    it('poisoning by many forged install ids from ONE network: 2 new reporters per network per 7 days, the rest ignored', async () => {
        const domain = freshDomain()
        const now = new Date()
        const results = []
        for (let i = 0; i < 30; i++) {
            results.push(
                await record(report(domain), `forged-${i}`, 'net-a', now),
            )
        }
        expect(results.filter(r => r.recorded)).toHaveLength(
            LEARNED_BOX_RULES.newReportersPerNetwork,
        )
        expect(results[29]).toEqual({ recorded: false, reason: 'ignored' })
        expect(await reporterInstalls(domain)).toHaveLength(2)
        expect(await findServableLearnedBox(domain, now)).toBeNull()

        // A week later the same network may add two more.
        const nextWeek = new Date(now.getTime() + 7 * DAY + 60_000)
        expect(
            await record(report(domain), 'forged-late', 'net-a', nextWeek),
        ).toMatchObject({ recorded: true })
    })

    it('a reporter keeps the network it FIRST reported from: re-reporting installs from a second network frees no slot on the first', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        await record(report(domain), 'n1-a', 'N1', t0)
        await record(report(domain), 'n1-b', 'N1', t0)
        expect(await record(report(domain), 'n1-c', 'N1', t0)).toEqual(IGNORED)
        // The two admitted installs report again, a day later, now from
        // network N2: recorded, but counted for nothing...
        const later = new Date(t0.getTime() + DAY + HOUR)
        for (const install of ['n1-a', 'n1-b']) {
            expect(await record(report(domain), install, 'N2', later)).toEqual({
                recorded: true,
                counted: false,
                servable: false,
            })
        }
        expect((await boxRow(domain)).confirmations).toBe(2)
        // ...do not reopen N1's two slots for this week,
        expect(await record(report(domain), 'n1-c', 'N1', later)).toEqual(
            IGNORED,
        )
        // and does not use up N2's.
        expect(await record(report(domain), 'n2-a', 'N2', later)).toMatchObject(
            { recorded: true },
        )
        const rows = await prisma.learnedCouponBoxReporter.findMany({
            where: {
                box: { domain },
                installHash: { startsWith: 'install-n1-' },
            },
            select: { networkHash: true },
        })
        expect(rows.map(r => r.networkHash)).toEqual([
            'network-N1',
            'network-N1',
        ])
    })

    it('a report from another network than the install first used counts nothing: it neither keeps a box fresh nor fails it', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        const day = (n: number) => new Date(t0.getTime() + n * DAY)
        await confirmOn(domain, ['a', 'b', 'c'], t0)
        expect(await findServableLearnedBox(domain, t0)).toEqual(BOX)

        // The three installs, now all behind one other network, fail it.
        for (const net of ['a', 'b', 'c']) {
            expect(
                await record(
                    failedReport(domain),
                    `on-${net}`,
                    'elsewhere',
                    day(2),
                ),
            ).toEqual({ recorded: true, counted: false, servable: true })
        }
        expect(await findServableLearnedBox(domain, day(2))).toEqual(BOX)
        expect((await boxRow(domain)).failures).toBe(0)

        // ...and confirm it again from there before it goes stale: it still
        // goes stale 30 days after the last confirmation from home.
        for (const net of ['a', 'b', 'c']) {
            await record(report(domain), `on-${net}`, 'elsewhere', day(29))
        }
        expect(await findServableLearnedBox(domain, day(31))).toBeNull()
        expect((await boxRow(domain)).confirmations).toBe(3)
    })

    it('needs 3 confirming installs on 3 networks: 2 networks with any number of installs is not enough', async () => {
        const domain = freshDomain()
        const now = new Date()
        await record(report(domain), 'a1', 'net-a', now)
        await record(report(domain), 'a2', 'net-a', now)
        await record(report(domain), 'b1', 'net-b', now)
        const fourth = await record(report(domain), 'b2', 'net-b', now)
        expect(fourth).toMatchObject({ recorded: true, servable: false })
        expect(await findServableLearnedBox(domain, now)).toBeNull()

        const third = await record(report(domain), 'c1', 'net-c', now)
        expect(third).toMatchObject({ recorded: true, servable: true })
        expect(await findServableLearnedBox(domain, now)).toEqual(BOX)
    })

    it('one install counts once per 24h per outcome, and again after the window', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        const at = (h: number) => new Date(t0.getTime() + h * HOUR)
        expect(await record(report(domain), 'one', 'net-a', t0)).toMatchObject({
            counted: true,
        })
        expect(
            await record(report(domain), 'one', 'net-a', at(23)),
        ).toMatchObject({ counted: false })
        expect(
            await record(report(domain), 'one', 'net-a', at(24)),
        ).toMatchObject({ counted: true })
        expect((await boxRow(domain)).confirmations).toBe(2)
    })

    it('concurrent reports from one install count once (the per-store lock makes the 24h window atomic)', async () => {
        const domain = freshDomain()
        const now = new Date()
        const same = report(domain)
        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                record(same, 'racer', 'net-a', now),
            ),
        )
        expect(results.filter(r => r.recorded && r.counted)).toHaveLength(1)
        expect((await boxRow(domain)).confirmations).toBe(1)
        expect(await reporterInstalls(domain)).toHaveLength(1)
    })

    it('different selectors are different boxes; apply/toggle null are stored as one key', async () => {
        const domain = freshDomain()
        const now = new Date()
        const enterOnly = {
            input: '#code',
            apply: null,
            toggle: null,
            enterOnly: true,
        }
        for (const net of ['a', 'b', 'c']) {
            await record(report(domain, { box: enterOnly }), net, net, now)
        }
        await record(report(domain), 'd', 'd', now)
        expect(await prisma.learnedCouponBox.count({ where: { domain } })).toBe(
            2,
        )
        expect(await findServableLearnedBox(domain, now)).toEqual(enterOnly)
    })
})

describe('learned coupon box: failures (real Postgres)', () => {
    it('a failure for a box nobody confirmed creates nothing', async () => {
        const domain = freshDomain()
        const result = await record(
            failedReport(domain),
            'one',
            'net-a',
            new Date(),
        )
        expect(result).toEqual({ recorded: false, reason: 'unknown_box' })
        expect(await prisma.learnedCouponBox.count({ where: { domain } })).toBe(
            0,
        )
    })

    it('failures from ONE network count once: a served box survives two failing installs behind one network', async () => {
        const domain = freshDomain()
        const now = new Date()
        await confirmOn(domain, ['a', 'b', 'c'], now)
        const later = new Date(now.getTime() + HOUR)
        await record(failedReport(domain), 'x1', 'x', later)
        await record(failedReport(domain), 'x2', 'x', later)
        expect(await findServableLearnedBox(domain, later)).toEqual(BOX)
    })

    it('a long-served box stops at once when installs on 2 networks fail it, and comes back only after 2 OTHER networks confirm', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        const at = (h: number) => new Date(t0.getTime() + h * HOUR)
        await confirmOn(
            domain,
            Array.from({ length: 10 }, (_, i) => `ok${i}`),
            t0,
        )
        await record(failedReport(domain), 'x', 'x', at(1))
        expect(await findServableLearnedBox(domain, at(1))).toEqual(BOX)
        const second = await record(failedReport(domain), 'y', 'y', at(2))
        // 10 confirming networks against 2 failing: the majority alone would
        // still serve it.
        expect(second).toMatchObject({ recorded: true, servable: false })
        expect(await findServableLearnedBox(domain, at(2))).toBeNull()

        // An install on a FAILING network confirming is not new evidence.
        await record(report(domain), 'x-friend', 'x', at(3))
        expect(await findServableLearnedBox(domain, at(3))).toBeNull()
        // One other network is not enough...
        await record(report(domain), 'new1', 'n1', at(4))
        expect(await findServableLearnedBox(domain, at(4))).toBeNull()
        // ...two are.
        await record(report(domain), 'new2', 'n2', at(5))
        expect(await findServableLearnedBox(domain, at(5))).toEqual(BOX)
    })

    it('an install that confirmed and later failed it no longer counts as confirming', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        await confirmOn(domain, ['a', 'b', 'c'], t0)
        expect(await findServableLearnedBox(domain, t0)).toEqual(BOX)
        const later = new Date(t0.getTime() + HOUR)
        // One failing network: no suppression, and 2 confirming against 1
        // failing is a majority, but only 2 confirming networks remain.
        await record(failedReport(domain), 'on-c', 'c', later)
        expect(await findServableLearnedBox(domain, later)).toBeNull()
    })

    it('more failing networks than confirming ones keeps it unserved, even after 2 other networks confirm', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        const at = (h: number) => new Date(t0.getTime() + h * HOUR)
        await confirmOn(domain, ['a', 'b', 'c'], t0)
        for (const net of ['p', 'q', 'r', 's', 't', 'u']) {
            await record(failedReport(domain), `fail-${net}`, net, at(1))
        }
        await record(report(domain), 'new1', 'n1', at(2))
        await record(report(domain), 'new2', 'n2', at(2))
        // Recovered by 2 other networks, but 5 confirming networks against 6
        // failing ones: still not served.
        expect(await findServableLearnedBox(domain, at(2))).toBeNull()
        await record(report(domain), 'new3', 'n3', at(3))
        await record(report(domain), 'new4', 'n4', at(3))
        expect(await findServableLearnedBox(domain, at(3))).toEqual(BOX)
    })

    it('eviction never drops a failing reporter: 2 failing installs, then 50 new confirming installs from those 2 networks, still NOT served', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        const at = (h: number) => new Date(t0.getTime() + h * HOUR)
        // 48 confirmers on 24 networks + 2 more on networks A and B: 50 rows,
        // the reporter cap.
        for (let n = 0; n < 24; n++) {
            await record(report(domain), `c${n}-1`, `c${n}`, t0)
            await record(report(domain), `c${n}-2`, `c${n}`, t0)
        }
        await record(report(domain), 'fa', 'A', t0)
        await record(report(domain), 'fb', 'B', t0)
        expect(await reporterInstalls(domain)).toHaveLength(
            LEARNED_BOX_RULES.maxReportersPerBox,
        )
        // A and B report it failing...
        await record(failedReport(domain), 'fa', 'A', at(1))
        await record(failedReport(domain), 'fb', 'B', at(1))
        expect(await findServableLearnedBox(domain, at(1))).toBeNull()
        // ...and every confirmer is seen again (uncounted, inside its 24h
        // window), so the two failing rows are now the least recently seen.
        for (let n = 0; n < 24; n++) {
            await record(report(domain), `c${n}-1`, `c${n}`, at(2))
            await record(report(domain), `c${n}-2`, `c${n}`, at(2))
        }

        // 50 new installs from A and B over three weeks: the per-network cap
        // admits 2 per network per week, and each admitted one needs room.
        let admitted = 0
        for (let i = 0; i < 50; i++) {
            const week = Math.floor(i / 17)
            const r = await record(
                report(domain),
                `flood-${i}`,
                i % 2 === 0 ? 'A' : 'B',
                at(3 + week * (7 * 24 + 1)),
            )
            if (r.recorded) admitted += 1
        }
        // 2 per network per week, minus the slot fa and fb themselves still
        // hold on A and B in the first week.
        expect(admitted).toBe(
            3 * 2 * LEARNED_BOX_RULES.newReportersPerNetwork - 2,
        )

        const kept = await reporterInstalls(domain)
        expect(kept).toHaveLength(LEARNED_BOX_RULES.maxReportersPerBox)
        expect(kept).toContain('install-fa')
        expect(kept).toContain('install-fb')
        expect(
            await findServableLearnedBox(domain, at(3 + 2 * (7 * 24 + 1))),
        ).toBeNull()
    })

    /** Fill a box to the reporter cap with installs whose latest word is a
     * failure at `failedAt`, on the given networks (round robin). */
    async function fillWithFailures(
        domain: string,
        networks: string[],
        confirmedAt: Date,
        failedAt: Date,
    ) {
        const first = networks[0] ?? 'A'
        await record(report(domain), 'seed', first, confirmedAt)
        await record(failedReport(domain), 'seed', first, failedAt)
        const box = await boxRow(domain)
        await prisma.learnedCouponBoxReporter.createMany({
            data: Array.from(
                { length: LEARNED_BOX_RULES.maxReportersPerBox - 1 },
                (_, i) => ({
                    boxId: box.id,
                    installHash: `install-filler-${i}`,
                    networkHash: `network-${networks[(i + 1) % networks.length]}`,
                    confirmations: 1,
                    failures: 1,
                    lastConfirmedAt: confirmedAt,
                    lastFailedAt: failedAt,
                    firstSeenAt: confirmedAt,
                    lastSeenAt: failedAt,
                }),
            ),
        })
        expect(await reporterInstalls(domain)).toHaveLength(
            LEARNED_BOX_RULES.maxReportersPerBox,
        )
    }

    it('no lockout: 50 failing installs from 2 networks give way to real shoppers, and the box comes back', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        const at = (h: number) => new Date(t0.getTime() + h * HOUR)
        await fillWithFailures(domain, ['A', 'B'], t0, at(1))
        expect(await findServableLearnedBox(domain, at(1))).toBeNull()

        // Real shoppers on three other networks confirm it after the last
        // failure. Each needs a slot: an extra failing install of A or B is
        // a spare voice (A and B stay heard as failing) and makes room.
        for (const net of ['r1', 'r2', 'r3']) {
            expect(
                await record(report(domain), `real-${net}`, net, at(2)),
            ).toMatchObject({ recorded: true })
        }
        expect(await reporterInstalls(domain)).toHaveLength(
            LEARNED_BOX_RULES.maxReportersPerBox,
        )
        expect(await findServableLearnedBox(domain, at(2))).toEqual(BOX)
        // A and B still each keep a failing voice.
        const failing = await prisma.learnedCouponBoxReporter.findMany({
            where: { box: { domain }, lastFailedAt: { not: null } },
            select: { networkHash: true },
            distinct: ['networkHash'],
        })
        expect(failing.map(r => r.networkHash).sort()).toEqual([
            'network-A',
            'network-B',
        ])
    })

    it('a failure older than 30 days no longer holds its row: a box full of one-network failures takes a new reporter once they are stale', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        const day = (n: number) => new Date(t0.getTime() + n * DAY)
        // 50 failing installs, each the ONLY voice of its network.
        await fillWithFailures(
            domain,
            Array.from(
                { length: LEARNED_BOX_RULES.maxReportersPerBox },
                (_, i) => `solo${i}`,
            ),
            t0,
            new Date(t0.getTime() + HOUR),
        )
        // Fresh failures are evidence: nothing is evicted for a newcomer.
        expect(await record(report(domain), 'early', 'new0', day(1))).toEqual(
            IGNORED,
        )
        // Past the 30-day window they no longer count, and make room.
        expect(
            await record(
                report(domain),
                'late',
                'new1',
                day(LEARNED_BOX_RULES.freshDays + 1),
            ),
        ).toMatchObject({ recorded: true })
    })

    it('stale: confirmations older than 30 days stop serving; fresh ones on 3 networks bring it back', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        await confirmOn(domain, ['a', 'b', 'c'], t0)
        const day = (n: number) => new Date(t0.getTime() + n * DAY)
        expect(
            await findServableLearnedBox(
                domain,
                day(LEARNED_BOX_RULES.freshDays),
            ),
        ).toEqual(BOX)
        const later = new Date(
            day(LEARNED_BOX_RULES.freshDays).getTime() + 60_000,
        )
        expect(await findServableLearnedBox(domain, later)).toBeNull()
        await confirmOn(domain, ['a', 'b', 'c'], later)
        expect(await findServableLearnedBox(domain, later)).toEqual(BOX)
    })
})

describe('learned coupon box: size and retention (real Postgres)', () => {
    const boxN = (n: number) => ({
        input: `#code-${n}`,
        apply: `#apply-${n}`,
        toggle: null,
        enterOnly: false,
    })

    it('at most 5 boxes per store: a new one evicts an unproven box, never a box several networks back', async () => {
        const domain = freshDomain()
        const now = new Date()
        // Box 0 is backed by three networks; boxes 1-4 by one network each.
        for (const net of ['a', 'b', 'c']) {
            await record(report(domain, { box: boxN(0) }), `p-${net}`, net, now)
        }
        for (let n = 1; n <= 4; n++) {
            await record(
                report(domain, { box: boxN(n) }),
                `junk-${n}`,
                `j${n}`,
                now,
            )
        }
        expect(await prisma.learnedCouponBox.count({ where: { domain } })).toBe(
            5,
        )

        // Ten more junk boxes: each displaces another unproven one.
        for (let n = 5; n < 15; n++) {
            expect(
                await record(
                    report(domain, { box: boxN(n) }),
                    `junk-${n}`,
                    `j${n}`,
                    now,
                ),
            ).toMatchObject({ recorded: true })
        }
        const inputs = (
            await prisma.learnedCouponBox.findMany({ where: { domain } })
        ).map(b => b.inputSelector)
        expect(inputs).toHaveLength(LEARNED_BOX_RULES.maxBoxesPerDomain)
        expect(inputs).toContain('#code-0')
        expect(await findServableLearnedBox(domain, now)).toEqual(boxN(0))
    })

    it('5 boxes backed by 2 networks each do not hold the store: a new box replaces the weakest; 5 SERVABLE boxes take no new one', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        for (let n = 0; n < 5; n++) {
            for (const side of ['a', 'b']) {
                await record(
                    report(domain, { box: boxN(n) }),
                    `${n}-${side}`,
                    `${n}-${side}`,
                    new Date(t0.getTime() + n * 60_000),
                )
            }
        }
        expect(
            await record(report(domain, { box: boxN(9) }), 'new', 'new', t0),
        ).toMatchObject({ recorded: true })
        const inputs = (
            await prisma.learnedCouponBox.findMany({ where: { domain } })
        ).map(b => b.inputSelector)
        expect(inputs).toHaveLength(LEARNED_BOX_RULES.maxBoxesPerDomain)
        // The oldest of the 2-network boxes went.
        expect(inputs).not.toContain('#code-0')
        expect(inputs).toContain('#code-9')

        // A store whose boxes are all servable keeps them.
        const proven = freshDomain()
        for (let n = 0; n < 5; n++) {
            for (const side of ['a', 'b', 'c']) {
                await record(
                    report(proven, { box: boxN(n) }),
                    `${n}-${side}`,
                    `${n}-${side}`,
                    t0,
                )
            }
        }
        expect(
            await record(report(proven, { box: boxN(9) }), 'new', 'new', t0),
        ).toEqual(IGNORED)
        expect(
            await prisma.learnedCouponBox.count({ where: { domain: proven } }),
        ).toBe(LEARNED_BOX_RULES.maxBoxesPerDomain)
    })

    it('slot squatting from 2 networks: 5 boxes backed by both networks give way to a real box, which is then served', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        for (let n = 0; n < 5; n++) {
            for (const net of ['A', 'B']) {
                await record(
                    report(domain, { box: boxN(n) }),
                    `att-${n}-${net}`,
                    net,
                    t0,
                )
            }
        }
        const later = new Date(t0.getTime() + HOUR)
        await confirmOn(domain, ['r1', 'r2', 'r3'], later)
        expect(await findServableLearnedBox(domain, later)).toEqual(BOX)
    })

    it('slot churn from 2 networks cannot push out a young real box: it keeps its slot while its shoppers arrive hours apart, and is served', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        const at = (hours: number) => new Date(t0.getTime() + hours * HOUR)
        const realBoxInstalls = async () =>
            (
                await prisma.learnedCouponBoxReporter.findMany({
                    where: { box: { domain, inputSelector: BOX.input } },
                    select: { installHash: true },
                })
            )
                .map(r => r.installHash)
                .sort()

        // Two attacker networks hold four junk boxes, two each.
        for (let n = 1; n <= 4; n++) {
            await record(
                report(domain, { box: boxN(n) }),
                `att-${n}`,
                n <= 2 ? 'A' : 'B',
                at(0),
            )
        }
        // The real box arrives from one shopper's network: the 5th slot.
        await record(report(domain), 'shopper-1', 'r1', at(1))

        // Every hour the attackers add five more junk boxes; a second and a
        // third shopper, each on their own network, confirm hours apart.
        const shoppers: Record<number, string> = { 3: 'r2', 6: 'r3' }
        let junk = 5
        for (let hour = 2; hour <= 6; hour++) {
            for (let k = 0; k < 5; k++, junk++) {
                await record(
                    report(domain, { box: boxN(junk) }),
                    `att-${junk}`,
                    junk % 2 ? 'A' : 'B',
                    at(hour),
                )
            }
            const shopper = shoppers[hour]
            if (shopper) {
                expect(
                    await record(
                        report(domain),
                        `shopper-${shopper}`,
                        shopper,
                        at(hour),
                    ),
                ).toMatchObject({ recorded: true, counted: true })
            }
            // The real box, and every shopper who confirmed it, is still there.
            expect(await realBoxInstalls()).toEqual(
                [
                    'shopper-1',
                    ...Object.entries(shoppers)
                        .filter(([h]) => Number(h) <= hour)
                        .map(([, s]) => `shopper-${s}`),
                ]
                    .map(i => `install-${i}`)
                    .sort(),
            )
        }
        expect(await prisma.learnedCouponBox.count({ where: { domain } })).toBe(
            LEARNED_BOX_RULES.maxBoxesPerDomain,
        )
        expect(await findServableLearnedBox(domain, at(6))).toEqual(BOX)
    })

    it('a shared network (an office /24) can confirm every box of a store: nothing is refused, and its boxes give way to one a network alone backs', async () => {
        const domain = freshDomain()
        const now = new Date()
        for (let n = 0; n < LEARNED_BOX_RULES.maxBoxesPerDomain; n++) {
            expect(
                await record(
                    report(domain, { box: boxN(n) }),
                    `colleague-${n}`,
                    'office',
                    now,
                ),
            ).toMatchObject({ recorded: true })
        }
        // A shopper elsewhere confirms a 6th box: it takes a slot.
        expect(
            await record(report(domain), 'elsewhere', 'home', now),
        ).toMatchObject({ recorded: true })
        const inputs = (
            await prisma.learnedCouponBox.findMany({ where: { domain } })
        ).map(b => b.inputSelector)
        expect(inputs).toHaveLength(LEARNED_BOX_RULES.maxBoxesPerDomain)
        expect(inputs).toContain(BOX.input)
    })

    it('the box cap is per STORE: 12 new boxes on 12 different hosts of one store, one after another, leave exactly 5', async () => {
        const store = freshDomain()
        const now = new Date()
        for (let n = 0; n < 12; n++) {
            expect(
                await record(
                    report(`h${n}.${store}`, { box: boxN(n) }),
                    `c${n}`,
                    `c${n}`,
                    now,
                ),
            ).toMatchObject({ recorded: true })
        }
        expect(
            await prisma.learnedCouponBox.count({
                where: { domain: { endsWith: `.${store}` } },
            }),
        ).toBe(LEARNED_BOX_RULES.maxBoxesPerDomain)
    })

    it('one network adds at most newBoxesPerNetworkPerDay new boxes across ALL stores per 24 hours; other networks are unaffected', async () => {
        const t0 = new Date()
        const cap = LEARNED_BOX_RULES.newBoxesPerNetworkPerDay
        const stores = Array.from({ length: cap + 1 }, () => freshDomain())
        const results = []
        for (let n = 0; n < stores.length; n++) {
            results.push(
                await record(report(stores[n] as string), `m${n}`, 'mint', t0),
            )
        }
        expect(results.filter(r => r.recorded)).toHaveLength(cap)
        expect(results[cap]).toEqual(IGNORED)
        const last = stores[cap] as string
        expect(
            await prisma.learnedCouponBox.count({ where: { domain: last } }),
        ).toBe(0)
        // A shopper on another network still teaches that store a box...
        expect(await record(report(last), 'shopper', 'home', t0)).toMatchObject(
            { recorded: true },
        )
        // ...and the minting network may add boxes again the next day.
        expect(
            await record(
                report(freshDomain()),
                'm-later',
                'mint',
                // Counted by the hour, so out of the window a day and an hour on.
                new Date(t0.getTime() + DAY + HOUR),
            ),
        ).toMatchObject({ recorded: true })
    })

    it('one block (/16 IPv4, /32 IPv6) adds at most newBoxesPerBlockPerDay new boxes across all stores, however many networks it holds', async () => {
        const now = new Date()
        await prisma.learnedCouponBoxNetworkEvent.createMany({
            data: Array.from(
                { length: LEARNED_BOX_RULES.newBoxesPerBlockPerDay },
                () => ({
                    networkHash: 'block-tunnels',
                    kind: 'box',
                    createdAt: hourOf(now),
                }),
            ),
        })
        const store = freshDomain()
        // A /48 never heard before, in a block that is used up.
        expect(
            await record(report(store), 'n1', 'fresh-48', now, 'tunnels'),
        ).toEqual(IGNORED)
        expect(
            await prisma.learnedCouponBox.count({ where: { domain: store } }),
        ).toBe(0)
        expect(
            await record(report(store), 'n2', 'elsewhere', now),
        ).toMatchObject({ recorded: true })
    })

    it('a store is provisional until a second network confirms one of its boxes', async () => {
        const now = new Date()
        const store = freshDomain()
        const row = () =>
            prisma.learnedCouponBoxStore.findUniqueOrThrow({
                where: { storeDomain: store },
            })
        await record(report(store), 'a1', 'na', now)
        await record(report(store), 'a2', 'na', now)
        expect((await row()).establishedAt).toBeNull()
        const later = new Date(now.getTime() + HOUR)
        await record(report(store), 'b1', 'nb', later)
        expect((await row()).establishedAt).toEqual(later)
    })

    it('when the provisional pool is full, a new store pushes out the oldest provisional store, never one already confirmed from two networks', async () => {
        const now = new Date()
        const old = new Date(now.getTime() - 3 * HOUR)
        // Today's establishments are used up, so a store confirmed from two
        // networks stays provisional, waiting.
        await prisma.learnedCouponBoxStore.createMany({
            data: Array.from(
                { length: LEARNED_BOX_RULES.storesEstablishedPerDay },
                (_, n) => ({
                    storeDomain: `est${n}-${SUFFIX}`,
                    firstSeenAt: old,
                    establishedAt: now,
                }),
            ),
        })
        const waiting = freshDomain()
        await record(report(waiting), 'w1', 'wa', old)
        await record(report(waiting), 'w2', 'wb', old)
        expect(
            await prisma.learnedCouponBoxStore.findUniqueOrThrow({
                where: { storeDomain: waiting },
            }),
        ).toMatchObject({ establishedAt: null })
        // Made-up stores fill the rest of the pool, all newer than it.
        const madeUp = (n: number) => `p${n}-${SUFFIX}`
        await prisma.learnedCouponBoxStore.createMany({
            data: Array.from(
                { length: LEARNED_BOX_RULES.provisionalStores - 1 },
                (_, n) => ({
                    storeDomain: madeUp(n),
                    firstSeenAt: new Date(old.getTime() + (n + 1) * 1000),
                }),
            ),
        })
        const real = freshDomain()
        expect(await record(report(real), 'r', 'real', now)).toMatchObject({
            recorded: true,
        })
        expect(
            await prisma.learnedCouponBoxStore.count({
                where: { establishedAt: null },
            }),
        ).toBe(LEARNED_BOX_RULES.provisionalStores)
        // The oldest made-up store went; the waiting store, older still, did
        // not.
        expect(
            await prisma.learnedCouponBoxStore.findUnique({
                where: { storeDomain: madeUp(0) },
            }),
        ).toBeNull()
        expect(
            await prisma.learnedCouponBoxStore.findUnique({
                where: { storeDomain: madeUp(1) },
            }),
        ).not.toBeNull()
        expect(
            await prisma.learnedCouponBox.count({ where: { domain: waiting } }),
        ).toBe(1)
        expect(
            await prisma.learnedCouponBoxStore.findUniqueOrThrow({
                where: { storeDomain: real },
            }),
        ).toMatchObject({ establishedAt: null })
    })

    it('a store waiting on the stores-established-per-day cap is never refused: its reports are recorded, a warning is logged, and it is established on a later day', async () => {
        const now = new Date()
        await prisma.learnedCouponBoxStore.createMany({
            data: Array.from(
                { length: LEARNED_BOX_RULES.storesEstablishedPerDay },
                (_, n) => ({
                    storeDomain: `est${n}-${SUFFIX}`,
                    firstSeenAt: now,
                    establishedAt: now,
                }),
            ),
        })
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const store = freshDomain()
            const row = () =>
                prisma.learnedCouponBoxStore.findUniqueOrThrow({
                    where: { storeDomain: store },
                })
            // Its first box is taken, cap or not.
            expect(await record(report(store), 'a', 'na', now)).toMatchObject({
                recorded: true,
            })
            expect(await record(report(store), 'b', 'nb', now)).toMatchObject({
                recorded: true,
                counted: true,
            })
            expect((await row()).establishedAt).toBeNull()
            expect(warn).toHaveBeenCalledWith(
                '[learned-coupon-box] a global cap is nearly used up',
                expect.objectContaining({ what: 'stores established today' }),
            )
            const later = new Date(now.getTime() + DAY + HOUR)
            expect(await record(report(store), 'a', 'na', later)).toMatchObject(
                { counted: true },
            )
            expect((await row()).establishedAt).toEqual(later)
        } finally {
            warn.mockRestore()
        }
    })

    it('a network event is joined to nothing: its time is cut to the hour and equals no box, reporter, store or hand-over time, and its id is random', async () => {
        const t = new Date(Date.UTC(2026, 9, 17, 10, 37, 12, 345))
        const at = (minutes: number) => new Date(t.getTime() + minutes * 60_000)
        const store = freshDomain()
        await record(report(store), 'a', 'na', at(0))
        await record(report(store), 'b', 'nb', at(4))
        expect(await record(report(store), 'c', 'nc', at(9))).toMatchObject({
            servable: true,
        })
        expect(
            await handOverLearnedStore(store, crossStore('nc'), at(9)),
        ).toEqual({
            created: true,
        })
        await record(report(freshDomain()), 'd', 'nd', at(15))

        const events = await prisma.learnedCouponBoxNetworkEvent.findMany()
        // Two new boxes and one hand-over, each for the network and its block.
        expect(events).toHaveLength(6)
        const eventTimes = new Set(events.map(e => e.createdAt.getTime()))
        expect(Array.from(eventTimes)).toEqual([hourOf(t).getTime()])
        for (const e of events) {
            expect(e.id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            )
        }

        const others: (Date | null)[] = []
        const boxes = await prisma.learnedCouponBox.findMany({
            where: { domain: { endsWith: SUFFIX } },
            include: { reporters: true },
        })
        for (const b of boxes) {
            others.push(b.firstSeenAt, b.lastConfirmedAt, b.lastFailedAt)
            for (const r of b.reporters) {
                others.push(
                    r.firstSeenAt,
                    r.lastSeenAt,
                    r.lastConfirmedAt,
                    r.lastFailedAt,
                )
            }
        }
        for (const st of await prisma.learnedCouponBoxStore.findMany({
            where: { storeDomain: { endsWith: SUFFIX } },
        })) {
            others.push(st.firstSeenAt, st.establishedAt)
        }
        for (const h of await prisma.learnedCouponBoxHandover.findMany({
            where: { domain: { endsWith: SUFFIX } },
        })) {
            others.push(h.handedOverAt)
        }
        const times = others.filter((d): d is Date => d !== null)
        expect(times.length).toBeGreaterThan(15)
        for (const d of times) expect(eventTimes.has(d.getTime())).toBe(false)
    })

    it('a new box waits at most a moment for the lock new boxes share: while it is held the report is ignored and writes nothing, and reports on existing boxes do not wait', async () => {
        const now = new Date()
        const known = freshDomain()
        await record(report(known), 'k1', 'nk1', now)
        const fresh = freshDomain()
        const lock = await holdAdvisoryLock('learned-coupon-box:new-boxes')
        try {
            expect(
                await withinSeconds(2, record(report(fresh), 'f', 'nf', now)),
            ).toEqual(IGNORED)
            expect(
                await prisma.learnedCouponBox.count({
                    where: { domain: fresh },
                }),
            ).toBe(0)
            expect(
                await prisma.learnedCouponBoxStore.findUnique({
                    where: { storeDomain: fresh },
                }),
            ).toBeNull()
            expect(
                await prisma.learnedCouponBoxNetworkEvent.count({
                    where: { networkHash: 'any-nf' },
                }),
            ).toBe(0)
            // A confirmation of an existing box takes no shared lock...
            expect(
                await withinSeconds(2, record(report(known), 'k2', 'nk2', now)),
            ).toMatchObject({ recorded: true, counted: true })
            // ...and its store waits to be established, not the report.
            expect(
                await prisma.learnedCouponBoxStore.findUniqueOrThrow({
                    where: { storeDomain: known },
                }),
            ).toMatchObject({ establishedAt: null })
        } finally {
            await lock.release()
        }
        expect(await record(report(fresh), 'f', 'nf', now)).toMatchObject({
            recorded: true,
        })
        await record(report(known), 'k3', 'nk3', now)
        expect(
            (
                await prisma.learnedCouponBoxStore.findUniqueOrThrow({
                    where: { storeDomain: known },
                })
            ).establishedAt,
        ).not.toBeNull()
    })

    it('a network over its new-box cap is refused before the lock new boxes share, so its reports never take it', async () => {
        const now = new Date()
        await prisma.learnedCouponBoxNetworkEvent.createMany({
            data: Array.from(
                { length: LEARNED_BOX_RULES.newBoxesPerNetworkPerDay },
                () => ({
                    networkHash: 'any-spam',
                    kind: 'box',
                    createdAt: hourOf(now),
                }),
            ),
        })
        const spam = await lockKeysTakenBy(() =>
            record(report(freshDomain()), 's', 'spam', now),
        )
        expect(spam.result).toEqual(IGNORED)
        // It took its store's lock (so the capture works)...
        expect(spam.keys.length).toBeGreaterThan(0)
        // ...and never the shared one.
        expect(spam.keys).not.toContain('learned-coupon-box:new-boxes')
        const real = await lockKeysTakenBy(() =>
            record(report(freshDomain()), 'r', 'real', now),
        )
        expect(real.result).toMatchObject({ recorded: true })
        expect(real.keys).toContain('learned-coupon-box:new-boxes')
    })

    it('a report that counts nothing writes nothing: reports from another network do not keep a reporter row alive', async () => {
        const t0 = new Date()
        const day = (n: number) => new Date(t0.getTime() + n * DAY)
        const store = freshDomain()
        await record(report(store), 'one', 'home', t0)
        expect(await record(report(store), 'one', 'away', day(40))).toEqual({
            recorded: true,
            counted: false,
            servable: false,
        })
        // Another shopper keeps the box itself alive.
        await record(report(store), 'two', 'other', day(40))
        expect(
            (
                await prisma.learnedCouponBoxReporter.findFirstOrThrow({
                    where: {
                        box: { domain: store },
                        installHash: 'install-one',
                    },
                })
            ).lastSeenAt,
        ).toEqual(t0)
        await pruneLearnedCouponBoxes(day(61))
        expect(await reporterInstalls(store)).toEqual(['install-two'])
    })

    it('the prune stops after a few stores in a row fail for a reason other than a held lock, and reports the run to Sentry once', async () => {
        const t0 = new Date()
        for (let n = 0; n < 5; n++) {
            await confirmOn(freshDomain(), [`n${n}`], t0)
        }
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
        const tx = vi
            .spyOn(prisma, '$transaction')
            .mockRejectedValue(new Error('database is down'))
        try {
            const result = await pruneLearnedCouponBoxes(
                new Date(t0.getTime() + 61 * DAY),
            )
            expect(result).toMatchObject({ failedStores: 3, stopped: true })
            expect(tx).toHaveBeenCalledTimes(3)
            expect(sentryCapture).toHaveBeenCalledTimes(1)
        } finally {
            tx.mockRestore()
            errors.mockRestore()
        }
    })

    it('a hand-over a cap refuses is answered without its lock, so repeated reports on such a store never touch it', async () => {
        const now = new Date()
        await prisma.learnedCouponBoxNetworkEvent.createMany({
            data: Array.from(
                { length: LEARNED_BOX_RULES.handoversPerNetworkPerDay },
                () => ({
                    networkHash: 'any-busy',
                    kind: 'handover',
                    createdAt: hourOf(now),
                }),
            ),
        })
        const lock = await holdAdvisoryLock('learned-coupon-box:handover')
        try {
            expect(
                await withinSeconds(
                    2,
                    handOverLearnedStore(
                        freshDomain(),
                        crossStore('busy'),
                        now,
                    ),
                ),
            ).toEqual({ created: false, reason: 'network_cap' })
            await prisma.learnedCouponBoxHandover.createMany({
                data: Array.from(
                    { length: LEARNED_BOX_RULES.handoverDailyCap },
                    () => ({ domain: freshDomain(), handedOverAt: now }),
                ),
            })
            expect(
                await withinSeconds(
                    2,
                    handOverLearnedStore(
                        freshDomain(),
                        crossStore('other'),
                        now,
                    ),
                ),
            ).toEqual({ created: false, reason: 'daily_cap' })
        } finally {
            await lock.release()
        }
    })

    it('one block hands over at most handoversPerBlockPerDay stores per day, however many networks it holds', async () => {
        const now = new Date()
        await prisma.learnedCouponBoxNetworkEvent.createMany({
            data: Array.from(
                { length: LEARNED_BOX_RULES.handoversPerBlockPerDay },
                () => ({
                    networkHash: 'block-hb',
                    kind: 'handover',
                    createdAt: hourOf(now),
                }),
            ),
        })
        expect(
            await handOverLearnedStore(
                freshDomain(),
                crossStore('n1', 'hb'),
                now,
            ),
        ).toEqual({ created: false, reason: 'network_cap' })
        expect(
            await handOverLearnedStore(freshDomain(), crossStore('n2'), now),
        ).toEqual({ created: true })
    })

    it('a report never waits for the store lock: one that finds it taken is ignored at once and writes nothing', async () => {
        const domain = freshDomain()
        const lock = await holdAdvisoryLock(`learned-coupon-box:${domain}`)
        try {
            const started = Date.now()
            expect(
                await withinSeconds(
                    2,
                    record(report(domain), 'one', 'net-a', new Date()),
                ),
            ).toEqual(IGNORED)
            expect(Date.now() - started).toBeLessThan(2_000)
            expect(
                await prisma.learnedCouponBox.count({ where: { domain } }),
            ).toBe(0)
        } finally {
            await lock.release()
        }
        // Once the lock is free the same report is recorded.
        expect(
            await record(report(domain), 'one', 'net-a', new Date()),
        ).toMatchObject({ recorded: true })
    })

    it('concurrent new boxes on one store never exceed the cap', async () => {
        const domain = freshDomain()
        const now = new Date()
        await Promise.all(
            Array.from({ length: 12 }, (_, n) =>
                record(report(domain, { box: boxN(n) }), `c${n}`, `c${n}`, now),
            ),
        )
        expect(
            await prisma.learnedCouponBox.count({ where: { domain } }),
        ).toBeLessThanOrEqual(LEARNED_BOX_RULES.maxBoxesPerDomain)
    })

    it('a box with no confirmation for 60 days, and a reporter unseen for 60 days, are deleted', async () => {
        const old = freshDomain()
        const keep = freshDomain()
        const t0 = new Date()
        const day = (n: number) => new Date(t0.getTime() + n * DAY)
        await confirmOn(old, ['a', 'b', 'c'], t0)
        await confirmOn(keep, ['a', 'b'], t0)
        await record(report(keep), 'late', 'late', day(40))

        // A report for the store prunes its own dead rows first.
        await record(report(keep), 'later', 'later', day(61))
        const kept = await reporterInstalls(keep)
        expect(kept.sort()).toEqual(['install-late', 'install-later'])

        // The store-wide prune catches stores nobody reports on any more.
        expect(
            await prisma.learnedCouponBox.count({ where: { domain: old } }),
        ).toBe(1)
        await pruneLearnedCouponBoxes(day(61))
        expect(
            await prisma.learnedCouponBox.count({ where: { domain: old } }),
        ).toBe(0)
    })

    it('the store-wide prune takes the store lock, so it never deletes a box under a report in flight', async () => {
        const old = freshDomain()
        const t0 = new Date()
        const day = (n: number) => new Date(t0.getTime() + n * DAY)
        await confirmOn(old, ['a', 'b', 'c'], t0)

        // Hold the store's lock the way an in-flight report does.
        let locked!: () => void
        let release!: () => void
        const isLocked = new Promise<void>(r => (locked = r))
        const released = new Promise<void>(r => (release = r))
        const holder = prisma.$transaction(
            async tx => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`learned-coupon-box:${old}`}, 0))`
                locked()
                await released
            },
            { timeout: 20_000 },
        )
        await isLocked
        const prune = pruneLearnedCouponBoxes(day(61))
        await new Promise(r => setTimeout(r, 500))
        // Still there: the prune is waiting for the store.
        expect(
            await prisma.learnedCouponBox.count({ where: { domain: old } }),
        ).toBe(1)
        release()
        await holder
        await prune
        expect(
            await prisma.learnedCouponBox.count({ where: { domain: old } }),
        ).toBe(0)
    })

    it('one store the prune cannot lock does not stop the prune: it is reported and skipped, and every other store is still pruned', async () => {
        const stuck = freshDomain()
        const other = freshDomain()
        const t0 = new Date()
        const day = (n: number) => new Date(t0.getTime() + n * DAY)
        await confirmOn(stuck, ['a', 'b', 'c'], t0)
        await confirmOn(other, ['a', 'b', 'c'], t0)
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
        const lock = await holdAdvisoryLock(`learned-coupon-box:${stuck}`)
        try {
            const result = await pruneLearnedCouponBoxes(day(61))
            expect(result.failedStores).toBe(1)
            expect(
                await prisma.learnedCouponBox.count({
                    where: { domain: other },
                }),
            ).toBe(0)
            expect(
                await prisma.learnedCouponBox.count({
                    where: { domain: stuck },
                }),
            ).toBe(1)
            expect(errors).toHaveBeenCalledWith(
                expect.stringContaining('retention prune failed for one store'),
                expect.anything(),
                { storeDomain: stuck },
            )
        } finally {
            errors.mockRestore()
            await lock.release()
        }
    })

    it('the cross-store network records are deleted once out of the window: a day counted from the hour', async () => {
        const now = new Date()
        const hour = hourOf(now).getTime()
        await prisma.learnedCouponBoxNetworkEvent.createMany({
            data: [
                {
                    networkHash: 'any-old',
                    kind: 'box',
                    createdAt: new Date(hour - DAY - HOUR),
                },
                // Exactly a day before this hour: still counted, so kept.
                {
                    networkHash: 'any-new',
                    kind: 'box',
                    createdAt: new Date(hour - DAY),
                },
            ],
        })
        expect((await pruneLearnedCouponBoxes(now)).networkEvents).toBe(1)
        expect(
            (await prisma.learnedCouponBoxNetworkEvent.findMany()).map(
                e => e.networkHash,
            ),
        ).toEqual(['any-new'])
    })
})

describe('served-config guard (real store_configs rows)', () => {
    async function seedConfig(storeName: string, withXpaths = true) {
        await prisma.$executeRaw`
            INSERT INTO store_configs (store_name, coupon_input_xpath, apply_button_xpath)
            VALUES (${storeName}, ${withXpaths ? '//input' : null}, ${withXpaths ? '//button' : null})`
    }

    it('matches the host itself, its parent domains and a hyphen checkout host; not an API-only config or a lookalike', async () => {
        const store = freshDomain()
        await seedConfig(store)
        expect(await hasServedStoreConfig(store)).toBe(true)
        expect(await hasServedStoreConfig(`www.${store}`)).toBe(true)
        expect(await hasServedStoreConfig(`checkout.${store}`)).toBe(true)
        expect(await hasServedStoreConfig(`secure-${store}`)).toBe(true)
        expect(await hasServedStoreConfig(`not${store}`)).toBe(false)

        const apiOnly = freshDomain()
        await seedConfig(apiOnly, false)
        expect(await hasServedStoreConfig(apiOnly)).toBe(false)
    })

    it('a store with a served config is never written and never served, even with a servable row', async () => {
        const domain = freshDomain()
        const now = new Date()
        // A servable row exists (written before the store got its config).
        await confirmOn(domain, ['a', 'b', 'c'], now)
        expect(await findServableLearnedBox(domain, now)).not.toBeNull()
        const before = await boxRow(domain)

        await seedConfig(domain)
        const res = await postReport(report(domain), '203.0.113.9')
        expect(await res.json()).toEqual({
            recorded: false,
            reason: 'served_config',
        })
        expect((await boxRow(domain)).confirmations).toBe(before.confirmations)

        // The pick goes to the model as before (which throws here -> no_pick),
        // never to the learned row.
        const pick = await (await postPick(domain, true)).json()
        expect(pick.source).toBeUndefined()
        expect(chatMock).toHaveBeenCalledTimes(1)
    })
})

describe('the routes end to end (real Postgres)', () => {
    const IPS = ['203.0.113.10', '198.51.100.20', '192.0.2.30'] as const

    it('three installs on three networks via the route: the pick then answers from the table, no model call', async () => {
        const domain = freshDomain()
        for (const ip of IPS.slice(0, 2)) {
            expect(await (await postReport(report(domain), ip)).json()).toEqual(
                { recorded: true },
            )
        }
        // Not servable yet: the pick goes to the model.
        await postPick(domain, true)
        expect(chatMock).toHaveBeenCalledTimes(1)
        chatMock.mockClear()

        await postReport(report(domain), IPS[2])
        const res = await postPick(domain, true)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            outcome: 'box',
            source: 'learned',
            input: null,
            button: null,
            toggle: null,
            box: BOX,
        })
        expect(chatMock).not.toHaveBeenCalled()
    })

    it('a build that does not send acceptsLearned never gets a learned answer', async () => {
        const domain = freshDomain()
        for (const ip of IPS) await postReport(report(domain), ip)
        for (const flag of [undefined, false]) {
            chatMock.mockClear()
            const body = await (await postPick(domain, flag)).json()
            expect(body.source).toBeUndefined()
            expect(chatMock).toHaveBeenCalledTimes(1)
        }
    })

    it('installs behind one /24 count as ONE network through the route', async () => {
        const domain = freshDomain()
        await postReport(report(domain), '203.0.113.10')
        await postReport(report(domain), '203.0.113.200')
        // A third install on the same /24 is past the per-network cap.
        expect(
            await (await postReport(report(domain), '203.0.113.77')).json(),
        ).toEqual({ recorded: false, reason: 'ignored' })
        await postReport(report(domain), '198.51.100.20')
        expect(await findServableLearnedBox(domain)).toBeNull()
    })

    it('stores only per-store salted hashes: the same install and IP hash differently on two stores', async () => {
        const one = freshDomain()
        const two = freshDomain()
        const installId = randomUUID()
        await postReport(report(one, { installId }), '203.0.113.10')
        await postReport(report(two, { installId }), '203.0.113.10')
        const rows = await prisma.learnedCouponBoxReporter.findMany({
            where: { box: { domain: { in: [one, two] } } },
        })
        expect(rows).toHaveLength(2)
        const [a, b] = rows
        expect(a?.installHash).not.toBe(b?.installHash)
        expect(a?.networkHash).not.toBe(b?.networkHash)
        const stored = JSON.stringify(rows)
        expect(stored).not.toContain(installId)
        expect(stored).not.toContain('203.0.113')
        expect(a?.installHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('hands a newly servable store to the pipeline ONCE EVER, with no requester email', async () => {
        const domain = freshDomain()
        await postReport(report(domain), IPS[0])
        await postReport(report(domain), IPS[1])
        expect(await prisma.siteSuggestion.count({ where: { domain } })).toBe(0)
        await postReport(report(domain), IPS[2])
        await postReport(report(domain), '100.64.0.9')
        const rows = await prisma.siteSuggestion.findMany({ where: { domain } })
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            source: AUTO_DETECT_SUGGESTION_SOURCE,
            requesterEmail: null,
            userId: null,
            status: 'new',
            rawUrl: `https://${domain}/`,
        })

        // Wiping the box (and even the suggestion) does not reopen it.
        await prisma.learnedCouponBox.deleteMany({ where: { domain } })
        await prisma.siteSuggestion.deleteMany({ where: { domain } })
        for (const ip of IPS) await postReport(report(domain), ip)
        expect(await findServableLearnedBox(domain)).not.toBeNull()
        expect(await prisma.siteSuggestion.count({ where: { domain } })).toBe(0)
        expect(await handOverLearnedStore(domain, crossStore('x'))).toEqual({
            created: false,
            reason: 'already',
        })
    })

    it('hands a store over ONCE whatever host its boxes were found on, under its registrable domain', async () => {
        const store = freshDomain()
        for (const host of [`www.${store}`, `shop.${store}`]) {
            for (const ip of IPS) {
                expect(
                    await (await postReport(report(host), ip)).json(),
                ).toEqual({ recorded: true })
            }
            expect(await findServableLearnedBox(host)).toEqual(BOX)
        }
        const suggestions = await prisma.siteSuggestion.findMany({
            where: { domain: { endsWith: store } },
            select: { domain: true },
        })
        expect(suggestions).toEqual([{ domain: store }])
        expect(
            await prisma.learnedCouponBoxHandover.findMany({
                where: { domain: { endsWith: store } },
                select: { domain: true },
            }),
        ).toEqual([{ domain: store }])
    })

    it('a hand-over never waits for its lock: it answers busy at once, and a store already handed over still answers already', async () => {
        const now = new Date()
        const done = freshDomain()
        await prisma.learnedCouponBoxHandover.create({
            data: { domain: done, handedOverAt: now },
        })
        const domain = freshDomain()
        const lock = await holdAdvisoryLock('learned-coupon-box:handover')
        try {
            expect(
                await withinSeconds(
                    2,
                    handOverLearnedStore(domain, crossStore('x'), now),
                ),
            ).toEqual({ created: false, reason: 'busy' })
            expect(
                await withinSeconds(
                    2,
                    handOverLearnedStore(done, crossStore('x'), now),
                ),
            ).toEqual({ created: false, reason: 'already' })
            expect(
                await prisma.siteSuggestion.count({ where: { domain } }),
            ).toBe(0)
        } finally {
            await lock.release()
        }
        // The next servable report hands it over.
        expect(
            await handOverLearnedStore(domain, crossStore('x'), now),
        ).toEqual({
            created: true,
        })
    })

    it('hands over at most handoverDailyCap stores per 24 hours overall', async () => {
        const now = new Date()
        await prisma.learnedCouponBoxHandover.createMany({
            data: Array.from(
                { length: LEARNED_BOX_RULES.handoverDailyCap },
                () => ({ domain: freshDomain(), handedOverAt: now }),
            ),
        })
        const domain = freshDomain()
        expect(
            await handOverLearnedStore(domain, crossStore('x'), now),
        ).toEqual({
            created: false,
            reason: 'daily_cap',
        })
        expect(await prisma.siteSuggestion.count({ where: { domain } })).toBe(0)
        // A day later it goes through.
        expect(
            await handOverLearnedStore(
                domain,
                crossStore('x'),
                new Date(now.getTime() + DAY + 1),
            ),
        ).toEqual({ created: true })
    })

    it('one network hands over at most handoversPerNetworkPerDay stores per 24 hours; another network is unaffected', async () => {
        const now = new Date()
        const cap = LEARNED_BOX_RULES.handoversPerNetworkPerDay
        for (let n = 0; n < cap; n++) {
            expect(
                await handOverLearnedStore(
                    freshDomain(),
                    crossStore('mint'),
                    now,
                ),
            ).toEqual({ created: true })
        }
        const domain = freshDomain()
        expect(
            await handOverLearnedStore(domain, crossStore('mint'), now),
        ).toEqual({
            created: false,
            reason: 'network_cap',
        })
        expect(await prisma.siteSuggestion.count({ where: { domain } })).toBe(0)
        expect(
            await handOverLearnedStore(domain, crossStore('home'), now),
        ).toEqual({
            created: true,
        })
        expect(
            await handOverLearnedStore(
                freshDomain(),
                crossStore('mint'),
                // Counted by the hour, so out of the window a day and an hour on.
                new Date(now.getTime() + DAY + HOUR),
            ),
        ).toEqual({ created: true })
    })
})
