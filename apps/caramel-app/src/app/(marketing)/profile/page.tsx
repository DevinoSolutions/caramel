import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/authOptions'
import ProfilePageClient from './ProfilePageClient'

const title = 'Caramel | Profile'
const description = 'Manage your Caramel account and preferences.'
const canonicalUrl = 'https://grabcaramel.com/profile'
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

export default async function Profile() {
    const session = await getServerSession(authOptions)

    if (!session) {
        redirect('/login')
    }

    return <ProfilePageClient user={session.user as any} />
}
