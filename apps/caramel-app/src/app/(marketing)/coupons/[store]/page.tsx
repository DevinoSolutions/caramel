import CouponsSection from '@/components/coupons/coupons-section'
import PopularStores from '@/components/coupons/popular-stores'
import StoreFavoriteStar from '@/components/coupons/store-favorite-star'
import { attachSignals } from '@/lib/couponSignals'
import { listStoreCoupons } from '@/lib/couponsRepo'
import { BASE_URL } from '@/lib/env.client'
import { jsonLdString } from '@/lib/jsonLd'
import { resolveStoreDomain } from '@/lib/storeDomain'
import type { Coupon } from '@/types/coupon'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { cache } from 'react'

const PAGE_SIZE = 5
const baseUrl = BASE_URL

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

// Registrable domain via the Public Suffix List. The previous local
// "last two labels" helper turned /coupons/mymemory.co.uk into an indexable
// page for a fictional store called "co.uk", listing another brand's codes
// under the H1 "Best co.uk coupon codes today" — 230 store pages did this.
// Empty string keeps this file's existing "not a store" contract.
function getBaseDomain(raw: string): string {
    return resolveStoreDomain(raw) ?? ''
}

type StoreParams = { store: string }

// cache(): generateMetadata needs the coupon total too (for the zero-coupon
// noindex below), and React request-level caching makes that share ONE catalog
// read with the page body instead of doubling every store-page query.
const fetchStoreCoupons = cache(async (storeParam: string) => {
    const base = getBaseDomain(storeParam)
    if (!base) {
        return { coupons: [] as Coupon[], total: 0, base: storeParam }
    }

    // parseCouponRows's output (CouponListRow) is a strict superset of
    // Coupon's shape except status/verificationMessage, which it types
    // wider (plain string / string|null vs. Coupon's optional narrower
    // union) — deliberately, per couponsDb.ts's schema comments, so this
    // boundary doesn't need updating every time the Python producer adds a
    // status value. The data is already runtime-validated at this point;
    // the cast just reconciles the two independently-declared TS shapes.
    //
    // attachSignals merges the app-owned lastWorkedAt (from coupon_signals in
    // OUR Postgres) onto each row so the SSR HTML and the client fetch agree —
    // the store page must attach it too, or its server-rendered cards would
    // never show "worked Xh ago". Empty signals → lastWorkedAt:null (unshown).
    const { coupons, total } = await listStoreCoupons(base, PAGE_SIZE)
    const couponsWithSignals = await attachSignals(coupons)
    return { coupons: couponsWithSignals as Coupon[], total, base }
})

