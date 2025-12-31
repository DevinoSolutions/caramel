import CouponsSection from '@/components/coupons/coupons-section'
import type { Metadata } from 'next'

const title = 'Caramel | Browse All Coupons'
const description =
    'Discover thousands of verified coupon codes and promo codes for your favorite stores. Save money on every purchase with Caramel.'
const canonicalUrl = 'https://grabcaramel.com/coupons'
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

export default function CouponsPage() {
    return (
        <main className="dark:bg-darkBg relative min-h-screen px-6 pt-32 lg:px-8">
            <CouponsSection />
        </main>
    )
}
