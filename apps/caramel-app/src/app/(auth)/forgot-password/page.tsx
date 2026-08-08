import type { Metadata } from 'next'
import ForgotPasswordPageClient from './ForgotPasswordPageClient'

const title = 'Reset your password | Caramel'
const description =
    'Request a link to reset the password on your Caramel account.'

export const metadata: Metadata = {
    title,
    description,
    alternates: {
        canonical: 'https://grabcaramel.com/forgot-password',
    },
    /* Deliberately not indexed, unlike /login and /signup. This is a
     * transactional utility page with nothing a searcher wants; indexing it
     * only adds a thin, near-duplicate result competing with the pages that
     * should rank. `follow` is kept so its link equity still flows to /login. */
    robots: { index: false, follow: true },
}

export default function ForgotPassword() {
    return <ForgotPasswordPageClient />
}
