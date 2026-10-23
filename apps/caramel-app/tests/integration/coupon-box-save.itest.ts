import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

// POST /api/extension/coupon-box-save against the REAL prisma client and a
// live Postgres (the harness runs `prisma migrate deploy` first). Proves the
// contract's golden rules where only the database can: a saved row comes back
// from GET /api/extension/supported-stores exactly like a pipeline row, a
// store with a config refuses the save, a later pipeline push replaces a
// saved row whole (whatever its updated_at), and pipeline-on-pipeline upserts
// behave as before. Test stores are `cbsave-<uuid>.com`, test coupons use the
// private 8100xxxxx id range; both are deleted after each test.
//
// T-6221: a save is a PROPOSAL by a signed-in user, served only once
// COUPON_BOX_SAVE_MIN_AGREEING_INSTALLS distinct users proposed the same box.
// `save` is one user's POST; `publish` is enough distinct users' POSTs to
// reach that quorum. Test users are `cbsave-<uuid>@example.com`.

// MOCK (announced): env (the save switch on, the caps adjustable per test; the
// env singleton is parsed once at import), the rate limiter (the concurrency
// case posts several times from one client), and better-auth's session lookup
// (a real one needs a sign-in round trip; the test names the user in the
// `x-test-user` header, and prisma, the FK and every count below are real).
const { envMock, getSessionMock } = vi.hoisted(() => ({
    envMock: {} as Record<string, unknown>,
    getSessionMock: vi.fn(
        async (opts: { headers: Headers }): Promise<unknown> => {
            const id = opts.headers.get('x-test-user')
            return id ? { user: { id }, session: { id: 'itest' } } : null
        },
    ),
}))
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env, { COUPON_BOX_SAVE_ENABLED: true })
    return { ...actual, env: envMock }
})
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

import { POST } from '@/app/api/extension/coupon-box-save/route'
import {
    AUTO_DETECT_CONFIG_MAX_AGE_DAYS,
    AUTO_DETECT_ORIGIN,
    applyCatalogRows,
} from '@/lib/catalog/applyCatalogRows'
import type { IngestCatalogPayload } from '@/lib/catalog/ingestSchemas'
import { recordBoxProposal } from '@/lib/couponBoxSave'
import { VISIBLE_COUPON_STATUSES } from '@/lib/coupons'
import { listSupportedStoreConfigs } from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import {
    getSupportedStoresPayload,
    resetSupportedStoresCache,
} from '@/lib/supportedStoresCache'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const VISIBLE_STATUS = [...VISIBLE_COUPON_STATUSES][0]!

type IngestStoreConfig = IngestCatalogPayload['storeConfigs'][number]

let couponSeq = 0

const newStore = () => `cbsave-${randomUUID().slice(0, 8)}.com`

/** Make `site` a store the catalog knows: one supplier coupon for it. */
async function knownStore(site: string) {
    couponSeq += 1
    const id = `8100${String(couponSeq).padStart(5, '0')}`
    const result = await applyCatalogRows({
        coupons: [
            {
                id,
                code: `CODE-${id}`,
                site,
                title: 't',
                description: 'd',
                rating: 0,
                discount_type: null,
                discount_amount: null,
                expiry: null,
                expired: false,
                times_used: 0,
                last_time_used: null,
                status: VISIBLE_STATUS,
                verification_message: null,
                updated_at: new Date(),
            },
        ],
        storeConfigs: [],
        sources: [],
        force: false,
    })
    expect(result.gated).toBe(false)
}

function pushConfigs(storeConfigs: IngestStoreConfig[]) {
    return applyCatalogRows({
        coupons: [],
        storeConfigs,
        sources: [],
        force: false,
    })
}

const QUORUM = 3

const BOX = {
    input: 'input#promo-code',
    apply: 'button[name="apply_coupon"]',
    toggle: 'button.reveal-promo',
    total: '.order-total',
}

const userIds: string[] = []

async function newUser(): Promise<string> {
    const user = await prisma.user.create({
        data: { email: `cbsave-${randomUUID()}@example.com` },
    })
    userIds.push(user.id)
    return user.id
}

