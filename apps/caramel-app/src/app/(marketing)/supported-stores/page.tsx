import SearchSection from '@/components/supported-site/search-section'
import { BASE_URL } from '@/lib/env.client'
import type { Metadata } from 'next'

const title = 'Caramel | Supported Stores'
const description =
    'Explore the stores supported by Caramel and start saving with our coupon extension.'
const canonicalUrl = 'https://grabcaramel.com/supported-stores'
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

export default function SupportedSitesPage() {
    return (
        <main className="flex min-h-screen flex-col items-center px-6 pt-32">
            <SearchSection />
        </main>
    )
}
