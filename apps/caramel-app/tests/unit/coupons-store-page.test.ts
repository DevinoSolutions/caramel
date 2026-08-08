import StoreCouponsPage, {
    generateMetadata,
} from '@/app/(marketing)/coupons/[store]/page'
import { BASE_URL } from '@/lib/env.client'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F-001 — (marketing)/coupons/[store]/page.tsx is the 9th read site: an SSR
// page (not a route handler), so it's exercised by calling the default
// export directly and inspecting the returned (unrendered) React element
// tree rather than rendering to a DOM. CouponsSection ('use client';
// framer-motion, next/image, ...) is mocked out so importing page.tsx doesn't
// drag that whole client-component tree into a plain `environment: 'node'`
// run.
//
// W4 — listStoreCoupons runs on the app's Prisma catalog via
// `prisma.$queryRaw(Prisma.sql`...`)`, so `@/lib/prisma` is mocked: `$queryRaw`
// is a rule-based resolver keyed on the composed `.sql`, and couponSignal is
// stubbed for attachSignals (no signals → lastWorkedAt:null).

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
            {
                ...couponFixture,
                id: '42',
                rating: 4.5,
                discount_amount: 10,
                // attachSignals merges this on; no seeded signal → null.
                lastWorkedAt: null,
            },
        ])
        expect(couponsSectionEl.props.initialTotal).toBe(1)

        // AEO prose (2026-07-28): the page also server-renders a visible
        // "How Caramel finds …" section whose count is the SAME `total` the
        // list uses — assert it exists, states the live count, and renders no
        // fabricated freshness date (no verification timestamp exists in the
        // row data, so none may appear).
        const proseEl = children.find(
            c => (c as ReactElement)?.type === 'section',
        )
        expect(proseEl).toBeTruthy()
        const proseJson = JSON.stringify(proseEl)
        expect(proseJson).toContain('How Caramel finds ')
        expect(proseJson).toContain('1 active coupon code')
        expect(proseJson).not.toMatch(/last verified|verified on/i)

        // oxlint-disable-next-line no-underscore-dangle -- React's own prop name
        const structuredData = JSON.parse(
            scriptEl!.props.dangerouslySetInnerHTML.__html,
        )
        expect(structuredData.numberOfItems).toBe(1)
        // url is built from BASE_URL (env.client), which Vitest resolves from
        // the loaded .env locally (http://localhost:58000) but defaults to
        // https://grabcaramel.com in CI where no .env exists — assert against
        // the same resolved BASE_URL the page uses so the pin is env-agnostic.
        expect(structuredData.itemListElement).toEqual([
            {
                '@type': 'ListItem',
                position: 1,
                url: `${BASE_URL}/coupons/example.com`,
                name: couponFixture.title,
                description: couponFixture.description,
            },
        ])
    })

    it('an invalid store slug (fails getBaseDomain) short-circuits to zero coupons without ever querying the catalog', async () => {
        // No mockRows() rules registered — any $queryRaw call here would
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

    it('renders a BreadcrumbList script alongside the ItemList (second ld+json)', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [couponFixture],
        )
        mockRows(sql => sql.includes('COUNT(*)::int AS total'), [{ total: 1 }])

        const mainEl = (await StoreCouponsPage({
            params: { store: 'example.com' },
        })) as ReactElement<{ children: ReactElement[] }>

        const scripts = mainEl.props.children.filter(
            (
                c,
            ): c is ReactElement<{
                dangerouslySetInnerHTML: { __html: string }
            }> => (c as ReactElement)?.type === 'script',
        )
        expect(scripts).toHaveLength(2)
        const breadcrumb = JSON.parse(
            // oxlint-disable-next-line no-underscore-dangle -- React's own prop name
            scripts[1]!.props.dangerouslySetInnerHTML.__html,
        )
        expect(breadcrumb['@type']).toBe('BreadcrumbList')
        expect(breadcrumb.itemListElement).toHaveLength(3)
        expect(breadcrumb.itemListElement[1].item).toBe(`${BASE_URL}/coupons`)
        // The final crumb is the current page: name only, no `item` URL.
        expect(breadcrumb.itemListElement[2].item).toBeUndefined()
    })

    it('with zero coupons the prose section says so honestly instead of inventing a count', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [],
        )
        mockRows(sql => sql.includes('COUNT(*)::int AS total'), [{ total: 0 }])

        const mainEl = (await StoreCouponsPage({
            params: { store: 'example.com' },
        })) as ReactElement<{ children: ReactElement[] }>

        const proseEl = mainEl.props.children.find(
            c => (c as ReactElement)?.type === 'section',
        )
        const proseJson = JSON.stringify(proseEl)
        expect(proseJson).toContain('has no active coupon codes')
        expect(proseJson).not.toContain('currently lists')
    })
})

describe('StoreCouponsPage generateMetadata — canonical normalization + thin-page noindex', () => {
    it('canonicalizes every slug variant to the base-domain URL (www.example.com → example.com)', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [couponFixture],
        )
        mockRows(sql => sql.includes('COUNT(*)::int AS total'), [{ total: 1 }])

        const metadata = await generateMetadata({
            params: { store: 'www.example.com' },
        })

        expect(metadata.alternates?.canonical).toBe(
            `${BASE_URL}/coupons/example.com`,
        )
        expect(metadata.openGraph?.url).toBe(`${BASE_URL}/coupons/example.com`)
        // A store WITH coupons is indexable — no robots override.
        expect(metadata.robots).toBeUndefined()
    })

    it('noindexes (but still follows) a store page with zero visible coupons', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [],
        )
        mockRows(sql => sql.includes('COUNT(*)::int AS total'), [{ total: 0 }])

        const metadata = await generateMetadata({
            params: { store: 'example.com' },
        })

        expect(metadata.robots).toEqual({ index: false, follow: true })
    })
})