/** One signed-in user's POST (`userId` null = no credential at all). */
function save(
    host: string,
    box: Record<string, unknown> = BOX,
    userId: string | null = defaultUserId,
) {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        origin: EXT_ORIGIN,
    }
    if (userId) headers['x-test-user'] = userId
    return POST(
        new NextRequest('http://localhost/api/extension/coupon-box-save', {
            method: 'POST',
            headers,
            body: JSON.stringify({ host, box }),
        }),
    )
}

/** QUORUM distinct users save the same box; the last answer is returned (the
 * one that publishes it). */
async function publish(host: string, box: Record<string, unknown> = BOX) {
    let last: Response | null = null
    for (let i = 0; i < QUORUM; i++) {
        last = await save(host, box, await newUser())
    }
    if (!last) throw new Error('QUORUM is 0')
    return last
}

async function storedRow(storeName: string) {
    return prisma.storeConfig.findUnique({ where: { storeName } })
}

async function supportedEntry(storeName: string) {
    const { body } = await getSupportedStoresPayload()
    const parsed = JSON.parse(body) as {
        supported: Array<Record<string, unknown>>
    }
    return parsed.supported.find(entry => entry.domain === storeName)
}

let defaultUserId = ''

async function cleanup() {
    await prisma.couponBoxProposal.deleteMany({
        where: { storeName: { contains: 'cbsave-' } },
    })
    await prisma.coupon.deleteMany({ where: { id: { startsWith: '8100' } } })
    await prisma.storeConfig.deleteMany({
        where: { storeName: { contains: 'cbsave-' } },
    })
    resetSupportedStoresCache()
}

beforeAll(async () => {
    defaultUserId = await newUser()
})
beforeEach(() => {
    envMock.COUPON_BOX_SAVE_MIN_AGREEING_INSTALLS = QUORUM
    envMock.COUPON_BOX_SAVE_USER_DAILY_CAP = 10
    envMock.COUPON_BOX_SAVE_STORE_DAILY_CAP = 20
    envMock.COUPON_BOX_SAVE_GLOBAL_DAILY_CAP = 500
})
afterEach(cleanup)
afterAll(async () => {
    await cleanup()
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.$disconnect()
})

describe('coupon-box save: the saved row is served like a pipeline row, marked savedBox', () => {
    it('PAIR: a saved box and a pipeline config with the same selectors come back from supported-stores in the same shape, the saved one marked savedBox', async () => {
        const saved = newStore()
        const pipeline = newStore()
        await knownStore(saved)

        const res = await publish(`www.${saved}`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            saved: true,
            store: saved,
            status: 'published',
        })

        const pushed = await pushConfigs([
            {
                store_name: pipeline,
                coupon_input_xpath: BOX.input,
                apply_button_xpath: BOX.apply,
                show_input_xpath: BOX.toggle,
                price_container_xpath: BOX.total,
            },
        ])
        expect(pushed.gated).toBe(false)
        resetSupportedStoresCache()

        const savedEntry = await supportedEntry(saved)
        const pipelineEntry = await supportedEntry(pipeline)
        expect(savedEntry).toEqual({
            domain: saved,
            couponInput: BOX.input,
            couponSubmit: BOX.apply,
            showInput: BOX.toggle,
            priceContainer: BOX.total,
            savedBox: true,
        })
        // The mark is the only difference: it tells the extension to read the
        // store's answer like a found box's (T-6310).
        expect({ ...savedEntry, domain: null }).toEqual({
            ...pipelineEntry,
            domain: null,
            savedBox: true,
        })

        // The repo read the payload is built from: same columns, same values.
        const rows = await listSupportedStoreConfigs()
        const savedRow = rows.find(r => r.store_name === saved)
        const pipelineRow = rows.find(r => r.store_name === pipeline)
        expect({ ...savedRow, store_name: null, origin: null }).toEqual({
            ...pipelineRow,
            store_name: null,
        })

        // Only `origin` tells them apart; the feed carries it as savedBox.
        expect((await storedRow(saved))?.origin).toBe(AUTO_DETECT_ORIGIN)
        expect((await storedRow(pipeline))?.origin).toBeNull()
    })

    it('an Enter-only box is served with its input as the submit selector', async () => {
        const store = newStore()
        await knownStore(store)

        const res = await publish(`checkout.${store}`, {
            input: '#discount',
            apply: null,
            toggle: null,
            total: '.order-total',
        })
        expect(res.status).toBe(200)

        expect(await supportedEntry(store)).toEqual({
            domain: store,
            couponInput: '#discount',
            couponSubmit: '#discount',
            priceContainer: '.order-total',
            savedBox: true,
        })
        const row = await storedRow(store)
        expect(row).toMatchObject({
            showInputXpath: null,
            dismissButtonXpath: null,
            priceContainerXpath: '.order-total',
            successIndicatorXpath: null,
            errorIndicatorXpath: null,
            couponRemoveXpath: null,
        })
    })
})

