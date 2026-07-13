import StoreCouponsPage from '@/app/(marketing)/coupons/[store]/page'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F-001 — (marketing)/coupons/[store]/page.tsx is the 9th read site: an SSR
// page (not a route handler), so it's exercised by calling the default
// export directly and inspecting the returned (unrendered) React element
// tree rather than rendering to a DOM. CouponsSection ('use client';
// framer-motion, next/image, react-infinite-scroll-component, ...) is
// mocked out so importing page.tsx doesn't drag that whole client-component
// tree into a plain `environment: 'node'` vitest run — React.createElement
// never invokes the component function, so the mock's body is irrelevant
// and its captured props are inspectable without ever calling render().

type MockRule = { match: (sql: string) => boolean; rows: unknown[] }
let rules: MockRule[] = []
function mockRows(match: (sql: string) => boolean, rows: unknown[]) {
    rules.push({ match, rows })
}

vi.mock('@/lib/couponsDb', async () => {
    const actual =
        await vi.importActual<typeof import('@/lib/couponsDb')>(
            '@/lib/couponsDb',
        )
    return {
        ...actual,
        couponsSql: (strings: TemplateStringsArray, ..._values: unknown[]) => {
            const sql = strings.join('?')
            const rows = rules.find(r => r.match(sql))?.rows ?? []
            return {
                // oxlint-disable-next-line no-thenable
                then: (resolve: (rows: unknown[]) => void) => resolve(rows),
            }
        },
    }
})

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

describe('StoreCouponsPage — CouponListRow + TotalCountRow', () => {
    it('parses production-shaped rows into both the CouponsSection props and the structured-data script', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [couponFixture],
        )
        mockRows(sql => sql.includes('COUNT(*)::int AS total'), [{ total: 1 }])

        const mainEl = (await StoreCouponsPage({
            params: { store: 'example.com' },
        })) as ReactElement<{ children: ReactElement[] }>

        const children = mainEl.props.children
        const scriptEl = children.find(
            (
                c,
            ): c is ReactElement<{
                dangerouslySetInnerHTML: { __html: string }
            }> => (c as ReactElement)?.type === 'script',
        )
        const couponsSectionEl = children.find(
            c => (c as ReactElement)?.type !== 'script',
        ) as ReactElement<{
            initialCoupons: Array<Record<string, unknown>>
            initialTotal: number
        }>

        // Coercion proof: the numeric-string rating/discount_amount and the
        // int4-number id all normalized correctly, flowing all the way into
        // the props the client component receives.
        expect(couponsSectionEl.props.initialCoupons).toEqual([
            { ...couponFixture, id: '42', rating: 4.5, discount_amount: 10 },
        ])
        expect(couponsSectionEl.props.initialTotal).toBe(1)

        // oxlint-disable-next-line no-underscore-dangle -- React's own prop name
        const structuredData = JSON.parse(
            scriptEl!.props.dangerouslySetInnerHTML.__html,
        )
        expect(structuredData.numberOfItems).toBe(1)
        expect(structuredData.itemListElement).toEqual([
            {
                '@type': 'ListItem',
                position: 1,
                url: 'https://grabcaramel.com/coupons/example.com',
                name: couponFixture.title,
                description: couponFixture.description,
            },
        ])
    })

    it('an invalid store slug (fails getBaseDomain) short-circuits to zero coupons without ever querying couponsSql', async () => {
        // No mockRows() rules registered — any couponsSql call here would
        // return [] per the mock's fallback, but if the drift-detecting
        // parse actually ran on an empty page it wouldn't prove the
        // short-circuit; asserting rows stay empty and total is 0 for a
        // slug that fails getBaseDomain's hostname regex is the real proof.
        const mainEl = (await StoreCouponsPage({
            params: { store: '!!!not-a-domain!!!' },
        })) as ReactElement<{ children: ReactElement[] }>

        const couponsSectionEl = mainEl.props.children.find(
            c => (c as ReactElement)?.type !== 'script',
        ) as ReactElement<{ initialCoupons: unknown[]; initialTotal: number }>

        expect(couponsSectionEl.props.initialCoupons).toEqual([])
        expect(couponsSectionEl.props.initialTotal).toBe(0)
    })
})
