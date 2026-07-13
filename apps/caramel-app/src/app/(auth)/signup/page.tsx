import { BASE_URL } from '@/lib/env.client'
import type { Metadata } from 'next'
import SignupPageClient from './SignupPageClient'

const title = 'Caramel | Sign Up'
const description = 'Join Caramel and start enjoying our services. Sign up now!'
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