describe('coupon-box save: a store with a config refuses it', () => {
    it('PAIR: a served pipeline config is 409 has_config and stays byte-for-byte; the same host with no config saves', async () => {
        const configured = newStore()
        const configless = newStore()
        await knownStore(configured)
        await knownStore(configless)
        await pushConfigs([
            {
                store_name: configured,
                coupon_input_xpath: '//input[@id="code"]',
                apply_button_xpath: '//button[@id="go"]',
                updated_at: new Date('2026-01-01T00:00:00.000Z'),
            },
        ])
        const before = await storedRow(configured)

        const refused = await save(`www.${configured}`)
        expect(refused.status).toBe(409)
        expect(await refused.json()).toEqual({
            saved: false,
            reason: 'has_config',
        })
        expect(await storedRow(configured)).toEqual(before)

        const accepted = await save(`www.${configless}`)
        expect(accepted.status).toBe(200)
    })

    it('a served row written as www.<store> also refuses the save (the extension reads it as the store)', async () => {
        const store = newStore()
        await knownStore(store)
        await pushConfigs([
            {
                store_name: `www.${store}`,
                coupon_input_xpath: '#a',
                apply_button_xpath: '#b',
            },
        ])

        const res = await save(store)
        expect(res.status).toBe(409)
        expect(await storedRow(store)).toBeNull()
        expect(
            await prisma.couponBoxProposal.count({
                where: { storeName: store },
            }),
        ).toBe(0)
    })

    it('an unserved pipeline row (no apply selector) is never overwritten: 409 has_config', async () => {
        const store = newStore()
        await knownStore(store)
        await pushConfigs([
            { store_name: store, coupon_input_xpath: '#only-input' },
        ])

        const res = await publish(store)
        expect(res.status).toBe(409)
        const row = await storedRow(store)
        expect(row?.couponInputXpath).toBe('#only-input')
        expect(row?.applyButtonXpath).toBeNull()
        expect(row?.origin).toBeNull()
    })

    // Calls recordBoxProposal directly: the race is in the database, and
    // requests racing through withRoute's lazy session import are a test-harness
    // artifact (vitest hands some of them the real better-auth module).
    it('the proposals that reach the quorum racing: exactly one publishes, none fails, and one row exists', async () => {
        const store = newStore()
        await knownStore(store)
        const users = await Promise.all(
            Array.from({ length: QUORUM }, () => newUser()),
        )

        const outcomes = await Promise.all(
            users.map(userId =>
                recordBoxProposal({
                    storeName: store,
                    host: store,
                    box: BOX,
                    userId,
                }),
            ),
        )

        expect(outcomes.filter(o => o.kind === 'published')).toHaveLength(1)
        expect(
            outcomes.every(o =>
                ['published', 'pending', 'has_config'].includes(o.kind),
            ),
        ).toBe(true)
        expect(
            await prisma.storeConfig.count({ where: { storeName: store } }),
        ).toBe(1)
    })

    it('a host the catalog does not know is 404 unknown_store and writes nothing', async () => {
        const store = newStore()

        const res = await save(`www.${store}`)
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({
            saved: false,
            reason: 'unknown_store',
        })
        expect(await storedRow(store)).toBeNull()
    })

    it('a subdomain store the catalog knows is saved under its own name, not its parent', async () => {
        const parent = newStore()
        const child = `shop.${parent}`
        await knownStore(parent)
        await knownStore(child)

        const res = await publish(`www.${child}`)
        expect(await res.json()).toEqual({
            saved: true,
            store: child,
            status: 'published',
        })
        expect(await storedRow(parent)).toBeNull()
    })
})

