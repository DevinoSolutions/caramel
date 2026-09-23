'use client'
// src/lib/analytics/PostHogClientProvider.tsx
//
// Mounts once inside the app providers: initialises posthog-js (when a dataset
// is configured) and keeps the PostHog identity in sync with the Better Auth
// session — identify on login, reset on logout. Renders its children
// unchanged; it is a side-effect wrapper, not a React context.
import { useSession } from '@/lib/auth/client'
import { useEffect, useRef, type ReactNode } from 'react'
import {
    identifyUser,
    initPosthogBrowser,
    resetPosthogIdentity,
    setSentryUser,
} from './identity'

export default function PostHogClientProvider({
    children,
}: {
    children: ReactNode
}) {
    const { data: session } = useSession()
    // Whether posthog init succeeded (a target is configured). Ref, not state:
    // no re-render needed and the effect below reads the latest value.
    const activeRef = useRef(false)
    // The last distinctId we identified — enough to know whether a logout
    // needs a reset. Skipping an unchanged identify is NOT this ref's job:
    // profile edits (name, username) must re-send, so identity.ts dedupes on
    // the full payload instead and we can call it on every session change.
    const identifiedRef = useRef<string | null>(null)

    useEffect(() => {
        activeRef.current = initPosthogBrowser()
    }, [])

    useEffect(() => {
        const user = session?.user ?? null

        // Sentry's user field is synced on EVERY identity transition, whether
        // or not PostHog has a capture target. They are different systems with
        // different configuration: a deploy with no PostHog key must still
        // produce Sentry issues attributable to an account. (Before this, the
        // only identity call lived behind the PostHog guard below, and
        // `Sentry.setUser` was never called at all.)
        setSentryUser(user?.id ?? null)

        if (!activeRef.current) return

        if (user) {
            // Called on every session change on purpose: identity.ts dedupes on
            // the full payload, so a profile edit re-sends and an unchanged
            // session does not.
            identifyUser({
                id: user.id,
                email: user.email,
                name: user.name,
                firstName: user.firstName,
                lastName: user.lastName,
                username: user.username,
                createdAt: user.createdAt,
            })
            identifiedRef.current = user.id
        } else if (identifiedRef.current) {
            resetPosthogIdentity()
            identifiedRef.current = null
        }
    }, [session])

    return <>{children}</>
}
