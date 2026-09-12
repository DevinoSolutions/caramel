import { BASE_URL } from '@/lib/env.client'
import type { Metadata } from 'next'
import PricingPageClient from './PricingPageClient'

// Search Console (90 days to 2026-09-11): 513 impressions, 2 clicks, position
// 7.9 — a 0.4% CTR against a ~3% benchmark for that position. Every query
// that reaches this page is a brand query (`caramel extension`, `caramel
// coupon`) on which the home page already ranks #1, so a snippet that repeats
// the home pitch only competes with it. The title/description therefore state
// the ONE thing this page answers — "Is Caramel free?" — so it wins the
// price-intent variant instead of duplicating the home snippet.
const title = 'Is Caramel Free? Yes — Free Forever & Open Source | Caramel'
const description =
    'Yes, Caramel is free forever: no premium tier, no hidden fees, no credit card. An open-source coupon extension for 4,000+ stores that never sells your data.'
const canonicalUrl = 'https://grabcaramel.com/pricing'
const base = BASE_URL
const banner = `${base}/caramel_banner.png`

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
                alt: 'Caramel - Free Forever Coupon Extension',
            },
        ],
        siteName: 'Caramel',
    },
    twitter: {
        card: 'summary_large_image',
        site: '@CaramelOfficial',
        title,
        description,
        images: [banner],
        creator: '@CaramelOfficial',
    },
    robots: {
        index: true,
        follow: true,
        googleBot: {
            index: true,
            follow: true,
            'max-video-preview': -1,
            'max-image-preview': 'large',
            'max-snippet': -1,
        },
    },
}

export default function PricingPage() {
    return <PricingPageClient />
}