describe('applyCatalogRows: a pipeline push replaces a saved row whole', () => {
    it('PAIR: a pipeline push with an OLDER updated_at replaces every selector (no mixed columns) and clears origin; the same push over a pipeline row is skipped as older', async () => {
        const saved = newStore()
        const pipeline = newStore()
        await knownStore(saved)
        expect((await publish(saved)).status).toBe(200)
        await pushConfigs([
            {
                store_name: pipeline,
                coupon_input_xpath: BOX.input,
                apply_button_xpath: BOX.apply,
                show_input_xpath: BOX.toggle,
                price_container_xpath: BOX.total,
            },
        ])

        const older = new Date('2026-01-01T00:00:00.000Z')
        const push = (storeName: string): IngestStoreConfig => ({
            store_name: storeName,
            coupon_input_xpath: '//input[@name="coupon"]',
            apply_button_xpath: '//button[@name="apply"]',
            success_indicator_xpath: '//div[@class="ok"]',
            // show_input / price_container: absent (no opinion). On a
            // pipeline row that keeps the stored value; on a saved row the
            // pipeline config replaces the whole box, so they become NULL.
            dismiss_button_xpath: '',
            updated_at: older,
        })
        await pushConfigs([push(saved), push(pipeline)])

        expect(await storedRow(saved)).toMatchObject({
            couponInputXpath: '//input[@name="coupon"]',
            applyButtonXpath: '//button[@name="apply"]',
            successIndicatorXpath: '//div[@class="ok"]',
            showInputXpath: null,
            priceContainerXpath: null,
            dismissButtonXpath: null,
            errorIndicatorXpath: null,
            couponRemoveXpath: null,
            origin: null,
            updatedAt: older,
        })

        // The pipeline row's updated_at is newer than the push: untouched.
        expect(await storedRow(pipeline)).toMatchObject({
            couponInputXpath: BOX.input,
            applyButtonXpath: BOX.apply,
            showInputXpath: BOX.toggle,
            priceContainerXpath: BOX.total,
            successIndicatorXpath: null,
            origin: null,
        })
    })

    it('once replaced, the store is a pipeline store: the only-if-newer rule applies again and no save is accepted', async () => {
        const store = newStore()
        await knownStore(store)
        expect((await publish(store)).status).toBe(200)
        await pushConfigs([
            {
                store_name: store,
                coupon_input_xpath: '#p1',
                apply_button_xpath: '#a1',
                updated_at: new Date('2026-05-01T00:00:00.000Z'),
            },
        ])
        await pushConfigs([
            {
                store_name: store,
                coupon_input_xpath: '#p0',
                apply_button_xpath: '#a0',
                updated_at: new Date('2026-04-01T00:00:00.000Z'),
            },
        ])

        expect(await storedRow(store)).toMatchObject({
            couponInputXpath: '#p1',
            applyButtonXpath: '#a1',
            origin: null,
        })
        expect((await save(store)).status).toBe(409)
    })
})

