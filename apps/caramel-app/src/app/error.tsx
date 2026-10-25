'use client'

import { reportUserVisibleFailure } from '@/lib/feedback/reportUserVisibleFailure'
import Image from 'next/image'
import Link from 'next/link'
import { useEffect } from 'react'

// F-011 — App-Router error boundary. Before this file, any uncaught render
// throw in a route segment (e.g. the per-store SSR page — see
// coupons/[store]/page.tsx) fell through to Next's default, unbranded error
// page with no Sentry-context enrichment beyond instrumentation.ts's
// onRequestError. Renders inside the root layout (Providers/globals.css
// still apply), so brand tokens (bg-caramel / dark:bg-darkBg) are safe to
// use here — unlike global-error.tsx, which replaces the root layout
// entirely and must stay dependency-free.
export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    useEffect(() => {
        // Reports to Sentry AND (first occurrence per session) PostHog, with
        // the two correlated by the Sentry event id.
        reportUserVisibleFailure({
            error,
            operation: 'app_route_render',
            errorCode: error.digest,
        })
    }, [error])

    return (
        <main className="dark:bg-darkBg flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 px-6 text-center">
            <Image
                src="/logo-light.png"
                alt=""
                aria-hidden="true"
                width={56}
                height={56}
                className="rounded-2xl shadow-sm"
            />
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                Something went wrong
            </h2>
            <p className="max-w-md text-gray-600 dark:text-gray-300">
                We hit an unexpected error loading this page. It&apos;s been
                reported — please try again, or head back to the homepage.
            </p>
            <div className="mt-2 flex gap-3">
                <button
                    onClick={() => reset()}
                    className="bg-caramel hover:bg-caramelLight focus-visible:ring-caramel dark:focus-visible:ring-offset-darkBg rounded-full px-6 py-2 font-semibold text-white shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                >
                    Try again
                </button>
                <Link
                    href="/"
                    className="focus-visible:ring-caramel/60 rounded-full border border-gray-300 px-6 py-2 font-semibold text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                    Go home
                </Link>
            </div>
        </main>
    )
}
