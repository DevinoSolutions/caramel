import StoreCouponsPage, {
    generateMetadata,
} from '@/app/(marketing)/coupons/[store]/page'
import { BASE_URL } from '@/lib/env.client'
import prisma from '@/lib/prisma'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// An Error in `rows` makes the matching query REJECT (a failing probe).
type MockRule = { match: (sql: string) => boolean; rows: unknown[] | Error }
let rules: MockRule[] = []
function mockRows(match: (sql: string) => boolean, rows: unknown[]) {
    rules.push({ match, rows })
}

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (arg: { sql: string }) => {
            const rows = rules.find(r => r.match(arg.sql))?.rows ?? []
            return rows instanceof Error
                ? Promise.reject(rows)
                : Promise.resolve(rows)
        },
        couponSignal: { findMany: vi.fn(async () => []) },
    },
}))

const captureException = vi.hoisted(() => vi.fn())
vi.mock('@sentry/nextjs', () => ({ captureException }))

vi.mock('@/components/coupons/coupons-section', () => ({
    default: () => null,
}))

// isKnownStore's single EXISTS probe (couponsRepo.ts) is the only query whose
// SQL carries `AS known`. Every test defaults to a KNOWN store (so the page
// renders its normal tree); the "Add a code" tests below override it.
const KNOWN_STORE_SQL = (sql: string) => sql.includes('AS known')
let knownStoreQueries = 0
beforeEach(() => {
    rules = []
    captureException.mockClear()
    knownStoreQueries = 0
    rules.push({
        match: sql => {
            const hit = KNOWN_STORE_SQL(sql)
            if (hit) knownStoreQueries += 1
            return hit
        },
        rows: [{ known: true }],
    })
})

/** The store page's count row: the total plus the FAQ facts folded into the
 *  same aggregate (couponsDb.ts StoreCouponAggregateRowSchema). */
function storeAggregateRow(total: number) {
    return {
        total,
        percent_off_codes: total,
        best_percent_off: total > 0 ? 10 : null,
        fixed_amount_codes: 0,
        last_updated: total > 0 ? new Date('2026-09-24T12:00:00Z') : null,
    }
}

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

// listStoreCoupons's list rows carry `isSupplier` (submission_source IS NULL).
// A supplier row proves the store is known (the page skips the probe); a
// shopper-only row does not (the page probes).
const supplierRow = { ...couponFixture, isSupplier: true }
const shopperRow = { ...couponFixture, isSupplier: false }

