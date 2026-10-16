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
// Postgres: the write rule (who counts, how often, how many reporters are
// kept), the serving rule in SQL against the same rule in TypeScript, the
// served-config guard on real store_configs rows, and the once-per-domain
// hand-over to the store pipeline. These are the security properties of a
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
    isServableLearnedBox,
    LEARNED_BOX_RULES,
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

async function boxRow(domain: string) {
    return prisma.learnedCouponBox.findFirstOrThrow({ where: { domain } })
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
        // One install hammering the same box for 40 days, a report every hour.
        for (let h = 0; h < 40 * 24; h += 6) {
            await record(
                report(domain),
                'attacker',
                'net-a',
                new Date(start + h * HOUR),
            )
        }
        const row = await boxRow(domain)
        expect(row.distinctInstalls).toBe(1)
        // Counted at most once per 24h, so 40 days are ~40 confirmations, not 160.
        expect(row.confirmations).toBeLessThanOrEqual(41)
        expect(
            await findServableLearnedBox(domain, new Date(start + 40 * DAY)),
        ).toBeNull()
    })

    it('poisoning by many forged install ids from ONE network: never servable', async () => {
        const domain = freshDomain()
        const now = new Date()
        for (let i = 0; i < 30; i++) {
            await record(report(domain), `forged-${i}`, 'net-a', now)
        }
        const row = await boxRow(domain)
        expect(row.distinctInstalls).toBe(30)
        expect(row.distinctNetworks).toBe(1)
        expect(isServableLearnedBox(row, now)).toBe(false)
        expect(await findServableLearnedBox(domain, now)).toBeNull()
    })

    it('two installs on two networks confirming = servable, in TypeScript and in SQL alike', async () => {
        const domain = freshDomain()
        const now = new Date()
        await record(report(domain), 'one', 'net-a', now)
        expect(await findServableLearnedBox(domain, now)).toBeNull()
        const result = await record(report(domain), 'two', 'net-b', now)
        expect(result).toMatchObject({
            recorded: true,
            counted: true,
            servable: true,
        })
        const row = await boxRow(domain)
        expect(isServableLearnedBox(row, now)).toBe(true)
        expect(await findServableLearnedBox(domain, now)).toEqual(BOX)
    })

    it('one install counts once per 24h per outcome, and again after the window', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        expect(await record(report(domain), 'one', 'net-a', t0)).toMatchObject({
            counted: true,
        })
        expect(
            await record(
                report(domain),
                'one',
                'net-a',
                new Date(t0.getTime() + 23 * HOUR),
            ),
        ).toMatchObject({ counted: false })
        expect(
            await record(
                report(domain),
                'one',
                'net-a',
                new Date(t0.getTime() + 24 * HOUR),
            ),
        ).toMatchObject({ counted: true })
        expect((await boxRow(domain)).confirmations).toBe(2)
    })

    it('a failure majority stops serving', async () => {
        const domain = freshDomain()
        const now = new Date()
        await record(report(domain), 'one', 'net-a', now)
        await record(report(domain), 'two', 'net-b', now)
        expect(await findServableLearnedBox(domain, now)).not.toBeNull()

        // ONE install failing on two days: the failing-installs rule does not
        // fire (1 < 2), so this pins the majority rule on its own.
        const failed = report(domain, { outcome: 'failed', evidence: null })
        await record(failed, 'three', 'net-c', now)
        // 2 confirmations vs 1 failure: still served.
        expect(await findServableLearnedBox(domain, now)).not.toBeNull()
        const later = new Date(now.getTime() + 24 * HOUR)
        await record(failed, 'three', 'net-c', later)
        // 2 vs 2: confirmations must OUTNUMBER failures.
        const row = await boxRow(domain)
        expect(row.failures).toBe(2)
        expect(row.failingInstalls).toBe(1)
        expect(isServableLearnedBox(row, later)).toBe(false)
        expect(await findServableLearnedBox(domain, later)).toBeNull()
    })

    it('a long-served box that breaks stops being served once 2 installs fail, despite many confirmations', async () => {
        const domain = freshDomain()
        const now = new Date()
        for (let i = 0; i < 10; i++) {
            await record(report(domain), `ok-${i}`, `net-${i}`, now)
        }
        const later = new Date(now.getTime() + HOUR)
        const failed = report(domain, { outcome: 'failed', evidence: null })
        // A shopper who confirmed it earlier now sees it fail.
        await record(failed, 'ok-0', 'net-0', later)
        expect(await findServableLearnedBox(domain, later)).not.toBeNull()
        const second = await record(failed, 'fresh', 'net-x', later)
        expect(second).toMatchObject({ counted: true, servable: false })
        const row = await boxRow(domain)
        // 10 confirmations vs 2 failures: the majority rule alone still serves.
        expect(row.confirmations).toBe(10)
        expect(row.failures).toBe(2)
        expect(row.failingInstalls).toBe(2)
        expect(isServableLearnedBox(row, later)).toBe(false)
        expect(await findServableLearnedBox(domain, later)).toBeNull()

        // One of them confirming it again (the store fixed it) brings it back.
        const fixedAt = new Date(later.getTime() + 25 * HOUR)
        await record(report(domain), 'ok-0', 'net-0', fixedAt)
        expect((await boxRow(domain)).failingInstalls).toBe(1)
        expect(await findServableLearnedBox(domain, fixedAt)).not.toBeNull()
    })

    it('stale: no counted confirmation in the last 30 days stops serving', async () => {
        const domain = freshDomain()
        const t0 = new Date()
        await record(report(domain), 'one', 'net-a', t0)
        await record(report(domain), 'two', 'net-b', t0)
        const day = (n: number) => new Date(t0.getTime() + n * DAY)
        expect(
            await findServableLearnedBox(
                domain,
                day(LEARNED_BOX_RULES.maxAgeDays),
            ),
        ).not.toBeNull()
        const later = new Date(
            t0.getTime() + LEARNED_BOX_RULES.maxAgeDays * DAY + 60_000,
        )
        expect(isServableLearnedBox(await boxRow(domain), later)).toBe(false)
        expect(await findServableLearnedBox(domain, later)).toBeNull()
        // A fresh confirmation brings it back.
        await record(report(domain), 'one', 'net-a', later)
        expect(await findServableLearnedBox(domain, later)).not.toBeNull()
    })

    it('a failure for a box nobody confirmed creates nothing', async () => {
        const domain = freshDomain()
        const result = await record(
            report(domain, { outcome: 'failed', evidence: null }),
            'one',
            'net-a',
            new Date(),
        )
        expect(result).toEqual({ recorded: false, reason: 'unknown_box' })
        expect(await prisma.learnedCouponBox.count({ where: { domain } })).toBe(
            0,
        )
    })

    it('keeps at most maxReportersPerBox reporter rows, dropping the least recently seen', async () => {
        const domain = freshDomain()
        const t0 = Date.now()
        const cap = LEARNED_BOX_RULES.maxReportersPerBox
        for (let i = 0; i < cap + 5; i++) {
            await record(
                report(domain),
                `r${i}`,
                `net-${i % 3}`,
                new Date(t0 + i * 1000),
            )
        }
        const row = await boxRow(domain)
        expect(row.distinctInstalls).toBe(cap)
        const kept = await prisma.learnedCouponBoxReporter.findMany({
            where: { boxId: row.id },
            select: { installHash: true },
        })
        expect(kept).toHaveLength(cap)
        expect(kept.map(r => r.installHash)).not.toContain('install-r0')
        expect(kept.map(r => r.installHash)).toContain(`install-r${cap + 4}`)
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
        await record(report(domain, { box: enterOnly }), 'one', 'net-a', now)
        await record(report(domain, { box: enterOnly }), 'two', 'net-b', now)
        await record(report(domain), 'three', 'net-c', now)
        expect(await prisma.learnedCouponBox.count({ where: { domain } })).toBe(
            2,
        )
        expect(await findServableLearnedBox(domain, now)).toEqual(enterOnly)
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
        await record(report(domain), 'one', 'net-a', now)
        await record(report(domain), 'two', 'net-b', now)
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
    it('two installs on two networks via the route: the pick then answers from the table, no model call', async () => {
        const domain = freshDomain()
        expect(
            await (await postReport(report(domain), '203.0.113.10')).json(),
        ).toEqual({ recorded: true })
        // Not servable yet: the pick goes to the model.
        await postPick(domain, true)
        expect(chatMock).toHaveBeenCalledTimes(1)
        chatMock.mockClear()

        expect(
            await (await postReport(report(domain), '198.51.100.20')).json(),
        ).toEqual({ recorded: true })
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
        await postReport(report(domain), '203.0.113.10')
        await postReport(report(domain), '198.51.100.20')
        for (const flag of [undefined, false]) {
            chatMock.mockClear()
            const body = await (await postPick(domain, flag)).json()
            expect(body.source).toBeUndefined()
            expect(chatMock).toHaveBeenCalledTimes(1)
        }
    })

    it('two installs behind the same /24 count as ONE network through the route', async () => {
        const domain = freshDomain()
        await postReport(report(domain), '203.0.113.10')
        await postReport(report(domain), '203.0.113.200')
        const row = await boxRow(domain)
        expect(row.distinctInstalls).toBe(2)
        expect(row.distinctNetworks).toBe(1)
        expect(await findServableLearnedBox(domain)).toBeNull()
    })

    it('stores only salted hashes: no install id, no IP, no page text', async () => {
        const domain = freshDomain()
        const r = report(domain)
        await postReport(r, '203.0.113.10')
        const row = await boxRow(domain)
        const reporters = await prisma.learnedCouponBoxReporter.findMany({
            where: { boxId: row.id },
        })
        const stored = JSON.stringify({ row, reporters })
        expect(stored).not.toContain(r.installId)
        expect(stored).not.toContain('203.0.113')
        expect(reporters[0]?.installHash).toMatch(/^[0-9a-f]{64}$/)
        expect(reporters[0]?.networkHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('hands a newly servable store to the pipeline ONCE, with no requester email', async () => {
        const domain = freshDomain()
        await postReport(report(domain), '203.0.113.10')
        expect(await prisma.siteSuggestion.count({ where: { domain } })).toBe(0)
        await postReport(report(domain), '198.51.100.20')
        await postReport(report(domain), '192.0.2.30')
        const rows = await prisma.siteSuggestion.findMany({ where: { domain } })
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            source: AUTO_DETECT_SUGGESTION_SOURCE,
            requesterEmail: null,
            userId: null,
            status: 'new',
            rawUrl: `https://${domain}/`,
        })
    })
})
