'use client'

import ProfileNav, {
    type ProfileNavItem,
} from '@/components/profile/ProfileNav'
import SectionSkeleton from '@/components/profile/SectionSkeleton'
import { useSession } from '@/lib/auth/client'
import {
    noticeBodyClasses,
    noticeButtonClasses,
    noticeClasses,
    noticeTitleClasses,
    pageContainerClasses,
    pageShellClasses,
    sectionScrollOffsetClasses,
} from '@/lib/profile/profileStyles'
import type { FavoriteStoreSummary } from '@/lib/profile/types'
import { useProfileOverview } from '@/lib/profile/useProfileOverview'
import { useReducedMotion } from '@/lib/reducedMotion'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import AccountDetailsCard from './sections/AccountDetailsCard'
import AccountHeaderCard from './sections/AccountHeaderCard'
import DataPrivacySection from './sections/DataPrivacySection'
import FavoriteStoresSection from './sections/FavoriteStoresSection'
import GetStartedChecklist from './sections/GetStartedChecklist'
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

    // Honour a deep link (/profile#savings) ONCE the target section exists.
    //
    // The browser resolves the fragment during load, but the data-backed
    // sections render only after the overview fetch resolves — so on a cold
    // load the element the fragment names does not exist yet and the native
    // scroll silently no-ops. The extension popup's "Manage account" link is a
    // real entry point that deep-links here, so a fragment that quietly does
    // nothing is a broken contract rather than a cosmetic miss.
    //
    // Guarded by a ref so this fires at most once: re-scrolling the page under
    // someone who has since scrolled away (a favorite removal re-renders this
    // tree) would be worse than not scrolling at all.
    const deepLinkHandled = useRef(false)
    const prefersReducedMotion = useReducedMotion()

    useEffect(() => {
        if (deepLinkHandled.current || status !== 'ready') return
        const id = window.location.hash.slice(1)
        if (!id) return
        const target = document.getElementById(id)
        if (!target) return
        deepLinkHandled.current = true
        target.scrollIntoView({
            // globals.css sets `scroll-behavior: smooth`, which the app already
            // disables under prefers-reduced-motion — match that here rather
            // than forcing a smooth scroll past the preference.
            behavior: prefersReducedMotion ? 'auto' : 'smooth',
            block: 'start',
        })
    }, [status, prefersReducedMotion])

    if (!mounted || isPending) {
        return (
            <main className={pageShellClasses}>
                <div className={pageContainerClasses}>
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

    // Every stat at zero => the get-started checklist leads. This is the
    // DEFAULT state for most people arriving here, not an edge case.
    const isZeroState =
        overview !== null &&
        overview.savings.eventCount === 0 &&
        overview.favorites.length === 0 &&
        overview.reports.reportCount === 0

    function scrollToSavings() {
        document.getElementById('savings')?.scrollIntoView({
            behavior: prefersReducedMotion ? 'auto' : 'smooth',
            block: 'start',
        })
    }

    // The menu is built from the sections ACTUALLY rendered, never a fixed
    // list: "Your reports" only exists once the user has reports, and a menu
    // entry pointing at an absent anchor is a dead link.
    const navItems: ProfileNavItem[] = [{ id: 'overview', label: 'Overview' }]
    if (overview) {
        if (isZeroState)
            navItems.push({ id: 'get-started', label: 'Get started' })
        navItems.push({ id: 'savings', label: 'Savings' })
        navItems.push({ id: 'favorites', label: 'Stores' })
        if (overview.reports.reportCount > 0) {
            navItems.push({ id: 'reports', label: 'Reports' })
        }
    }
    navItems.push({ id: 'account', label: 'Account' })
    navItems.push({ id: 'data', label: 'Data & privacy' })

    return (
        <main className={pageShellClasses}>
            <div className={pageContainerClasses}>
                <div className="mx-auto grid max-w-5xl grid-cols-[13rem_minmax(0,1fr)] gap-10 lg:grid-cols-1 lg:gap-0">
                    {/* Column 1: the section menu. Renders the desktop rail and
                        the small-screen chip row; each hides itself at the
                        breakpoint the other owns. */}
                    <ProfileNav items={navItems} />

                    {/* Column 2: the sections. */}
                    <div className="min-w-0 space-y-8 md:space-y-6">
                        {/* Renders immediately from the session — never waits
                            on the overview, so there is no whole-page
                            spinner. */}
                        <div
                            id="overview"
                            className={sectionScrollOffsetClasses}
                        >
                            <AccountHeaderCard
                                user={user}
                                overview={overview}
                                onTurnOnSync={scrollToSavings}
                            />
                        </div>

                        {status === 'loading' ? (
                            <SectionSkeleton />
                        ) : status === 'error' ? (
                            <div role="alert" className={noticeClasses}>
                                <p className={noticeTitleClasses}>
                                    We couldn&apos;t load your savings and
                                    stores
                                </p>
                                <p className={noticeBodyClasses}>
                                    Nothing is lost — this is on our side. Try
                                    again in a moment.
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
                                ) : null}

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

                                <ReportsImpactSection
                                    reports={overview.reports}
                                />
                            </>
                        ) : null}

                        {/* Both render from the session, so they stay real
                            content even when the overview failed. */}
                        <AccountDetailsCard user={user} />
                        <DataPrivacySection
                            overview={overview}
                            onDeleted={applyDataDeleted}
                        />
                    </div>
                </div>
            </div>
        </main>
    )
}