describe('StoreCouponsPage — CouponListRow + TotalCountRow', () => {
    it('parses production-shaped rows into both the CouponsSection props and the structured-data script', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [supplierRow],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(1)],
        )

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
                lastFailedAt: null,
                failCount: 0,
                keepsFailing: false,
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
                name: couponFixture.title,
                description: couponFixture.description,
            },
        ])
        // Every code lives on this one page: the list names the page once,
        // never the same URL per item.
        expect(structuredData.url).toBe(`${BASE_URL}/coupons/example.com`)
    })

    it('codes that keep failing are collapsed on the page, so the ItemList JSON-LD and the FAQ "ranked first" claim skip them (they stay in the section props)', async () => {
        const flaggedRow = {
            ...supplierRow,
            id: 41,
            code: 'FLAGGED41',
            title: 'Flagged top-ranked code',
        }
        const okRow = { ...supplierRow, id: 43, title: 'Healthy code' }
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [flaggedRow, okRow],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(2)],
        )
        vi.mocked(prisma.couponSignal.findMany).mockResolvedValueOnce([
            {
                couponId: '41',
                lastWorkedAt: null,
                lastFailedAt: new Date(Date.now() - 60 * 60 * 1000),
                failCount: 4,
            },
        ] as never)

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
        // oxlint-disable-next-line no-underscore-dangle -- React's own prop name
        const itemList = JSON.parse(
            scripts[0]!.props.dangerouslySetInnerHTML.__html,
        )
        expect(
            itemList.itemListElement.map((i: { name: string }) => i.name),
        ).toEqual(['Healthy code'])
        expect(itemList.itemListElement[0].position).toBe(1)

        // oxlint-disable-next-line no-underscore-dangle -- React's own prop name
        const faqJson = scripts[2]!.props.dangerouslySetInnerHTML.__html
        expect(faqJson).toContain('Healthy code')
        expect(faqJson).not.toContain('Flagged top-ranked code')
        expect(faqJson).not.toContain('FLAGGED41')

        // The flagged code is NOT removed from the page: the section still gets
        // it (flagged), and collapses it inside its hidden region.
        const section = mainEl.props.children.find(
            c => (c as ReactElement)?.type !== 'script',
        ) as ReactElement<{
            initialCoupons: Array<{ id: string; keepsFailing: boolean }>
        }>
        expect(
            section.props.initialCoupons.map(c => [c.id, c.keepsFailing]),
        ).toEqual([
            ['41', true],
            ['43', false],
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

    it('renders BreadcrumbList and FAQPage scripts alongside the ItemList', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [supplierRow],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(1)],
        )

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
        expect(scripts).toHaveLength(3)
        const breadcrumb = JSON.parse(
            // oxlint-disable-next-line no-underscore-dangle -- React's own prop name
            scripts[1]!.props.dangerouslySetInnerHTML.__html,
        )
        expect(breadcrumb['@type']).toBe('BreadcrumbList')
        expect(breadcrumb.itemListElement).toHaveLength(3)
        expect(breadcrumb.itemListElement[1].item).toBe(`${BASE_URL}/coupons`)
        // The final crumb is the current page: name only, no `item` URL.
        expect(breadcrumb.itemListElement[2].item).toBeUndefined()

        // The FAQPage markup states the numbers the aggregate row carries.
        const faq = JSON.parse(
            // oxlint-disable-next-line no-underscore-dangle -- React's own prop name
            scripts[2]!.props.dangerouslySetInnerHTML.__html,
        )
        expect(faq['@type']).toBe('FAQPage')
        expect(faq.mainEntity).toHaveLength(4)
        expect(faq.mainEntity[1].acceptedAnswer.text).toContain(
            'lists 1 active coupon code for example.com: 1 percent-off code (up to 10% off).',
        )
    })

    it('a store with no active codes gets no FAQ section and no FAQPage markup', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(0)],
        )

        const mainEl = (await StoreCouponsPage({
            params: { store: 'example.com' },
        })) as ReactElement<{ children: ReactElement[] }>

        const pageJson = JSON.stringify(mainEl)
        expect(pageJson).not.toContain('store-faq-heading')
        expect(pageJson).not.toContain('FAQPage')
    })

    it('a UK store page body uses the same discount-code wording as its title', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [supplierRow],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(1)],
        )

        const mainEl = (await StoreCouponsPage({
            params: { store: 'example.co.uk' },
        })) as ReactElement<{ children: ReactElement[] }>

        const pageJson = JSON.stringify(mainEl)
        expect(pageJson).toContain('Best Example discount codes today')
        expect(pageJson).toContain('active discount code for example.co.uk')
        expect(pageJson).toContain('Example discount codes and voucher codes')
        expect(pageJson).not.toContain('coupon codes today')
    })

    it('with zero coupons the prose section says so honestly instead of inventing a count', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(0)],
        )

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

describe('StoreCouponsPage — "Add a code" form is offered for known stores only', () => {
    function pageHasAddCodeForm(
        mainEl: ReactElement<{ children: ReactElement[] }>,
    ) {
        return mainEl.props.children.some(
            c =>
                typeof (c as ReactElement)?.type === 'function' &&
                (c as ReactElement<{ store?: string }>).props?.store ===
                    'example.com',
        )
    }

    it('skips the known-store probe when a returned row is a supplier row, and still renders the form', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [shopperRow, supplierRow],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(2)],
        )

        const mainEl = (await StoreCouponsPage({
            params: { store: 'example.com' },
        })) as ReactElement<{ children: ReactElement[] }>

        expect(pageHasAddCodeForm(mainEl)).toBe(true)
        expect(knownStoreQueries).toBe(0)
    })

    it('does not leak isSupplier into the CouponsSection props', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [supplierRow],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(1)],
        )

        const mainEl = (await StoreCouponsPage({
            params: { store: 'example.com' },
        })) as ReactElement<{ children: ReactElement[] }>

        expect(JSON.stringify(mainEl)).not.toContain('isSupplier')
    })

    it('a failing known-store probe does not take the page down: no form, Sentry told', async () => {
        const probeError = new Error('known-store probe exploded')
        rules.unshift({ match: KNOWN_STORE_SQL, rows: probeError })
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [shopperRow],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(1)],
        )

        const mainEl = (await StoreCouponsPage({
            params: { store: 'example.com' },
        })) as ReactElement<{ children: ReactElement[] }>

        expect(pageHasAddCodeForm(mainEl)).toBe(false)
        // The rest of the page still rendered.
        expect(JSON.stringify(mainEl)).toContain('How Caramel finds ')
        expect(captureException).toHaveBeenCalledWith(probeError, {
            tags: { area: 'storePage.isKnownStore' },
        })
    })

    it('renders the form for a known store, passing the normalized base domain', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [shopperRow],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(1)],
        )

        const mainEl = (await StoreCouponsPage({
            params: { store: 'www.example.com' },
        })) as ReactElement<{ children: ReactElement[] }>

        expect(pageHasAddCodeForm(mainEl)).toBe(true)
        expect(knownStoreQueries).toBe(1)
    })

    it('does NOT render the form when the store is unknown, even if the page lists coupons', async () => {
        // A shopper-only domain can list rows (visibility counts them) yet is not
        // a known store; the API would answer 422 not-a-store, so no form.
        rules.unshift({
            match: KNOWN_STORE_SQL,
            rows: [{ known: false }],
        })
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [shopperRow],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(1)],
        )

        const mainEl = (await StoreCouponsPage({
            params: { store: 'example.com' },
        })) as ReactElement<{ children: ReactElement[] }>

        expect(pageHasAddCodeForm(mainEl)).toBe(false)
    })

    it('does not render the form, or probe the catalog for known-ness, on a slug that names no store', async () => {
        const mainEl = (await StoreCouponsPage({
            params: { store: '!!!not-a-domain!!!' },
        })) as ReactElement<{ children: ReactElement[] }>

        expect(pageHasAddCodeForm(mainEl)).toBe(false)
        expect(knownStoreQueries).toBe(0)
    })
})