describe('coupon-box save: a saved box expires', () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS)

    async function backdate(storeName: string, updatedAt: Date) {
        await prisma.storeConfig.update({
            where: { storeName },
            data: { updatedAt },
        })
        resetSupportedStoresCache()
    }

    it('PAIR: a saved box older than the max age is no longer served; one just inside it still is', async () => {
        const expired = newStore()
        const fresh = newStore()
        await knownStore(expired)
        await knownStore(fresh)
        expect((await publish(expired)).status).toBe(200)
        expect((await publish(fresh)).status).toBe(200)

        await backdate(expired, daysAgo(AUTO_DETECT_CONFIG_MAX_AGE_DAYS + 1))
        await backdate(fresh, daysAgo(AUTO_DETECT_CONFIG_MAX_AGE_DAYS - 1))

        expect(await supportedEntry(expired)).toBeUndefined()
        expect(await supportedEntry(fresh)).toBeDefined()
        const names = (await listSupportedStoreConfigs()).map(r => r.store_name)
        expect(names).not.toContain(expired)
        expect(names).toContain(fresh)
    })

    it('an expired saved box is replaced whole by the next proven save', async () => {
        const store = newStore()
        await knownStore(store)
        expect((await publish(store)).status).toBe(200)
        await backdate(store, daysAgo(AUTO_DETECT_CONFIG_MAX_AGE_DAYS + 5))

        const res = await publish(`www.${store}`, {
            input: '#new-code',
            apply: null,
            toggle: null,
            total: '.new-total',
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            saved: true,
            store,
            status: 'published',
        })

        const row = await storedRow(store)
        expect(row).toMatchObject({
            couponInputXpath: '#new-code',
            applyButtonXpath: '#new-code',
            showInputXpath: null,
            priceContainerXpath: '.new-total',
            origin: AUTO_DETECT_ORIGIN,
        })
        expect(row!.updatedAt.getTime()).toBeGreaterThan(Date.now() - DAY_MS)
        expect(await supportedEntry(store)).toEqual({
            domain: store,
            couponInput: '#new-code',
            couponSubmit: '#new-code',
            priceContainer: '.new-total',
            savedBox: true,
        })
    })

    it('a saved box still inside the max age refuses a second save and is not touched', async () => {
        const store = newStore()
        await knownStore(store)
        expect((await publish(store)).status).toBe(200)
        await backdate(store, daysAgo(AUTO_DETECT_CONFIG_MAX_AGE_DAYS - 1))
        const before = await storedRow(store)

        const res = await save(store, { ...BOX, input: '#other' })
        expect(res.status).toBe(409)
        expect(await storedRow(store)).toEqual(before)
    })

    it('RENEWAL: after the box and its proposals age out, the same users saving the same box again re-publish it', async () => {
        const store = newStore()
        await knownStore(store)
        const users = await Promise.all(
            Array.from({ length: QUORUM }, () => newUser()),
        )
        const saveAll = async () => {
            const answers: Response[] = []
            for (const id of users) answers.push(await save(store, BOX, id))
            return answers
        }
        const first = await saveAll()
        expect(await first[QUORUM - 1]!.json()).toMatchObject({
            status: 'published',
        })

        // Everything ages past the max age: the served config and every
        // user's proposal.
        const aged = daysAgo(AUTO_DETECT_CONFIG_MAX_AGE_DAYS + 1)
        await backdate(store, aged)
        await prisma.couponBoxProposal.updateMany({
            where: { storeName: store },
            data: { createdAt: aged },
        })
        expect(await supportedEntry(store)).toBeUndefined()

        // The same users, the same box (the same hash): each save renews its
        // row, and the last one is the quorum again.
        const again = await saveAll()
        expect(await Promise.all(again.map(r => r.json()))).toMatchObject([
            { status: 'pending' },
            { status: 'pending' },
            { status: 'published' },
        ])
        resetSupportedStoresCache()
        expect(await supportedEntry(store)).toMatchObject({
            domain: store,
            savedBox: true,
        })
        expect(
            await prisma.couponBoxProposal.count({
                where: { storeName: store },
            }),
        ).toBe(QUORUM)
    })

    it('the max age never applies to a pipeline row: a two-year-old pipeline config is served and refuses a save', async () => {
        const store = newStore()
        await knownStore(store)
        await pushConfigs([
            {
                store_name: store,
                coupon_input_xpath: '//input[@id="code"]',
                apply_button_xpath: '//button[@id="go"]',
                updated_at: daysAgo(730),
            },
        ])
        resetSupportedStoresCache()

        expect(await supportedEntry(store)).toBeDefined()
        const before = await storedRow(store)
        expect((await save(store)).status).toBe(409)
        expect(await storedRow(store)).toEqual(before)
    })
})

