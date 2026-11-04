import {
    STORE_CONFIG_SKIPPED_NAME_LIMIT,
    applyCatalogRows,
} from '@/lib/catalog/applyCatalogRows'
import type { IngestCatalogPayload } from '@/lib/catalog/ingestSchemas'
import {
    type MockInstance,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

// Pins the store_configs only-if-newer REPORTING (T-10679). The upsert keeps a
// pushed config out when the stored row's updated_at is newer; before this the
// push still answered ok and nobody could see the skip without reading the
// database (2026-10-30: a corrected config stayed unapplied for about an hour).
// The upsert now ends in `RETURNING store_name`, and every offered store that
// is NOT returned is reported as skipped: counted, named (capped) in the result
// and logged once per push.
//
// The transaction is mocked so no DB is touched. The mock $queryRaw plays
// Postgres: it returns the pushed store names bound into the INSERT, minus the
// ones the test marks as "stored row is newer" (the rows the ON CONFLICT WHERE
// would keep out). The composed SQL is captured and asserted on. No coupons are
// pushed, so the store_configs INSERT is the only $queryRaw call.

type Captured = { sql: string; values: unknown[] }

const { txMock, captured, state } = vi.hoisted(() => {
    const captured: Captured[] = []
    const state = {
        pushedNames: new Set<string>(),
        storedNewer: new Set<string>(),
    }
    const txMock = {
        $queryRaw: vi.fn(async (arg: Captured) => {
            captured.push({ sql: arg.sql, values: arg.values })
            return arg.values
                .filter(
                    (v): v is string =>
                        typeof v === 'string' &&
                        state.pushedNames.has(v) &&
                        !state.storedNewer.has(v),
                )
                .map(store_name => ({ store_name }))
        }),
        coupon: { count: vi.fn(async () => 0) },
        $executeRaw: vi.fn(async () => 0),
    }
    return { txMock, captured, state }
})

vi.mock('@/lib/prisma', () => ({
    default: {
        $transaction: (fn: (tx: typeof txMock) => Promise<unknown>) =>
            fn(txMock),
    },
}))

type IngestStoreConfig = IngestCatalogPayload['storeConfigs'][number]

function storeConfig(storeName: string): IngestStoreConfig {
    return {
        store_name: storeName,
        coupon_input_xpath: '//input[@name="promo"]',
        apply_button_xpath: '//button[@id="apply"]',
        updated_at: new Date('2026-10-30T09:00:00.000Z'),
    }
}

function push(storeConfigs: IngestStoreConfig[], storedNewer: string[] = []) {
    state.pushedNames = new Set(storeConfigs.map(s => s.store_name))
    state.storedNewer = new Set(storedNewer)
    return applyCatalogRows({
        coupons: [],
        storeConfigs,
        sources: [],
        force: false,
    })
}

type WarnSpy = MockInstance<typeof console.warn>

function skippedOlderWarnings(warn: WarnSpy): string[] {
    return warn.mock.calls
        .map(call => String(call[0]))
        .filter(line => line.includes('storeConfigsSkippedOlder='))
}

let warnSpy: WarnSpy

beforeEach(() => {
    captured.length = 0
    txMock.$queryRaw.mockClear()
    txMock.$executeRaw.mockClear()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('applyCatalogRows — store configs kept out by only-if-newer are reported', () => {
    it('counts and names a store whose stored config is newer, and still writes the rest', async () => {
        const result = await push(
            [storeConfig('gorjana.com'), storeConfig('ebay.com')],
            ['gorjana.com'],
        )

        expect(result.gated).toBe(false)
        expect(result.storeConfigs).toEqual({
            upserted: 2,
            skippedOlder: 1,
            skippedOlderStoreNames: ['gorjana.com'],
        })

        const insert = captured.find(c =>
            c.sql.includes('INSERT INTO store_configs'),
        )
        expect(insert).toBeDefined()
        // The guard is unchanged; only the RETURNING that exposes it is new.
        expect(insert!.sql).toContain(
            'WHERE excluded.updated_at >= store_configs.updated_at',
        )
        expect(insert!.sql).toContain('RETURNING store_name')
        expect(txMock.$executeRaw).not.toHaveBeenCalled()
    })

    it('logs one warning per push naming the skipped stores', async () => {
        await push(
            [
                storeConfig('gorjana.com'),
                storeConfig('ebay.com'),
                storeConfig('mikasa.com'),
            ],
            ['gorjana.com', 'mikasa.com'],
        )

        expect(skippedOlderWarnings(warnSpy)).toEqual([
            '[ingest/catalog] storeConfigsSkippedOlder=2: the stored config is newer than the pushed updated_at, so these were not written (resend with a fresh updated_at): gorjana.com,mikasa.com',
        ])
    })

    it('reports zero and logs nothing when every pushed config is written', async () => {
        const result = await push([
            storeConfig('gorjana.com'),
            storeConfig('ebay.com'),
        ])

        expect(result.storeConfigs).toEqual({
            upserted: 2,
            skippedOlder: 0,
            skippedOlderStoreNames: [],
        })
        expect(skippedOlderWarnings(warnSpy)).toEqual([])
    })

    it('caps the returned and logged names but keeps the full count', async () => {
        const names = Array.from(
            { length: STORE_CONFIG_SKIPPED_NAME_LIMIT + 5 },
            (_, i) => `store-${String(i).padStart(2, '0')}.com`,
        )
        const result = await push(names.map(storeConfig), names)

        expect(result.storeConfigs.skippedOlder).toBe(names.length)
        expect(result.storeConfigs.skippedOlderStoreNames).toEqual(
            names.slice(0, STORE_CONFIG_SKIPPED_NAME_LIMIT),
        )
        const [line] = skippedOlderWarnings(warnSpy)
        expect(line).toContain(`storeConfigsSkippedOlder=${names.length}: `)
        expect(line).toContain(
            names.slice(0, STORE_CONFIG_SKIPPED_NAME_LIMIT).join(','),
        )
        expect(line).not.toContain(names[STORE_CONFIG_SKIPPED_NAME_LIMIT])
        expect(line!.endsWith('… (+5 more)')).toBe(true)
    })

    it('a store pushed twice in one batch is offered, and reported, once', async () => {
        const result = await push(
            [storeConfig('gorjana.com'), storeConfig('gorjana.com')],
            ['gorjana.com'],
        )

        expect(result.storeConfigs).toEqual({
            upserted: 1,
            skippedOlder: 1,
            skippedOlderStoreNames: ['gorjana.com'],
        })
    })
})
