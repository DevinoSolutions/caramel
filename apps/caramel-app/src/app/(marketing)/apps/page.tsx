import { BASE_URL } from '@/lib/env.client'
import type { Metadata } from 'next'
import AppsPageClient from './AppsPageClient'
import { generateAppsStructuredData } from './appsStructuredData'
import { STORE_LISTINGS } from './storeListings'

// The download page. The platform list in the title is derived from the
// LISTED stores, so a store that goes live (or dark) in the manifest changes
// the snippet with it instead of leaving a stale promise.
const browsers = STORE_LISTINGS.map(listing => listing.browserLabel)
const title = `Caramel Extension — Download for ${browsers.join(', ')}`
const description =
    'Get the free Caramel coupon extension from the Chrome Web Store, Firefox Add-ons, Microsoft Edge Add-ons or the App Store, and see what the installed extension actually does.'
const canonicalUrl = `${BASE_URL.replace(/\/+$/, '')}/apps`
const banner = `${BASE_URL}/caramel_banner.png`

export const metadata: Metadata = {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
        type: 'website',
        url: canonicalUrl,
        title,
        description,
        locale: 'en_US',
        images: [{ url: banner, width: 1200, height: 630 }],
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

// The page body is a client component (browser detection hoists the visitor's
// own store card), so the JSON-LD is emitted here where it is server-rendered
// into the first response. Same JSON.stringify serialisation as the root
// layout's entity graph; every value is a compile-time constant.
export default function AppsPage() {
    return (
        <>
            {generateAppsStructuredData().map((data, index) => (
                <script
                    key={index}
                    type="application/ld+json"
                    dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
                />
            ))}
            <AppsPageClient />
        </>
    )
}
