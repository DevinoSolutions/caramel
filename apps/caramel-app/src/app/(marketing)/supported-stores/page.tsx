import SearchSection from '@/components/supported-site/search-section'
import type { Metadata } from 'next'

const title = 'Caramel | Supported Stores'
const description =
    'Explore the stores supported by Caramel and start saving with our coupon extension.'
const canonicalUrl = 'https://grabcaramel.com/supported-sites'
const base = process.env.NEXT_PUBLIC_BASE_URL || 'https://grabcaramel.com'
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
