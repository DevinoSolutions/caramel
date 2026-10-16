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
// Private namespace: every domain ends in `learned-itest.com` (a real public
// suffix, so the pipeline hand-over's host check accepts it), and everything
// this file writes is deleted after each test.

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
    type LearnedBoxReport,
} from '@/lib/couponBoxLearned'
import { resetCouponBoxPickBudgetForTests } from '@/lib/couponBoxPickBudget'
import { hasServedStoreConfig } from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import { AUTO_DETECT_SUGGESTION_SOURCE } from '@/lib/siteSuggestions'

const SUFFIX = 'learned-itest.com'
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const freshDomain = () => `s${randomUUID().slice(0, 8)}.${SUFFIX}`

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

/** Record straight through the lib with explicit reporter hashes and clock. */
function record(
    r: LearnedBoxReport,
    install: string,
    network: string,
    now: Date,
) {
    return recordLearnedBoxReport({
        report: r,
        installHash: `install-${install}`,
        networkHash: `network-${network}`,
        now,
    })
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
    resetCouponBoxPickBudgetForTests()
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

    it('a store whose 5 boxes are all backed by 2+ networks takes no new box', async () => {
        const domain = freshDomain()
        const now = new Date()
        for (let n = 0; n < 5; n++) {
            for (const side of ['a', 'b']) {
                await record(
                    report(domain, { box: boxN(n) }),
                    `${n}-${side}`,
                    `${n}-${side}`,
                    now,
                )
            }
        }
        expect(
            await record(report(domain, { box: boxN(9) }), 'new', 'new', now),
        ).toEqual({ recorded: false, reason: 'ignored' })
        expect(await prisma.learnedCouponBox.count({ where: { domain } })).toBe(
            5,
        )
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
        expect(await handOverLearnedStore(domain)).toEqual({
            created: false,
            reason: 'already',
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
        expect(await handOverLearnedStore(domain, now)).toEqual({
            created: false,
            reason: 'daily_cap',
        })
        expect(await prisma.siteSuggestion.count({ where: { domain } })).toBe(0)
        // A day later it goes through.
        expect(
            await handOverLearnedStore(
                domain,
                new Date(now.getTime() + DAY + 1),
            ),
        ).toEqual({ created: true })
    })
})