export async function generateMetadata({
    params,
}: {
    params: Promise<StoreParams> | StoreParams
}): Promise<Metadata> {
    const { store } = await Promise.resolve(params)
    const storeParam = typeof store === 'string' ? safeDecode(store) : ''
    const base = getBaseDomain(storeParam)
    if (!storeParam || !base) {
        /* A slug that resolves to no registrable domain is not a store at all,
         * and this route still answers 200 for it (the body renders the honest
         * empty state rather than 404ing). That is the soft-404 bloat the
         * zero-coupon rule below exists to keep out of the index — only more so,
         * because there is no store here to have coupons in the first place.
         *
         * It only became reachable when getBaseDomain moved to the Public Suffix
         * List: the old "last two labels" helper always returned SOMETHING, so
         * this branch was effectively dead and inherited no robots directive.
         * Caught by e2e/seo-a11y.spec.ts, which asks for /coupons/…-zz.example —
         * a slug the PSL correctly refuses, since `.example` is reserved and
         * cannot be registered. `follow` stays on for the same reason it does
         * below: the links off the page are still worth crawling. */
        return {
            title: 'Coupons | Caramel',
            description: 'Find coupons and promo codes on Caramel.',
            robots: { index: false, follow: true },
        }
    }
    // Declaring `openGraph` below REPLACES the root layout's object wholesale
    // rather than merging into it, so the inherited og:image has to be restated
    // here or these pages share links with no preview image at all.
    const banner = `${baseUrl}/caramel_banner.png`
    const title = `${base} Coupons & Promo Codes | Caramel`
    const description = `Find verified ${base} coupon codes, promo codes, and discounts. Updated daily.`
    // Canonical always points at the NORMALIZED base-domain URL: this route
    // serves the same content for /coupons/www.nike.com, /coupons/shop.nike.com
    // and /coupons/nike.com, so every variant must canonicalize to ONE URL or
    // Google treats them as competing duplicates. (The sitemap emits only
    // base-domain URLs — this makes the page agree with it.)
    const canonical = `${baseUrl}/coupons/${encodeURIComponent(base)}`
    // Stores with zero visible coupons stay reachable (the prose section
    // renders an honest empty state) but are noindexed: thousands of thin
    // "no codes right now" pages in the index are soft-404 bloat. cache()
    // makes this share one catalog read with the page body.
    const { total } = await fetchStoreCoupons(storeParam)

    return {
        title,
        description,
        alternates: { canonical },
        robots: total === 0 ? { index: false, follow: true } : undefined,
        openGraph: {
            type: 'website',
            url: canonical,
            title,
            description,
            locale: 'en_US',
            siteName: 'Caramel',
            images: [
                {
                    url: banner,
                    width: 1200,
                    height: 630,
                    alt: `${base} coupon codes on Caramel`,
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
}

export default async function StoreCouponsPage({
    params,
}: {
    params: Promise<StoreParams> | StoreParams
}) {
    const { store } = await Promise.resolve(params)
    const storeParam = typeof store === 'string' ? safeDecode(store) : ''
    if (!storeParam) {
        notFound()
    }

    const { coupons, total, base } = await fetchStoreCoupons(storeParam)

    // Same normalized URL the canonical uses — structured data pointing at a
    // slug variant would contradict the canonical it sits next to.
    const storeUrl = `${baseUrl}/coupons/${encodeURIComponent(base)}`

    const structuredData = {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: `${base} coupons and promo codes`,
        url: storeUrl,
        numberOfItems: total,
        itemListElement: (coupons || []).map((coupon: Coupon, idx: number) => ({
            '@type': 'ListItem',
            position: idx + 1,
            url: storeUrl,
            name: coupon.title,
            description: coupon.description,
        })),
    }

    // BreadcrumbList mirrors the crumb trail Google shows in the snippet; the
    // final item carries no `item` URL per the spec (it IS the current page).
    const breadcrumbData = {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Home', item: baseUrl },
            {
                '@type': 'ListItem',
                position: 2,
                name: 'Coupons',
                item: `${baseUrl}/coupons`,
            },
            { '@type': 'ListItem', position: 3, name: `${base} coupons` },
        ],
    }

    return (
        <main className="relative min-h-screen px-6 pt-32 dark:bg-darkBg lg:px-8">
            <CouponsSection
                defaultFilters={{ site: base }}
                initialCoupons={coupons}
                initialTotal={total}
                disableInitialFetch
                // `base` — not the raw slug — because that is the normalized
                // store key favorites are filed under (the same value the
                // canonical URL uses), so /coupons/www.nike.com and
                // /coupons/nike.com star ONE row rather than two.
                //
                // The star renders nothing at all for signed-out visitors, so
                // this route's server HTML — the thing SEO and the AEO prose
                // below depend on — is unchanged for crawlers.
                //
                // No star when `base` is empty: this route answers 200 for a
                // slug that names no registrable store (the noindexed branch in
                // generateMetadata above), and there is nothing there to follow.
                heroAction={
                    base ? <StoreFavoriteStar store={base} /> : undefined
                }
                heroTitle={`Best ${base} coupon codes today`}
                heroSubtitle={`Save at ${base} with Caramel—the privacy-first coupon finder that applies the top deals automatically at checkout.`}
            />
            {/* AEO citable prose — server-rendered visible copy (AI engines
                extract visible HTML, not JSON-LD). The count is the same
                server-side `total` the list uses; the mechanics paragraph is
                generic and truthful (no per-store invented facts). No
                freshness/"last verified" date is rendered because no such
                verification timestamp exists in the row data. */}
            <section
                aria-labelledby="how-caramel-works-heading"
                className="mx-auto max-w-4xl pb-24 pt-16"
            >
                <h2
                    id="how-caramel-works-heading"
                    className="mb-4 text-2xl font-bold tracking-tight text-gray-900 dark:text-white"
                >
                    How Caramel finds {base} coupon codes
                </h2>
                <p className="mb-4 leading-relaxed text-gray-600 dark:text-gray-400">
                    {total > 0
                        ? `Caramel's catalog currently lists ${total.toLocaleString('en-US')} active coupon ${total === 1 ? 'code' : 'codes'} for ${base}.`
                        : `Caramel's catalog has no active coupon codes for ${base} right now — new codes are added automatically as they are found.`}{' '}
                    The Caramel coupon extension is free, open source, and
                    available for Chrome, Firefox, Edge, and Safari.
                </p>
                <p className="leading-relaxed text-gray-600 dark:text-gray-400">
                    When you reach checkout on {base}, Caramel looks up the
                    codes for that store from its own catalog, tries them in the
                    promo-code field, and keeps the one with the biggest
                    discount. It never replaces affiliate links, and it reports
                    back only whether a code worked — with no account
                    information attached — so code rankings stay accurate for
                    every shopper.
                </p>
            </section>
            <PopularStores currentSite={base} />
            <script
                type="application/ld+json"
                suppressHydrationWarning
                dangerouslySetInnerHTML={{
                    __html: jsonLdString(structuredData),
                }}
            />
            <script
                type="application/ld+json"
                suppressHydrationWarning
                dangerouslySetInnerHTML={{
                    __html: jsonLdString(breadcrumbData),
                }}
            />
        </main>
    )
}
