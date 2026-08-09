'use client'

import EmptyState from '@/components/profile/EmptyState'
import ProfileSection from '@/components/profile/ProfileSection'
import { CHROME_WEB_STORE_URL } from '@/lib/brandLinks'
import { promptSupportOnFailure } from '@/lib/feedback/promptSupportOnFailure'
import {
    cardClasses,
    linkRowFocusClasses,
    listRowClasses,
    secondaryButtonClasses,
    tintedCardClasses,
} from '@/lib/profile/profileStyles'
import type { FavoriteStoreSummary } from '@/lib/profile/types'
import Image from 'next/image'
import Link from 'next/link'
import { FaStar } from 'react-icons/fa'
import { toast } from 'sonner'

// Favorites live in a single card of ROWS, not a grid of SiteCard tiles:
// these are a list the user scans, and eight big gradient tiles would make a
// wall out of it.
//
// The star is NOT added to SiteCard (/supported-stores) or CouponCard
// (/coupons) — both are visual-regression baselined, and starring there would
// turn a profile PR into an eight-baseline diff. Grid-wide starring is its own
// later PR with an intentional baseline update.
//
// The PUT/DELETE routes are owned by the favorites PR (feat/login-favorites);
// their contract is fixed: `/api/account/favorites/:store`, idempotent, the
// segment being the normalized registrable domain that favorite_stores.
// store_name already holds — so the value read out of the overview drops
// straight in with no re-normalizing.

function faviconFor(domain: string): string {
    return `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(
        domain,
    )}`
}

export default function FavoriteStoresSection({
    favorites,
    hasExtensionActivity,
    onRemove,
    onRestore,
}: {
    favorites: FavoriteStoreSummary[]
    hasExtensionActivity: boolean
    /** Optimistically drop the row from the loaded overview. */
    onRemove: (domain: string) => void
    /** Put it back — undo, or a failed delete. */
    onRestore: (store: FavoriteStoreSummary) => void
}) {
    async function callFavorite(domain: string, method: 'PUT' | 'DELETE') {
        const res = await fetch(
            `/api/account/favorites/${encodeURIComponent(domain)}`,
            { method, credentials: 'include' },
        )
        if (!res.ok) throw new Error(`${method} favorite failed: ${res.status}`)
    }

    async function restore(store: FavoriteStoreSummary) {
        onRestore(store)
        try {
            await callFavorite(store.domain, 'PUT')
        } catch (error) {
            // The row is back on screen but the server disagrees — drop it
            // again rather than leave a row that will vanish on next load.
            onRemove(store.domain)
            toast.error("Couldn't remove that store. It's still on your list.")
            promptSupportOnFailure({
                error,
                operation: 'favorite_store_restore',
            })
        }
    }

    async function unstar(store: FavoriteStoreSummary) {
        // Optimistic: the row leaves immediately. Undo is NOT optional here —
        // the star is a small target beside a full-row link, and a mis-tap
        // that silently destroys the row is exactly what this invites.
        onRemove(store.domain)
        toast(`Removed ${store.domain} from your stores.`, {
            action: { label: 'Undo', onClick: () => void restore(store) },
        })
        try {
            await callFavorite(store.domain, 'DELETE')
        } catch (error) {
            onRestore(store)
            toast.error("Couldn't remove that store. It's still on your list.")
            promptSupportOnFailure({
                error,
                operation: 'favorite_store_remove',
            })
        }
    }

    return (
        <ProfileSection
            id="favorites"
            title="Stores you follow"
            description="Your starred stores, with their best working codes."
        >
            {favorites.length === 0 ? (
                <div className={tintedCardClasses}>
                    <EmptyState
                        icon="⭐"
                        heading="Follow the stores you shop"
                        body="Star a store and its best working codes are always one click away — in the extension and here."
                        footnote={
                            hasExtensionActivity
                                ? "Two ways to star a store: open the Caramel extension while you're on a store and tap the star, or find the store on our site and star it there."
                                : 'Get the Caramel extension first — starring happens while you shop, right from the popup.'
                        }
                        actions={
                            <>
                                <Link
                                    href="/supported-stores"
                                    className={secondaryButtonClasses}
                                >
                                    Browse supported stores
                                </Link>
                                {/* Telling someone without the extension to
                                    use it is a dead end — give them the way
                                    to get it. */}
                                {hasExtensionActivity ? null : (
                                    <a
                                        href={CHROME_WEB_STORE_URL}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className={secondaryButtonClasses}
                                    >
                                        Get the extension
                                    </a>
                                )}
                            </>
                        }
                    />
                </div>
            ) : (
                <div className={cardClasses}>
                    {favorites.map(store => (
                        <div key={store.domain} className={listRowClasses}>
                            <Link
                                href={`/coupons/${encodeURIComponent(store.domain)}`}
                                className={`flex min-w-0 flex-1 items-center gap-4 ${linkRowFocusClasses}`}
                            >
                                <Image
                                    src={faviconFor(store.domain)}
                                    alt=""
                                    width={40}
                                    height={40}
                                    className="h-10 w-10 shrink-0 rounded-lg"
                                    unoptimized
                                />
                                <div className="min-w-0">
                                    <p className="truncate font-medium text-gray-900 dark:text-white">
                                        {store.domain}
                                    </p>
                                    {/* Only ever a REAL count — no "0 codes"
                                        and no placeholder. */}
                                    {store.couponCount !== null &&
                                    store.couponCount > 0 ? (
                                        <p className="text-sm text-gray-500 dark:text-gray-400">
                                            {store.couponCount}{' '}
                                            {store.couponCount === 1
                                                ? 'code'
                                                : 'codes'}{' '}
                                            right now
                                        </p>
                                    ) : null}
                                </div>
                            </Link>
                            {/* Sized for two controls so the dormant
                                "notify me" toggle can land here later without
                                reflowing the row. */}
                            <div className="flex shrink-0 items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => void unstar(store)}
                                    aria-pressed={true}
                                    aria-label={`Remove ${store.domain} from your stores`}
                                    className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-caramel transition hover:bg-caramel/10"
                                >
                                    <FaStar
                                        aria-hidden="true"
                                        className="h-5 w-5"
                                    />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </ProfileSection>
    )
}
