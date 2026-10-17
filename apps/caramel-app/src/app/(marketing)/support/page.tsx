import SupportForm from '@/components/support/support-form'
import { auth } from '@/lib/auth/auth'
import { DISCORD_INVITE_URL } from '@/lib/brandLinks'
import { BASE_URL } from '@/lib/env.client'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { FaDiscord } from 'react-icons/fa'

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
                <a
                    href={DISCORD_INVITE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="support-community-discord"
                    className="mt-6 flex items-center gap-4 rounded-2xl border border-caramel/20 bg-white p-4 shadow-sm transition hover:border-caramel/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/60 dark:border-caramel/30 dark:bg-darkerBg"
                >
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#5865F2] text-xl text-white">
                        <FaDiscord aria-hidden="true" />
                    </span>
                    <span className="flex-1">
                        <span className="block font-semibold text-gray-900 dark:text-white">
                            Join our Discord
                        </span>
                        <span className="block text-sm text-gray-600 dark:text-gray-300">
                            Ask other Caramel shoppers, share store requests and
                            follow updates. For anything about your account, use
                            the form above.
                        </span>
                    </span>
                </a>
            </div>
        </main>
    )
}
