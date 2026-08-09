'use client'

import { promptSupportOnFailure } from '@/lib/feedback/promptSupportOnFailure'
import type { ProfileOverview } from '@/lib/profile/types'
import { useCallback, useEffect, useState } from 'react'

// The single data hook for the account page. One request, one shape, one
// failure mode — see the route's header for why four sections share one fetch.
//
// No SWR/react-query here: this page fetches exactly one endpoint, once, for a
// signed-in user, and adding a cache layer for that would be more machinery
// than the problem has.

export type OverviewStatus = 'loading' | 'ready' | 'error'

export interface UseProfileOverviewResult {
    overview: ProfileOverview | null
    status: OverviewStatus
    /** Re-run the fetch (the error notice's "Try again"). */
    retry: () => void
    /**
     * Apply a local change to the loaded overview — used for optimistic
     * favorite removal and for folding a confirmed sync-toggle response back
     * in, so the page never needs a full refetch to stay honest. A no-op when
     * nothing is loaded yet.
     */
    patchOverview: (
        update: (current: ProfileOverview) => ProfileOverview,
    ) => void
}

/**
 * @param enabled false while the session is still resolving — the page must
 * not fire an authenticated request before it knows there is a session, or
 * every signed-out visit would produce a spurious 401.
 */
export function useProfileOverview(enabled: boolean): UseProfileOverviewResult {
    const [overview, setOverview] = useState<ProfileOverview | null>(null)
    const [status, setStatus] = useState<OverviewStatus>('loading')
    const [attempt, setAttempt] = useState(0)

    useEffect(() => {
        if (!enabled) return
        let cancelled = false

        setStatus('loading')
        void (async () => {
            try {
                const res = await fetch('/api/account/overview', {
                    credentials: 'include',
                })
                if (!res.ok) {
                    throw new Error(
                        `Overview request failed with ${res.status}`,
                    )
                }
                const data = (await res.json()) as ProfileOverview
                if (cancelled) return
                setOverview(data)
                setStatus('ready')
            } catch (error) {
                if (cancelled) return
                setStatus('error')
                // A user-visible failure: the savings and stores sections
                // visibly do not load. Reported once per session per
                // operation by promptSupportOnFailure's own rate limit.
                promptSupportOnFailure({
                    error,
                    operation: 'profile_overview_load',
                })
            }
        })()

        return () => {
            cancelled = true
        }
    }, [enabled, attempt])

    const retry = useCallback(() => setAttempt(n => n + 1), [])

    const patchOverview = useCallback(
        (update: (current: ProfileOverview) => ProfileOverview) => {
            setOverview(current => (current ? update(current) : current))
        },
        [],
    )

    return { overview, status, retry, patchOverview }
}
