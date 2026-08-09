'use client'

import { useSession } from '@/lib/auth/client'
import { promptSupportOnFailure } from '@/lib/feedback/promptSupportOnFailure'
import { useCallback, useEffect, useState } from 'react'
import { FaRegStar, FaStar } from 'react-icons/fa'
import { toast } from 'sonner'

// The "follow this store" star on /coupons/[store].
//
// PLACEMENT IS DELIBERATE AND NARROW. It goes on the store page and nowhere
// else: SiteCard (/supported-stores) and CouponCard (/coupons) are both inside
// the eight visual-regression baselines, so a star in either would turn this
// into an eight-screenshot diff. /coupons/[store] has no baseline. Grid-wide
// starring, if it ever ships, is its own PR with an intentional baseline update.
//
// SIGNED-OUT RENDERS NOTHING. Not a disabled star, not a "sign in to follow"
// stub: a control that exists only to bounce someone into a login form is worse
// than no control, and the store page's job is showing codes. Following is
// taught where it can actually be performed — the extension popup and the
// account page's empty state.

/** `aria-pressed` is what a toggle BUTTON announces (a switch would be
 * `aria-checked`; this is a button). Labels name the store so the control makes
 * sense read on its own out of the page's tab order. */
function starLabel(store: string, following: boolean): string {
    return following
        ? `Remove ${store} from your stores`
        : `Follow ${store} to keep its best codes one click away`
}

export default function StoreFavoriteStar({ store }: { store: string }) {
    const { data: session, isPending } = useSession()
    // Same hydration hazard the profile page documents: the session lives in a
    // cookie the CLIENT reads for itself, so the server always renders the
    // signed-out branch (nothing) while a warm client would render the star on
    // its very first pass — a mismatch React resolves by throwing the tree away.
    // Holding the null branch until mounted makes the hydrating render match the
    // server; the real state lands one commit later, before paint.
    const [mounted, setMounted] = useState(false)
    const [following, setFollowing] = useState(false)
    const [busy, setBusy] = useState(false)

    useEffect(() => setMounted(true), [])

    const signedIn = Boolean(session?.user)

    // Current state comes from the list endpoint rather than a per-store probe:
    // one route, one shape, and the account page needs the same list anyway.
    useEffect(() => {
        if (!signedIn) return
        let cancelled = false
        fetch('/api/account/favorites')
            .then(res => (res.ok ? res.json() : null))
            .then((data: { favorites?: { store: string }[] } | null) => {
                if (cancelled || !data?.favorites) return
                setFollowing(data.favorites.some(f => f.store === store))
            })
            .catch(() => {
                // A failed READ leaves the star showing "not following", which
                // is the honest default: the next click sends a PUT, which is
                // idempotent, so a wrong guess here cannot corrupt anything.
                // Deliberately silent — this is a passive state fetch the user
                // never asked for, and promptSupportOnFailure is for actions
                // the user SEES fail.
            })
        return () => {
            cancelled = true
        }
    }, [signedIn, store])

    const write = useCallback(
        async (next: boolean) => {
            const res = await fetch(
                `/api/account/favorites/${encodeURIComponent(store)}`,
                { method: next ? 'PUT' : 'DELETE' },
            )
            if (!res.ok) throw new Error(`favorites ${res.status}`)
        },
        [store],
    )

    const toggle = useCallback(async () => {
        if (busy) return
        const next = !following
        setBusy(true)
        // Optimistic: the star flips now. Both writes are idempotent, so the
        // only thing a failure has to undo is this local flip.
        setFollowing(next)
        try {
            await write(next)
            if (next) {
                toast.success(`Following ${store}.`)
            } else {
                // Undo is not optional on the unstar. The star is a small
                // target and a mis-tap that silently drops a followed store is
                // exactly the failure this affordance invites.
                toast(`Removed ${store} from your stores.`, {
                    action: {
                        label: 'Undo',
                        onClick: () => {
                            setFollowing(true)
                            write(true).catch(error => {
                                setFollowing(false)
                                toast.error(
                                    `Couldn’t add ${store} back. Please try again.`,
                                )
                                promptSupportOnFailure({
                                    error,
                                    operation: 'favorite_store_undo',
                                })
                            })
                        },
                    },
                })
            }
        } catch (error) {
            setFollowing(!next)
            toast.error(
                next
                    ? `Couldn’t follow ${store}. Please try again.`
                    : `Couldn’t remove that store. It’s still on your list.`,
            )
            promptSupportOnFailure({
                error,
                operation: 'favorite_store_toggle',
            })
        } finally {
            setBusy(false)
        }
    }, [busy, following, store, write])

    if (!mounted || isPending || !signedIn) return null

    const Icon = following ? FaStar : FaRegStar

    return (
        <div className="mt-5 flex justify-center">
            <button
                type="button"
                onClick={toggle}
                aria-pressed={following}
                aria-label={starLabel(store, following)}
                disabled={busy}
                // min-h/min-w keep the tap target at 44px on the phone
                // viewports this page is most often read on. The focus ring
                // comes free from globals.css's :focus-visible rule for
                // buttons — no competing ring here.
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 shadow-sm transition duration-200 hover:border-caramel hover:bg-caramel/5 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-darkBg dark:text-gray-200 dark:shadow-none dark:hover:border-caramel/60 dark:hover:bg-caramel/10"
            >
                <Icon aria-hidden="true" className="h-4 w-4 text-caramel" />
                {following ? 'Following' : 'Follow this store'}
            </button>
        </div>
    )
}
