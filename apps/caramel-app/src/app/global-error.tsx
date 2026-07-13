'use client'

import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'

// F-011 — last-resort error boundary: fires only when the ROOT layout
// itself throws (Providers, globals.css, etc. never rendered). Next.js
// requires this file to render its own <html>/<body> because it REPLACES
// the root layout — see
// https://nextjs.org/docs/app/api-reference/file-conventions/error#global-error.
// Deliberately dependency-free: no Providers, no data fetching, no Tailwind
// classes (the stylesheet the root layout would normally pull in may not be
// present), inline styles only — none of that has a chance to be the thing
// that throws *again* while rendering the fallback for a throw.
const styles = {
    main: {
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column' as const,
        alignItems: 'center',
        justifyContent: 'center',
        gap: '16px',
        padding: '24px',
        textAlign: 'center' as const,
        fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        backgroundColor: '#f9f9f9',
        color: '#191a1c',
    },
    heading: {
        fontSize: '24px',
        fontWeight: 700,
        margin: 0,
    },
    body: {
        maxWidth: '420px',
        color: '#4b5563',
        margin: 0,
    },
    actions: {
        display: 'flex',
        gap: '12px',
        marginTop: '8px',
    },
    button: {
        backgroundColor: '#ea6925',
        color: '#ffffff',
        border: 'none',
        borderRadius: '999px',
        padding: '10px 24px',
        fontWeight: 600,
        fontSize: '14px',
        cursor: 'pointer',
    },
    link: {
        color: '#191a1c',
        border: '1px solid #d1d5db',
        borderRadius: '999px',
        padding: '10px 24px',
        fontWeight: 600,
        fontSize: '14px',
        textDecoration: 'none',
    },
}

export default function GlobalError({
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
        <html lang="en">
            <body>
                <main style={styles.main}>
                    <h2 style={styles.heading}>Something went wrong</h2>
                    <p style={styles.body}>
                        Caramel hit an unexpected error and couldn&apos;t
                        recover automatically. It&apos;s been reported — please
                        try again.
                    </p>
                    <div style={styles.actions}>
                        <button onClick={() => reset()} style={styles.button}>
                            Try again
                        </button>
                        {/* Deliberately a raw <a>, not next/link's <Link>:
                        this boundary must survive a broken root
                        layout/router state, and next/link depends on
                        client router context that may not survive whatever
                        broke the root layout. Lint exception for this rule
                        is file-scoped in the root eslint.config.mjs. */}
                        <a href="/" style={styles.link}>
                            Go home
                        </a>
                    </div>
                </main>
            </body>
        </html>
    )
}
