import SupportForm from '@/components/support/support-form'
import { auth } from '@/lib/auth/auth'
import { BASE_URL } from '@/lib/env.client'
import type { Metadata } from 'next'
import { headers } from 'next/headers'

const title = 'Support — Caramel'
const description =
    'Need help with Caramel? Report a problem, request a feature, or ask a question — our team reads every message.'
const canonicalUrl = 'https://grabcaramel.com/support'
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

// PUBLIC — a user must be able to report a login problem WITHOUT signing in.
// The session is read server-side only to pre-fill the reply address for
// signed-in users (so they don't re-type it); anonymous visitors get the
// email field on demand.
export default async function SupportPage() {
    const session = await auth.api.getSession({ headers: await headers() })
    const accountEmail = session?.user?.email ?? null

    return (
        <main className="flex min-h-screen flex-col items-center px-6 pb-16 pt-32">
            <div className="w-full max-w-lg">
                <div className="mb-8 text-center">
                    <h1 className="mb-3 bg-gradient-to-r from-caramel to-orange-600 bg-clip-text text-4xl font-extrabold text-transparent dark:from-orange-400 dark:to-caramel sm:text-3xl">
                        Contact Support
                    </h1>
                    <p className="mx-auto max-w-md text-gray-600 dark:text-gray-300">
                        Hit a snag, have an idea, or just a question? Send it
                        our way — we read every message.
                    </p>
                </div>
                <SupportForm accountEmail={accountEmail} />
            </div>
        </main>
    )
}
