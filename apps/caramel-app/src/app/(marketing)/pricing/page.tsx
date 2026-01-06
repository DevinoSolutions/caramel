import type { Metadata } from 'next'
import PricingPageClient from './PricingPageClient'

const title = 'Caramel Pricing | Free Forever Coupon Extension'
const description =
    'Caramel is 100% free, open source, and privacy-first. No hidden fees, no data tracking, no credit card required. Save money with the trusted alternative to Honey.'
const canonicalUrl = 'https://grabcaramel.com/pricing'
const base = process.env.NEXT_PUBLIC_BASE_URL || 'https://grabcaramel.com'
const banner = `${base}/caramel_banner.png`

export const metadata: Metadata = {
    title,
    description,
    alternates: {
        canonical: canonicalUrl,
    },
    keywords: [
        'free coupon extension',
        'caramel pricing',
        'free forever',
        'no hidden fees',
        'open source coupon finder',
        'privacy-first extension',
        'free shopping extension',
        'caramel cost',
    ],
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
