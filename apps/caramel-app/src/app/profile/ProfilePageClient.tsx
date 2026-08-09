'use client'

import SectionSkeleton from '@/components/profile/SectionSkeleton'
import { useSession } from '@/lib/auth/client'
import {
    noticeBodyClasses,
    noticeButtonClasses,
    noticeClasses,
    noticeTitleClasses,
} from '@/lib/profile/profileStyles'
import type { FavoriteStoreSummary } from '@/lib/profile/types'
import { useProfileOverview } from '@/lib/profile/useProfileOverview'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import AccountDetailsCard from './sections/AccountDetailsCard'
import AccountHeaderCard from './sections/AccountHeaderCard'
import DataPrivacySection from './sections/DataPrivacySection'
import FavoriteStoresSection from './sections/FavoriteStoresSection'
import GetStartedChecklist from './sections/GetStartedChecklist'
import ImpactStrip from './sections/ImpactStrip'
import ReportsImpactSection from './sections/ReportsImpactSection'
import SavingsSection from './sections/SavingsSection'

export default function ProfilePageClient() {
    const { data: session, isPending } = useSession()
    const router = useRouter()
    // The session lives in a cookie the client reads for itself, so the server
    // always renders the pending branch while a client that already has the
    // session in its store renders the profile on its very first pass — a
    // hydration mismatch that made React throw the whole tree away. Holding the
    // pending branch until mounted makes the hydrating render match the server;
    // the real state lands one commit later, before paint.
    const [mounted, setMounted] = useState(false)

    useEffect(() => setMounted(true), [])

    useEffect(() => {
        if (mounted && !isPending && !session?.user) {
            router.push('/login')
        }
    }, [mounted, session, isPending, router])

    // Only fetch once we know there IS a session — firing an authenticated
    // request before that turns every signed-out visit into a spurious 401.
    const signedIn = Boolean(mounted && !isPending && session?.user)
    const { overview, status, retry, patchOverview } =
        useProfileOverview(signedIn)

    if (!mounted || isPending) {
        return (
            <main className="relative -mt-[6.7rem] w-full">
                <div className="container mx-auto px-4 py-16">
                    <div className="flex items-center justify-center">
                        <div className="text-lg font-medium text-gray-500 dark:text-gray-400">
                            Loading...
                        </div>
                    </div>
                </div>
            </main>
        )
    }

    if (!session?.user) {
        return null
    }

    const user = session.user

    function removeFavorite(domain: string) {
        patchOverview(current => ({
            ...current,
            favorites: current.favorites.filter(f => f.domain !== domain),
        }))
    }

    function restoreFavorite(store: FavoriteStoreSummary) {
        patchOverview(current =>
            current.favorites.some(f => f.domain === store.domain)
                ? current
                : {
                      ...current,
                      favorites: [store, ...current.favorites].sort((a, b) =>
                          b.starredAt.localeCompare(a.starredAt),
                      ),
                  },
        )
    }

    function applySyncChange(enabled: boolean) {
        patchOverview(current => ({
            ...current,
            savings: { ...current.savings, syncEnabled: enabled },
        }))
    }

    /** Back to the zero state, without a refetch: the delete is transactional
     * and its counts are exactly these three collections. */
    function applyDataDeleted() {
        patchOverview(current => ({
            ...current,
            savings: {
                ...current.savings,
                eventCount: 0,
                storeCount: 0,
                totals: [],
                firstEventAt: null,
                recentEvents: [],
            },
            favorites: [],
            reports: {
                reportCount: 0,
                confirmedCount: null,
                shoppersHelped: null,
            },
        }))
    }

    // Every stat at zero => the checklist replaces the impact strip. This is
    // the DEFAULT state for most people arriving here, not an edge case.
    const isZeroState =
        overview !== null &&
        overview.savings.eventCount === 0 &&
        overview.favorites.length === 0 &&
        overview.reports.reportCount === 0

    return (
        <main className="relative -mt-[6.7rem] w-full">
            <div className="container mx-auto px-4 py-16 md:py-12 xs:px-3 xs:py-8">
                <div className="mx-auto max-w-3xl space-y-10 md:space-y-8">
                    {/* Renders immediately from the session — never waits on
                        the overview, so there is no whole-page spinner. */}
                    <AccountHeaderCard
                        user={user}
                        memberSince={overview?.memberSince ?? null}
                    />

                    {status === 'loading' ? (
                        <SectionSkeleton />
                    ) : status === 'error' ? (
                        <div role="alert" className={noticeClasses}>
                            <p className={noticeTitleClasses}>
                                We couldn&apos;t load your savings and stores
                            </p>
                            <p className={noticeBodyClasses}>
                                Nothing is lost — this is on our side. Try again
                                in a moment.
                            </p>
                            <button
                                type="button"
                                onClick={retry}
                                className={noticeButtonClasses}
                            >
                                Try again
                            </button>
                        </div>
                    ) : overview ? (
                        <>
                            {isZeroState ? (
                                <GetStartedChecklist overview={overview} />
                            ) : (
                                <ImpactStrip overview={overview} />
                            )}

                            <SavingsSection
                                savings={overview.savings}
                                onSyncChange={applySyncChange}
                            />

                            <FavoriteStoresSection
                                favorites={overview.favorites}
                                hasExtensionActivity={
                                    overview.hasExtensionActivity
                                }
                                onRemove={removeFavorite}
                                onRestore={restoreFavorite}
                            />

                            <ReportsImpactSection reports={overview.reports} />
                        </>
                    ) : null}

                    {/* Both render from the session, so they stay real content
                        even when the overview failed. */}
                    <AccountDetailsCard user={user} />
                    <DataPrivacySection
                        overview={overview}
                        onDeleted={applyDataDeleted}
                    />
                </div>
            </div>
        </main>
    )
}