describe('StoreCouponsPage generateMetadata — canonical normalization + thin-page noindex', () => {
    // The title's month and "Active" depend on render time against the
    // fixture's last_updated (2026-09-24): pin the clock so they never drift.
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-10-16T20:00:00Z'))
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('canonicalizes every slug variant to the base-domain URL (www.example.com → example.com)', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [supplierRow],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(1)],
        )

        const metadata = await generateMetadata({
            params: { store: 'www.example.com' },
        })

        expect(metadata.alternates?.canonical).toBe(
            `${BASE_URL}/coupons/example.com`,
        )
        expect(metadata.openGraph?.url).toBe(`${BASE_URL}/coupons/example.com`)
        // A store WITH coupons is indexable — no robots override.
        expect(metadata.robots).toBeUndefined()
        // Title/description lead with the brand name and carry the live code
        // count and best percent-off — singular for exactly one code. The
        // fixture's list was updated in September 2026, not this month, so
        // no month is claimed (storeMetadata.test.ts pins the dated forms).
        expect(metadata.title).toBe(
            'Example Promo Codes & Coupons: 1 Active Code | Caramel',
        )
        expect(metadata.description).toBe(
            "1 Example promo code for example.com, up to 10% off. Copy it, or let Caramel's free extension try it at checkout.",
        )
        expect(metadata.openGraph?.title).toBe(metadata.title)
    })

    it('speaks UK search vocabulary on a UK store page', async () => {
        // UK shoppers search "<store> discount code" / "voucher code"; the
        // US "coupons & promo codes" wording matched almost none of it.
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [supplierRow],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(1)],
        )

        const metadata = await generateMetadata({
            params: { store: 'example.co.uk' },
        })

        expect(metadata.title).toBe(
            'Example Discount Codes & Vouchers: 1 Active Code | Caramel',
        )
        expect(metadata.description).toBe(
            "1 Example discount code for example.co.uk, up to 10% off. Copy it, or let Caramel's free extension try it at checkout.",
        )
        expect(metadata.openGraph?.title).toBe(metadata.title)
    })

    it('noindexes (but still follows) a store page with zero visible coupons', async () => {
        mockRows(
            sql => sql.includes('FROM coupons') && sql.includes('LIMIT'),
            [],
        )
        mockRows(
            sql => sql.includes('COUNT(*)::int AS total'),
            [storeAggregateRow(0)],
        )

        const metadata = await generateMetadata({
            params: { store: 'example.com' },
        })

        expect(metadata.robots).toEqual({ index: false, follow: true })
        // The empty state keeps the generic title: it must never advertise a
        // code count it does not have.
        expect(metadata.title).toBe('Example Coupons & Promo Codes | Caramel')
        expect(metadata.description).toBe(
            'Find Example coupon codes, promo codes and discounts for example.com, refreshed as new codes are found.',
        )
    })
})