describe('applyCatalogRows: pipeline-on-pipeline upserts are unchanged', () => {
    it('newer push: a NULL keeps the stored selector, an empty string clears it, a value replaces it; an older push is skipped', async () => {
        const store = newStore()
        await pushConfigs([
            {
                store_name: store,
                coupon_input_xpath: '#in-1',
                apply_button_xpath: '#ap-1',
                show_input_xpath: '#show-1',
                price_container_xpath: '#price-1',
                updated_at: new Date('2026-03-01T00:00:00.000Z'),
            },
        ])
        await pushConfigs([
            {
                store_name: store,
                coupon_input_xpath: '#in-2',
                apply_button_xpath: null,
                show_input_xpath: '',
                updated_at: new Date('2026-03-02T00:00:00.000Z'),
            },
        ])
        expect(await storedRow(store)).toMatchObject({
            couponInputXpath: '#in-2',
            applyButtonXpath: '#ap-1',
            showInputXpath: null,
            priceContainerXpath: '#price-1',
            origin: null,
        })

        await pushConfigs([
            {
                store_name: store,
                coupon_input_xpath: '#in-old',
                apply_button_xpath: '#ap-old',
                updated_at: new Date('2026-03-01T12:00:00.000Z'),
            },
        ])
        expect(await storedRow(store)).toMatchObject({
            couponInputXpath: '#in-2',
            applyButtonXpath: '#ap-1',
            updatedAt: new Date('2026-03-02T00:00:00.000Z'),
        })
    })
})

describe('coupon-box save: a proposal is quarantined until distinct users agree (T-6221)', () => {
    it('PAIR: one fewer than the quorum is recorded and NOT served; the quorum-th save serves it', async () => {
        const store = newStore()
        await knownStore(store)

        for (let i = 0; i < QUORUM - 1; i++) {
            const res = await save(store, BOX, await newUser())
            expect(res.status).toBe(200)
            expect(await res.json()).toMatchObject({ status: 'pending' })
        }
        resetSupportedStoresCache()
        expect(await storedRow(store)).toBeNull()
        expect(await supportedEntry(store)).toBeUndefined()

        const last = await save(store, BOX, await newUser())
        expect(await last.json()).toMatchObject({ status: 'published' })
        resetSupportedStoresCache()
        expect(await supportedEntry(store)).toMatchObject({
            domain: store,
            savedBox: true,
        })
    })

    it('one user repeating the same save never reaches the quorum', async () => {
        const store = newStore()
        await knownStore(store)

        for (let i = 0; i < QUORUM + 2; i++) await save(store)

        expect(await storedRow(store)).toBeNull()
        expect(
            await prisma.couponBoxProposal.count({
                where: { storeName: store },
            }),
        ).toBe(1)
    })

    it('a pending box from one squatter does not block the box real installs agree on', async () => {
        const store = newStore()
        await knownStore(store)
        const squat = await save(store, { ...BOX, input: '#squat' })
        expect(squat.status).toBe(200)

        const real = await publish(store)

        expect(await real.json()).toMatchObject({ status: 'published' })
        expect((await storedRow(store))?.couponInputXpath).toBe(BOX.input)
    })

    it('a request with no credential is 401 and writes nothing', async () => {
        const store = newStore()
        await knownStore(store)

        const res = await save(store, BOX, null)

        expect(res.status).toBe(401)
        expect(
            await prisma.couponBoxProposal.count({
                where: { storeName: store },
            }),
        ).toBe(0)
    })
})

describe('coupon-box save: the daily write budget (T-6221)', () => {
    it('the per-user cap: the user at the cap is 429 user_budget and writes nothing more', async () => {
        envMock.COUPON_BOX_SAVE_USER_DAILY_CAP = 1
        const first = newStore()
        const second = newStore()
        await knownStore(first)
        await knownStore(second)
        const user = await newUser()

        expect((await save(first, BOX, user)).status).toBe(200)
        const over = await save(second, BOX, user)

        expect(over.status).toBe(429)
        expect(await over.json()).toEqual({
            saved: false,
            reason: 'user_budget',
        })
        expect(
            await prisma.couponBoxProposal.count({ where: { userId: user } }),
        ).toBe(1)
    })

    it('the per-store cap: another user is 429 store_budget on that store', async () => {
        envMock.COUPON_BOX_SAVE_STORE_DAILY_CAP = 1
        const store = newStore()
        await knownStore(store)

        expect((await save(store, BOX, await newUser())).status).toBe(200)
        const over = await save(store, BOX, await newUser())

        expect(over.status).toBe(429)
        expect(await over.json()).toEqual({
            saved: false,
            reason: 'store_budget',
        })
    })
})
