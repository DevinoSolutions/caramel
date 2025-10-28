import type { Metadata } from 'next'
import LoginPageClient from './LoginPageClient'

const title = 'Caramel | Login'
const description =
    'Log in to your Caramel account to access exclusive features and start saving with our coupon extension.'
const canonicalUrl = 'https://grabcaramel.com/login'
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

export default function Login() {
    return <LoginPageClient />
}
