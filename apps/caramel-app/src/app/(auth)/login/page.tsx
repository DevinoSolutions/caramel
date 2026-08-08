import { BASE_URL } from '@/lib/env.client'
import type { Metadata } from 'next'
import LoginPageClient from './LoginPageClient'

/* Brand-first title: the query this page can realistically win is "caramel
 * login", and Google renders roughly the first 60 characters, so the
 * distinguishing words go at the front rather than after a "Caramel |" prefix
 * that every other page also carries. */
const title = 'Sign in to Caramel | Coupon Extension Login'
const description =
    'Sign in to your Caramel account to sync saved coupons across browsers and manage the free, open-source coupon extension.'
const canonicalUrl = 'https://grabcaramel.com/login'
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

/* Params read on the server, like /verify — see that page for the full note.
 *
 * The client used to pull them out of window.location.search inside an effect
 * with a 100ms timer, so the "Verification link expired" alert and its button
 * could not exist until after hydration. That is what failed CI as
 * `Request New Link button navigates to /verify`: the click waited 5s for a
 * button whose render was gated on JavaScript that had not run yet.
 */
export default async function Login({
    searchParams,
}: {
    searchParams: Promise<{ verified?: string; error?: string }>
}) {
    const { verified, error } = await searchParams
    return <LoginPageClient verified={verified} error={error} />
}
