import { BASE_URL } from '@/lib/env.client'
import type { Metadata } from 'next'
import SignupPageClient from './SignupPageClient'

/* "Join Caramel and start enjoying our services" said nothing about what
 * Caramel is or costs — it was boilerplate that could describe any product, and
 * it is the snippet a searcher decides on. This one names the product category,
 * the price, and the differentiator. */
const title = 'Create a free Caramel account | Coupon Extension Sign Up'
const description =
    'Create a free Caramel account to automatically apply coupon codes at checkout. Open source, no ads, and it never hijacks affiliate commissions.'
const canonicalUrl = 'https://grabcaramel.com/signup'
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

export default function Signup() {
    return <SignupPageClient />
}
