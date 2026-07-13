'use client'

import * as Sentry from '@sentry/nextjs'
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
        Sentry.captureException(error)
    }, [error])

    return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center dark:bg-darkBg">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                Something went wrong
            </h2>
            <p className="max-w-md text-gray-600 dark:text-gray-300">
                We hit an unexpected error loading this page. It&apos;s been
                reported — please try again, or head back to the homepage.
            </p>
            <div className="flex gap-3">
                <button
                    onClick={() => reset()}
                    className="rounded-full bg-caramel px-6 py-2 font-semibold text-white transition-colors hover:bg-caramelLight"
                >
                    Try again
                </button>
                <Link
                    href="/"
                    className="rounded-full border border-gray-300 px-6 py-2 font-semibold text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
                >
                    Go home
                </Link>
            </div>
        </main>
    )
}
