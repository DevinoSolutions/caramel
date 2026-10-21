import {
    getSupportedStoresPayload,
    resetSupportedStoresCache,
} from '@/lib/supportedStoresCache'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A reset must win over a rebuild that was already running when it landed.
// One rebuild takes seconds in prod (supportedStoresCache.ts header), so a
// reset arriving mid-build is the ordinary case, not an edge. Before the
// generation counter, the in-flight build finished AFTER the reset and wrote
// the rows it had read BEFORE it into the cache, so the change the reset was
// for stayed invisible for a full TTL.
//
// The coupon-box save route no longer resets the cache at all (an anonymous
// caller could force one multi-second rebuild per accepted save); that is
// pinned in coupon-box-save-route.test.ts. The reset is still used by the
// catalog writers, which is what this pin protects.

// MOCK (announced): prisma.$queryRaw is the SELECT the rebuild runs.
const { queryRawMock } = vi.hoisted(() => ({ queryRawMock: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ default: { $queryRaw: queryRawMock } }))

const row = (store: string) => ({
    store_name: store,
    show_input_xpath: null,
    dismiss_button_xpath: null,
    coupon_input_xpath: '#promo',
    apply_button_xpath: '#promo',
    price_container_xpath: '.total',
    success_indicator_xpath: null,
    error_indicator_xpath: null,
    coupon_remove_xpath: null,
})

const domainsOf = (body: string) =>
    (JSON.parse(body) as { supported: { domain: string }[] }).supported.map(
        e => e.domain,
    )

beforeEach(() => {
    resetSupportedStoresCache()
    queryRawMock.mockReset()
    queryRawMock.mockResolvedValue([row('a.com')])
})

describe('supported-stores cache: a reset during a rebuild', () => {
    it('the build that started before the reset is not cached; the next read sees the new row', async () => {
        const t0 = 2_000_000
        let finishOldBuild: (rows: unknown) => void = () => {}
        queryRawMock.mockImplementationOnce(
            () => new Promise(resolve => (finishOldBuild = resolve)),
        )
        const inFlight = getSupportedStoresPayload(t0)
        resetSupportedStoresCache()
        queryRawMock.mockResolvedValue([row('a.com'), row('saved.com')])
        finishOldBuild([row('a.com')])
        // The caller that started the old build still gets an answer.
        expect(domainsOf((await inFlight).body)).toEqual(['a.com'])

        const next = await getSupportedStoresPayload(t0 + 10)
        expect(domainsOf(next.body)).toContain('saved.com')
    })

    it('without a reset, concurrent reads share one build and the result is cached for the TTL', async () => {
        const t0 = 3_000_000
        const [a, b] = await Promise.all([
            getSupportedStoresPayload(t0),
            getSupportedStoresPayload(t0),
        ])
        expect(a.body).toBe(b.body)
        await getSupportedStoresPayload(t0 + 60_000)
        expect(queryRawMock).toHaveBeenCalledTimes(1)
    })
})
