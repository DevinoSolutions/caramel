import CouponsPage, { metadata } from '@/app/(marketing)/coupons/page'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// SEO (2026-07-30) — /coupons used to ship a client-only list: crawlers got a
// loading spinner and zero coupon content. The page now server-renders the
// same first page /api/coupons would return (plus ItemList JSON-LD), so this
// suite pins the SSR wiring the same way coupons-store-page.test.ts does for
// the store page: mocked `@/lib/prisma` $queryRaw keyed on the composed
// `.sql`, CouponsSection stubbed out, the returned element tree inspected
// directly (never DOM-rendered).

type MockRule = { match: (sql: string) => boolean; rows: unknown[] }
let rules: MockRule[] = []
function mockRows(match: (sql: string) => boolean, rows: unknown[]) {
    rules.push({ match, rows })
}

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (arg: { sql: string }) => {
            const rows = rules.find(r => r.match(arg.sql))?.rows ?? []
            return Promise.resolve(rows)
        },
        couponSignal: { findMany: vi.fn(async () => []) },
    },
}))

vi.mock('@/components/coupons/coupons-section', () => ({
    default: () => null,
}))

beforeEach(() => {
    rules = []
})

const couponFixture = {
    id: 42,
    code: 'SAVE10',
    site: 'example.com',
    title: 'Save 10% at Example',
    description: '10% off your order',
    rating: '4.5',
    discount_type: 'PERCENTAGE',
    discount_amount: '10',
    expiry: '2026-12-31',
    expired: false,
    timesUsed: 5,
    status: 'valid',
    verificationMessage: null,
}

describe('CouponsPage (/coupons index) — server-rendered first page', () => {
    it('passes the first catalog page into CouponsSection and mirrors it in ItemList JSON-LD', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [couponFixture],
        )
        mockRows(sql => sql.includes('COUNT(*)::int AS total'), [{ total: 9 }])

        const mainEl = (await CouponsPage()) as ReactElement<{
            children: ReactElement[]
        }>
        const children = mainEl.props.children

        const couponsSectionEl = children[0] as ReactElement<{
            initialCoupons: Array<Record<string, unknown>>
            initialTotal: number
            disableInitialFetch: boolean
        }>
        expect(couponsSectionEl.props.disableInitialFetch).toBe(true)
        expect(couponsSectionEl.props.initialTotal).toBe(9)
        expect(couponsSectionEl.props.initialCoupons).toEqual([
            {
                ...couponFixture,
                id: '42',
                rating: 4.5,
                discount_amount: 10,
                lastWorkedAt: null,
            },
        ])

        const scriptEl = children.find(
            (
                c,
            ): c is ReactElement<{
                dangerouslySetInnerHTML: { __html: string }
            }> => (c as ReactElement)?.type === 'script',
        )
        const structuredData = JSON.parse(
            // oxlint-disable-next-line no-underscore-dangle -- React's own prop name
            scriptEl!.props.dangerouslySetInnerHTML.__html,
        )
        expect(structuredData['@type']).toBe('ItemList')
        expect(structuredData.numberOfItems).toBe(9)
        expect(structuredData.itemListElement).toHaveLength(1)
        expect(structuredData.itemListElement[0].name).toBe(couponFixture.title)
    })

    it('metadata leads with the query users type, not the brand', () => {
        expect(String(metadata.title)).toMatch(/^Coupon Codes & Promo Codes/)
        expect(metadata.alternates?.canonical).toBe(
            'https://grabcaramel.com/coupons',
        )
    })
})
