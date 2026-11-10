import { BASE_URL } from '@/lib/env.client'
import type { Metadata } from 'next'
import TermsPageClient from './TermsPageClient'

// /terms did not exist until 2026-10-26 (T-8425): grabcaramel.com/terms 404'd
// while every other Devino app serves one, and the App Store en-US listing and
// AI-marketplace submissions want a public terms URL beside /privacy. Same
// server-wrapper + client-body split as /privacy, so the page carries its own
// title, description and canonical.
const title = 'Caramel | Terms of Service'
const description =
    'The terms for using Caramel: the free coupon extension, grabcaramel.com and the Caramel apps. Codes, accounts, acceptable use, and liability.'
const canonicalUrl = 'https://grabcaramel.com/terms'
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

export default function Terms() {
    return <TermsPageClient />
}
