import type { Metadata } from 'next'
import ProfilePageClient from './ProfilePageClient'

// The page is an account HOME, not a profile form — the metadata says so too.
// `robots: noindex` stays: this is per-user content that must never be crawled.
const title = 'Your account | Caramel'
const description =
    'Your savings, the stores you follow, and your Caramel data.'

export const metadata: Metadata = {
    title,
    description,
    robots: {
        index: false,
        follow: false,
    },
}

export default function ProfilePage() {
    return <ProfilePageClient />
}
