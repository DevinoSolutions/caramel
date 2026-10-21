import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// POST /api/extension/coupon-box-save against the REAL prisma client and a
// live Postgres (the harness runs `prisma migrate deploy` first). Proves the
// contract's golden rules where only the database can: a saved row comes back
// from GET /api/extension/supported-stores exactly like a pipeline row, a
// store with a config refuses the save, a later pipeline push replaces a
// saved row whole (whatever its updated_at), and pipeline-on-pipeline upserts
// behave as before. Test stores are `cbsave-<uuid>.com`, test coupons use the
// private 8100xxxxx id range; both are deleted after each test.

// MOCK (announced): env (the save switch on; the env singleton is parsed
// once at import) and the rate limiter (the concurrency case posts twice from
// one client).
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    return {
        ...actual,
        env: { ...actual.env, COUPON_BOX_SAVE_ENABLED: true },
    }
})
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

import { POST } from '@/app/api/extension/coupon-box-save/route'
import {
    AUTO_DETECT_ORIGIN,
    applyCatalogRows,
} from '@/lib/catalog/applyCatalogRows'
import type { IngestCatalogPayload } from '@/lib/catalog/ingestSchemas'
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

const BOX = {
    input: 'input#promo-code',
    apply: 'button[name="apply_coupon"]',
    toggle: 'button.reveal-promo',
    total: '.order-total',
}

function save(host: string, box: Record<string, unknown> = BOX) {
    return POST(
        new NextRequest('http://localhost/api/extension/coupon-box-save', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: EXT_ORIGIN },
            body: JSON.stringify({ host, box }),
        }),
    )
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

async function cleanup() {
    await prisma.coupon.deleteMany({ where: { id: { startsWith: '8100' } } })
    await prisma.storeConfig.deleteMany({
        where: { storeName: { contains: 'cbsave-' } },
    })
    resetSupportedStoresCache()
}

afterEach(cleanup)
afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
})

describe('coupon-box save: the saved row is served like a pipeline row', () => {
    it('PAIR: a saved box and a pipeline config with the same selectors come back from supported-stores in exactly the same shape', async () => {
        const saved = newStore()
        const pipeline = newStore()
        await knownStore(saved)

        // Warm the cache first: the save must drop it.
        await getSupportedStoresPayload()

        const res = await save(`www.${saved}`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ saved: true, store: saved })

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
        })
        expect({ ...savedEntry, domain: null }).toEqual({
            ...pipelineEntry,
            domain: null,
        })

        // The repo read the payload is built from: same columns, same values.
        const rows = await listSupportedStoreConfigs()
        const savedRow = rows.find(r => r.store_name === saved)
        const pipelineRow = rows.find(r => r.store_name === pipeline)
        expect({ ...savedRow, store_name: null }).toEqual({
            ...pipelineRow,
            store_name: null,
        })

        // Only `origin` tells them apart, and it never leaves the database.
        expect((await storedRow(saved))?.origin).toBe(AUTO_DETECT_ORIGIN)
        expect((await storedRow(pipeline))?.origin).toBeNull()
    })

    it('an Enter-only box is served with its input as the submit selector', async () => {
        const store = newStore()
        await knownStore(store)

        const res = await save(`checkout.${store}`, {
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
    })

    it('an unserved pipeline row (no apply selector) is never overwritten: 409 has_config', async () => {
        const store = newStore()
        await knownStore(store)
        await pushConfigs([
            { store_name: store, coupon_input_xpath: '#only-input' },
        ])

        const res = await save(store)
        expect(res.status).toBe(409)
        const row = await storedRow(store)
        expect(row?.couponInputXpath).toBe('#only-input')
        expect(row?.applyButtonXpath).toBeNull()
        expect(row?.origin).toBeNull()
    })

    it('two saves racing for one store: exactly one wins, the other is has_config', async () => {
        const store = newStore()
        await knownStore(store)

        const answers = await Promise.all([
            save(store),
            save(`www.${store}`, { ...BOX, input: '#other-input' }),
        ])
        expect(answers.map(r => r.status).sort()).toEqual([200, 409])
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

        const res = await save(`www.${child}`)
        expect(await res.json()).toEqual({ saved: true, store: child })
        expect(await storedRow(parent)).toBeNull()
    })
})

describe('applyCatalogRows: a pipeline push replaces a saved row whole', () => {
    it('PAIR: a pipeline push with an OLDER updated_at replaces every selector (no mixed columns) and clears origin; the same push over a pipeline row is skipped as older', async () => {
        const saved = newStore()
        const pipeline = newStore()
        await knownStore(saved)
        expect((await save(saved)).status).toBe(200)
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
        expect((await save(store)).status).toBe(200)
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
