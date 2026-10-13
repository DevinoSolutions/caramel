'use client'

import { endClientSession } from '@/lib/auth/endClientSession'
import { promptSupportOnFailure } from '@/lib/feedback/promptSupportOnFailure'
import type { ProfileOverview } from '@/lib/profile/types'
import * as Sentry from '@sentry/nextjs'
import { useCallback, useEffect, useState } from 'react'

// The single data hook for the account page. One request, one shape, one
// failure mode — see the route's header for why four sections share one fetch.
//
// No SWR/react-query here: this page fetches exactly one endpoint, once, for a
// signed-in user, and adding a cache layer for that would be more machinery
// than the problem has.

// Where a session the server no longer honours is sent to sign in again.
// TODO: /login has no return-path support (it always lands on `/` after
// sign-in, LoginPageClient.tsx; same note in AddCodeForm.tsx), so this cannot
// bring the user back to /profile yet. Adding a vetted `next` param is its own
// change (open-redirect surface).
const LOGIN_PATH = '/login'

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
 *
 * A 401 that arrives anyway means the client believes it is signed in (the
 * session cookie is still there) while the server rejects that session —
 * expired or revoked. That is a signed-out user, not a fault: the hook clears
 * the client session and sends them to sign in, and neither reports an error
 * to Sentry (CARAMEL-N: one such user reported it on every visit) nor shows
 * the error notice. Any other non-OK status keeps the error path.
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
                if (res.status === 401) {
                    // A breadcrumb, not an event: it explains the redirect if
                    // anything later in this session does get reported.
                    Sentry.addBreadcrumb({
                        category: 'profile',
                        level: 'info',
                        message:
                            'Overview returned 401 for a client-side session; ending it and redirecting to sign in',
                    })
                    // Failures here are reported inside endClientSession and
                    // must not strand the user on a page that cannot load.
                    await endClientSession()
                    // Clearing the session flips the page's own signed-out
                    // state, which disables this hook (cancelled) while
                    // ProfilePageClient pushes /login itself; and a user who
                    // already navigated away must not be pulled back. Either
                    // way the navigation here is moot.
                    if (cancelled) return
                    // Stays in 'loading' (the page's skeleton) until the
                    // navigation lands: no error notice flashes first.
                    window.location.assign(LOGIN_PATH)
                    return
                }
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
