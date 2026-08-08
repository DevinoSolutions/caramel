import { BASE_URL } from '@/lib/env.client'
import type { Metadata } from 'next'
import { Suspense } from 'react'
import VerifyPageClient from './VerifyPageClient'

const title = 'Caramel | Verify Email'
const description =
    'Verify your email address to activate your Caramel account and start saving with our coupon extension.'
const canonicalUrl = 'https://grabcaramel.com/verify'
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

/* The params are read HERE, on the server, and handed down as props.
 *
 * They used to be read with useSearchParams() inside the client component,
 * which opts its whole Suspense subtree out of server rendering: every visitor
 * was served the string "Loading..." and nothing else, and the real copy —
 * including which of the two messages applies — appeared only once the bundle
 * had downloaded and hydrated. Verified against the dev deployment on
 * 2026-08-06: the HTML for /verify?signup=success contained `Loading...` and
 * zero occurrences of "sent a verification email".
 *
 * That is a flash of placeholder on a page whose entire job is one sentence,
 * and it is also why `verify page after signup shows correct messaging` failed
 * CI twice: the assertion was racing hydration on a loaded runner, so the suite
 * went red on commits that touched only the extension. A test asserting on text
 * a user can actually see needed the text to actually be there.
 */
export default async function VerifyPage({
    searchParams,
}: {
    searchParams: Promise<{ signup?: string; error?: string }>
}) {
    const { signup, error } = await searchParams
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <VerifyPageClient signup={signup} error={error} />
        </Suspense>
    )
}
