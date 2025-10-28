import type { Metadata } from 'next'
import PrivacyPageClient from './PrivacyPageClient'

const title = 'Caramel | Privacy Policy'
const description =
    'Learn how Caramel protects your privacy and handles your data. Our commitment to transparency and security.'
const canonicalUrl = 'https://grabcaramel.com/privacy'
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

export default function Privacy() {
    return <PrivacyPageClient />
}
