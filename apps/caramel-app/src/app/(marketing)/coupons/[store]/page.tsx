import CouponsSection from '@/components/coupons/coupons-section'
import prisma from '@/lib/prisma'
import type { Coupon } from '@/types/coupon'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

const PAGE_SIZE = 5
const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://grabcaramel.com'

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
    const parts = hostname.split('.')
    return parts.length > 2 ? parts.slice(-2).join('.') : hostname
}

type StoreParams = { store: string }

async function fetchStoreCoupons(storeParam: string) {
    const base = getBaseDomain(storeParam)
    if (!base) {
        return { coupons: [], total: 0, base: storeParam }
    }
    const filters: any = {
        expired: false,
        AND: [{ OR: [{ site: base }, { site: { endsWith: `.${base}` } }] }],
    }

    const [coupons, total] = await prisma.$transaction([
        prisma.coupon.findMany({
            where: filters,
            take: PAGE_SIZE,
            orderBy: [{ rating: 'desc' }, { createdAt: 'desc' }],
            select: {
                id: true,
                code: true,
                site: true,
                title: true,
                description: true,
                rating: true,
                discount_type: true,
                discount_amount: true,
                expiry: true,
                expired: true,
                timesUsed: true,
            },
        }),
        prisma.coupon.count({ where: filters }),
    ])

    return { coupons, total, base }
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
        <main className="dark:bg-darkBg relative min-h-screen px-6 pt-32 lg:px-8">
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
