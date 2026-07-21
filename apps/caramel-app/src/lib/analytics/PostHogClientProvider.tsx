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
    // The last distinctId we identified, so we only call identify/reset on an
    // actual identity transition (not on every session-object re-reference).
    const identifiedRef = useRef<string | null>(null)

    useEffect(() => {
        activeRef.current = initPosthogBrowser()
    }, [])

    useEffect(() => {
        if (!activeRef.current) return
        const userId = session?.user?.id ?? null

        if (userId && identifiedRef.current !== userId) {
            identifyUser({ id: userId, email: session?.user?.email })
            identifiedRef.current = userId
        } else if (!userId && identifiedRef.current) {
            resetPosthogIdentity()
            identifiedRef.current = null
        }
    }, [session])

    return <>{children}</>
}
