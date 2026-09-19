import CouponsSection from '@/components/coupons/coupons-section'
import PopularStores from '@/components/coupons/popular-stores'
import StoreLetterStrip from '@/components/coupons/store-letter-strip'
import { attachSignals } from '@/lib/couponSignals'
import { listCoupons } from '@/lib/couponsRepo'
import { BASE_URL } from '@/lib/env.client'
import { jsonLdString } from '@/lib/jsonLd'
import type { Coupon } from '@/types/coupon'
import type { Metadata } from 'next'

// The coupon catalog lives in the app's Postgres, and the production image
// builds against a deliberately unreachable placeholder DATABASE_URL (the
// Dockerfile's `.invalid` builder env) — so this page renders per-request,
// never at build time. Same constraint and rationale as sitemap.ts.
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 5

const title = 'Coupon Codes & Promo Codes for Top Stores | Caramel'
const description =
    'Browse coupon codes and promo codes for your favorite stores. Caramel finds and applies the best deals automatically at checkout.'
const canonicalUrl = 'https://grabcaramel.com/coupons'
const banner = `${BASE_URL}/caramel_banner.png`

export const metadata: Metadata = {
    title,
    description,
    alternates: {
        canonical: canonicalUrl,
    },
    openGraph: {
        type: 'website',
        url: canonicalUrl,
        title,
        description,
        locale: 'en_US',
        images: [
            {
                url: banner,
                width: 1200,
                height: 630,
            },
        ],
    },
    twitter: {
        card: 'summary_large_image',
        site: '@CaramelOfficial',
        title,
        description,
        images: [banner],
    },
}

export default async function CouponsPage() {
    // Server-render the same first page the client fetch would load
    // (/api/coupons page=1, identical ranking) so the crawler-visible HTML
    // carries real coupon content instead of a loading spinner. attachSignals
    // mirrors the store page: SSR HTML and the client fetch must agree on
    // lastWorkedAt or hydration flashes the "worked Xh ago" line. The Coupon[]
    // cast reconciles CouponListRow's deliberately wider status typing — see
    // the boundary comment in [store]/page.tsx's fetchStoreCoupons.
    const { coupons, total } = await listCoupons({ limit: PAGE_SIZE, skip: 0 })
    const couponsWithSignals = (await attachSignals(coupons)) as Coupon[]

    const structuredData = {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: 'Coupon codes and promo codes',
        url: canonicalUrl,
        numberOfItems: total,
        itemListElement: couponsWithSignals.map((coupon, idx) => ({
            '@type': 'ListItem',
            position: idx + 1,
            url: canonicalUrl,
            name: coupon.title,
            description: coupon.description,
        })),
    }

    return (
        <main className="relative min-h-screen px-6 pt-32 dark:bg-darkBg lg:px-8">
            <CouponsSection
                initialCoupons={couponsWithSignals}
                initialTotal={total}
                disableInitialFetch
                heroTitle="Today's Coupon Codes"
                heroSubtitle="Browse coupon codes, promo codes, and offers for your favorite stores."
            />
            <PopularStores />
            {/* Server-rendered letter strip into the A–Z directory — the hub's
                crawl path to every store page, not just the 4 popular ones. */}
            <StoreLetterStrip />
            <script
                type="application/ld+json"
                suppressHydrationWarning
                dangerouslySetInnerHTML={{
                    __html: jsonLdString(structuredData),
                }}
            />
        </main>
    )
}
