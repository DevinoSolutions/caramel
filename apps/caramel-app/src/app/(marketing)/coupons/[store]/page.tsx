import CouponsSection from '@/components/coupons/coupons-section'
import { listStoreCoupons } from '@/lib/couponsRepo'
import { BASE_URL } from '@/lib/env.client'
import type { Coupon } from '@/types/coupon'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

const PAGE_SIZE = 5
const baseUrl = BASE_URL

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

function getBaseDomain(raw: string): string {
    let hostname = raw.trim()
    try {
        const u = new URL(
            hostname.startsWith('http') ? hostname : `https://${hostname}`,
        )
        hostname = u.hostname
    } catch {
        // fallback to raw slug
    }
    // Strip anything that isn't a valid hostname character so injection
    // attempts through the URL slug can't smuggle SQL patterns downstream.
    if (!/^[a-z0-9.-]+$/i.test(hostname)) return ''
    const parts = hostname.split('.')
    return parts.length > 2 ? parts.slice(-2).join('.') : hostname
}

type StoreParams = { store: string }

async function fetchStoreCoupons(storeParam: string) {
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
    const { coupons, total } = await listStoreCoupons(base, PAGE_SIZE)
    return { coupons: coupons as Coupon[], total, base }
}

export async function generateMetadata({
    params,
}: {
    params: Promise<StoreParams> | StoreParams
}): Promise<Metadata> {
    const { store } = await Promise.resolve(params)
    const storeParam = typeof store === 'string' ? safeDecode(store) : ''
    const base = getBaseDomain(storeParam)
    if (!storeParam || !base) {
        return {
            title: 'Coupons | Caramel',
            description: 'Find coupons and promo codes on Caramel.',
        }
    }
    const title = `${base} Coupons & Promo Codes | Caramel`
    const description = `Find verified ${base} coupon codes, promo codes, and discounts. Updated daily.`
    const canonical = `${baseUrl}/coupons/${encodeURIComponent(storeParam)}`

    return {
        title,
        description,
        alternates: { canonical },
        openGraph: {
            type: 'website',
            url: canonical,
            title,
            description,
        },
        twitter: {
            card: 'summary_large_image',
            title,
            description,
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

    const structuredData = {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: `${base} coupons and promo codes`,
        url: `${baseUrl}/coupons/${encodeURIComponent(storeParam)}`,
        numberOfItems: total,
        itemListElement: (coupons || []).map((coupon: Coupon, idx: number) => ({
            '@type': 'ListItem',
            position: idx + 1,
            url: `${baseUrl}/coupons/${encodeURIComponent(storeParam)}`,
            name: coupon.title,
            description: coupon.description,
        })),
    }

    return (
        <main className="relative min-h-screen px-6 pt-32 dark:bg-darkBg lg:px-8">
            <CouponsSection
                defaultFilters={{ site: base }}
                initialCoupons={coupons}
                initialTotal={total}
                disableInitialFetch
                heroTitle={`Best ${base} coupon codes today`}
                heroSubtitle={`Save at ${base} with Caramel—the privacy-first coupon finder that applies the top deals automatically at checkout.`}
            />
            <script
                type="application/ld+json"
                suppressHydrationWarning
                dangerouslySetInnerHTML={{
                    __html: JSON.stringify(structuredData),
                }}
            />
        </main>
    )
}
