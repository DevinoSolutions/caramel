import { useCallback, useEffect, useRef, useState } from 'react'
import { caramelSendMessage, log } from '../../../caramel-base.js'
import { fetchCouponsPage } from '../../../coupon-fetch.js'
import {
    COUPON_PAGE_EMPTY_LIMIT,
    GUEST_COUPON_LIMIT,
    couponIdentity,
    signOutAndRevoke,
} from '../../../popup-core.js'
import { caramelCopyText } from '../../../UI-helpers.js'
import { CouponCard } from '../components/CouponCard'
import { SavingsBanner } from '../components/SavingsBanner'
import { useToast } from '../components/toast'
import type { AppApi, Coupon, CouponsPage, PopupUser } from '../types'

/**
 * The coupon list (P2 React successor to popup.js renderCouponsView): the
 * store header, the lifetime-savings banner, and the list itself — page 1 from
 * props, every page after it fetched as the shopper scrolls.
 */

/** Paging state for ONE mount. Mutable on purpose: it is read and advanced
 *  inside an async loader that must never see a stale copy of itself, and
 *  nothing in it is rendered except `total` (which a repaint always follows). */
interface PagingState {
    page: number
    total: number
    hasMore: boolean
    loading: boolean
    /** Consecutive all-duplicate pages, against COUPON_PAGE_EMPTY_LIMIT. */
    empty: number
    /** couponIdentity of every row already on screen — offset paging over a
     *  live catalog can hand the same row back across a page boundary. */
    seen: Set<string>
}

type FooterState = 'idle' | 'loading' | 'error' | 'end'

/** Stroke star when not following, filled when following — the popup's icon
 *  convention (16px, currentColor), so it inherits .coupons-logout-button's
 *  brand colour and its dark value from --cm-* with no colour of its own. */
function FavoriteStar({ following }: { following: boolean }) {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill={following ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.8l6.5-.9z" />
        </svg>
    )
}

/**
 * Follow-this-store star. Asks the account what it follows, paints the true
 * state, then toggles on click. Every call goes through caramelSendMessage →
 * background.js, never a direct fetch — the bearer lives in the worker's read
 * path, the one place any API call attaches it.
 *
 * DISABLED until the account answers, and it STAYS disabled if the answer
 * never comes (offline, dead session). An enabled star showing a guessed state
 * invites a click that writes the opposite of what the user is looking at; a
 * brief disabled beat does not, and following is not why the popup is open.
 */
function FavoriteStoreButton({ domain }: { domain: string }) {
    const showToast = useToast()
    const [following, setFollowing] = useState(false)
    const [answered, setAnswered] = useState(false)
    const [writing, setWriting] = useState(false)

    useEffect(() => {
        let alive = true
        caramelSendMessage({ action: 'getFavoriteStores' })
            .then((resp: { error?: string; favorites?: unknown[] }) => {
                if (!alive) return
                if (!resp || resp.error || !Array.isArray(resp.favorites))
                    return
                // Suffix-tolerant match, the same predicate the settings view
                // uses for paused sites: the popup knows the tab hostname
                // ("shop.nike.com") while the account is keyed on the
                // registrable domain ("nike.com").
                setFollowing(
                    resp.favorites.some(
                        f =>
                            typeof (f as { store?: unknown })?.store ===
                                'string' &&
                            (domain === (f as { store: string }).store ||
                                domain.endsWith(
                                    '.' + (f as { store: string }).store,
                                )),
                    ),
                )
                setAnswered(true)
            })
            .catch((err: Error) => log('FAVORITES_LOAD_FAILED', err?.message))
        return () => {
            alive = false
        }
    }, [domain])

    const label = following ? `Unfollow ${domain}` : `Follow ${domain}`
    const disabled = !answered || writing

    const toggle = () => {
        if (disabled) return
        const next = !following
        // Optimistic, then reconciled: both writes are idempotent, so the only
        // thing a failure has to undo is this local flip.
        setFollowing(next)
        setWriting(true)
        caramelSendMessage({
            action: 'setFavoriteStore',
            site: domain,
            favorite: next,
        })
            .then((resp: { error?: string; favorited?: boolean }) => {
                if (!resp || resp.error)
                    throw new Error(resp?.error || 'failed')
                setFollowing(Boolean(resp.favorited))
                showToast(
                    resp.favorited
                        ? `Following ${domain}`
                        : `Unfollowed ${domain}`,
                )
            })
            .catch((err: Error) => {
                setFollowing(!next)
                showToast("Couldn't save that — please try again")
                log('FAVORITE_TOGGLE_FAILED', err?.message)
            })
            .finally(() => setWriting(false))
    }

    return (
        <button
            id="favoriteStoreBtn"
            type="button"
            // Reuses the header button's sizing rather than introducing a
            // control with its own height: popup-sizing pins .coupon-list's
            // 320px cap against everything stacked above it, and a taller
            // header row is what would break it.
            className="coupons-logout-button coupons-icon-button"
            // aria-pressed (not aria-checked): this is a toggle BUTTON, not a
            // switch.
            aria-pressed={following}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={toggle}
        >
            <FavoriteStar following={following} />
        </button>
    )
}

function createPaging(
    coupons: Coupon[],
    meta: CouponsPage | undefined,
    guestGated: boolean,
): PagingState {
    return {
        page: typeof meta?.page === 'number' ? meta.page : 1,
        total: typeof meta?.total === 'number' ? meta.total : coupons.length,
        // hasMore is forced off for a gated guest — the gate replaces the
        // pager, so a guest's list never grows past the teaser no matter how
        // the shopper scrolls.
        hasMore: meta?.hasMore === true && coupons.length > 0 && !guestGated,
        loading: false,
        empty: 0,
        seen: new Set(coupons.map(couponIdentity)),
    }
}

/** The guest cap is decided on the CATALOG count, not on how many rows page 1
 *  happened to carry, so the gate advertises the real number. */
const isGuestGated = (user: PopupUser | null, total: number) =>
    !user && total > GUEST_COUPON_LIMIT

export function CouponsView({
    coupons,
    user,
    domain,
    page: meta,
    api,
}: {
    coupons: Coupon[]
    user: PopupUser | null
    domain: string
    page: CouponsPage
    api: AppApi
}) {
    const showToast = useToast()
    const listRef = useRef<HTMLDivElement>(null)
    const footerRef = useRef<HTMLDivElement>(null)
    const observerRef = useRef<IntersectionObserver | null>(null)

    const catalogTotal =
        typeof meta?.total === 'number' ? meta.total : coupons.length
    const guestGated = isGuestGated(user, catalogTotal)

    const pagingRef = useRef<PagingState | null>(null)
    if (pagingRef.current === null)
        pagingRef.current = createPaging(coupons, meta, guestGated)

    const [rows, setRows] = useState<Coupon[]>(coupons)
    const [footerState, setFooterState] = useState<FooterState>('idle')
    // The footer only exists while there is more to fetch. It is also the
    // IntersectionObserver's target: giving it real height (a ghost card, the
    // same shimmer the popup opens with) is what makes crossing into view a
    // reliable signal, and it doubles as the "more is coming" cue.
    const [footerVisible, setFooterVisible] = useState(
        pagingRef.current.hasMore,
    )

    // A new resolve (a 401 signing the popup out, a retry) hands this view a
    // fresh page 1 without remounting it; vanilla repainted the whole list, so
    // the appended pages and the paging state go with it.
    const sourceRef = useRef(meta)
    if (sourceRef.current !== meta) {
        sourceRef.current = meta
        pagingRef.current = createPaging(coupons, meta, guestGated)
        setRows(coupons)
        setFooterState('idle')
        setFooterVisible(pagingRef.current.hasMore)
    }

    const paging = pagingRef.current

    const copyCode = useCallback(
        async (code: string) => {
            // Robust copy (shared caramelCopyText): the bare
            // navigator.clipboard path silently did nothing when the API was
            // blocked — the shopper now gets either the code on the clipboard
            // or honest feedback, never a dead click.
            const ok = await caramelCopyText(code)
            showToast(
                ok
                    ? `Copied "${code}" to clipboard!`
                    : `Couldn't copy — code is ${code}`,
            )
        },
        [showToast],
    )

    // The auto-chase re-enters the loader, and an observer callback captured
    // at wire-time must reach the CURRENT one.
    const loadMoreRef = useRef<() => Promise<void>>(async () => {})

    /** Fetches the next page and appends it. Every exit leaves the footer in a
     *  state the shopper can act on — never a spinner that spins forever. */
    const loadMore = useCallback(async () => {
        const state = pagingRef.current
        if (!state || state.loading || !state.hasMore) return
        state.loading = true
        setFooterState('loading')
        try {
            const next: CouponsPage = await fetchCouponsPage(
                domain,
                '',
                '',
                state.page + 1,
            )
            // Trust the server's own page number when it sends one — an offset
            // it clamped is the offset the rows actually came from, and
            // resuming from our optimistic guess would silently re-request it.
            state.page =
                typeof next.page === 'number' ? next.page : state.page + 1
            if (typeof next.total === 'number') state.total = next.total
            state.hasMore = next.hasMore === true

            const fresh = (next.coupons || []).filter(c => {
                const key = couponIdentity(c)
                if (state.seen.has(key)) return false
                state.seen.add(key)
                return true
            })
            if (fresh.length) {
                state.empty = 0
                setRows(current => [...current, ...fresh])
            } else {
                state.empty += 1
            }

            if (!state.hasMore) {
                setFooterState('end')
                observerRef.current?.disconnect()
                observerRef.current = null
                return
            }
            // A page that was entirely duplicates leaves the footer exactly
            // where it was, so the observer has no boundary left to cross and
            // would wait forever. Pull the next page ourselves — but only a few
            // times, so a backend insisting there is more while returning
            // nothing new ends at a button the shopper can press, not a loop.
            if (fresh.length) {
                setFooterState('idle')
            } else if (state.empty >= COUPON_PAGE_EMPTY_LIMIT) {
                setFooterState('error')
            } else {
                setFooterState('idle')
                state.loading = false
                await loadMoreRef.current()
            }
        } catch (err) {
            log('COUPON_PAGE_FAILED', (err as Error)?.message)
            setFooterState('error')
        } finally {
            state.loading = false
        }
    }, [domain])
    loadMoreRef.current = loadMore

    useEffect(() => {
        const state = pagingRef.current
        const list = listRef.current
        const footer = footerRef.current
        if (!state || !list || !footer || !state.hasMore) return

        // The observer is the intended path — it works in an extension popup,
        // with the scrolling .coupon-list itself as the root. A realm without
        // it gets the button instead, which is ALSO what a failed page falls
        // back to, so the retry affordance is never a second implementation.
        if (typeof IntersectionObserver !== 'function') {
            setFooterState('error')
            return
        }
        const observer = new IntersectionObserver(
            entries => {
                if (entries.some(entry => entry.isIntersecting))
                    void loadMoreRef.current()
            },
            // rootMargin pulls the trigger a card's height early so the next
            // page is usually already there when the shopper reaches the end.
            { root: list, rootMargin: '120px' },
        )
        observerRef.current = observer
        observer.observe(footer)
        return () => {
            observer.disconnect()
            observerRef.current = null
        }
    }, [meta])

    const visibleRows = guestGated ? rows.slice(0, GUEST_COUPON_LIMIT) : rows
    const avatar = user?.image?.length
        ? user.image
        : 'assets/default-profile.png'

    return (
        <div className="coupons-profile-card fade-in-up">
            <div className="coupons-profile-row">
                <div className="coupons-profile-info">
                    <img
                        src={avatar}
                        className="coupons-profile-image"
                        alt="avatar"
                    />
                    <span className="coupons-user-label">
                        {user ? `@${user.username}` : 'Guest'}
                    </span>
                </div>
                {user ? (
                    <div className="coupons-header-actions">
                        {/* Signed-in only: a guest tapping a star only to be
                            bounced into a sign-in form is a bad first touch. */}
                        <FavoriteStoreButton domain={domain} />
                        <button
                            type="button"
                            id="logoutBtn"
                            className="coupons-logout-button"
                            // Vanilla handed logout the sign-in prompt as its
                            // after-callback; App keeps this view mounted
                            // underneath the overlay, so Back lands back here
                            // exactly as it did.
                            onClick={e =>
                                signOutAndRevoke(
                                    api.openSignIn,
                                    e.currentTarget,
                                )
                            }
                        >
                            Log out
                        </button>
                    </div>
                ) : (
                    <button
                        type="button"
                        id="loginToggleBtn"
                        className="coupons-logout-button"
                        onClick={api.openSignIn}
                    >
                        Log in
                    </button>
                )}
            </div>

            <SavingsBanner />

            <h3 className="coupon-header">Coupons for {domain}</h3>

            <div id="couponList" className="coupon-list" ref={listRef}>
                {visibleRows.length === 0 ? (
                    <p>No coupons available for this store right now.</p>
                ) : (
                    visibleRows.map(coupon => (
                        <CouponCard
                            key={couponIdentity(coupon)}
                            coupon={coupon}
                            onCopy={code => void copyCode(code)}
                        />
                    ))
                )}

                {footerVisible && (
                    <div
                        id="couponListFooter"
                        className="coupon-list-footer"
                        ref={footerRef}
                        data-state={footerState}
                        aria-busy={
                            footerState === 'loading' || footerState === 'idle'
                                ? 'true'
                                : undefined
                        }
                    >
                        {footerState === 'loading' || footerState === 'idle' ? (
                            <div
                                className="skeleton skeleton-ticket"
                                aria-hidden="true"
                            />
                        ) : footerState === 'error' ? (
                            // Quiet, not an error banner: the codes already on
                            // screen are still good, and one tap retries.
                            <button
                                type="button"
                                id="couponLoadMoreBtn"
                                className="supported-sites-btn"
                                onClick={() => void loadMore()}
                            >
                                Load more codes
                            </button>
                        ) : (
                            <p className="coupon-list-note">
                                {paging.total === 1
                                    ? "That's the only code we have"
                                    : `You've seen all ${paging.total} codes`}
                            </p>
                        )}
                    </div>
                )}

                {guestGated && (
                    // Name what's hidden and the one action that reveals it.
                    // `total` is the CATALOG count — the same number a
                    // member's scroll ends on — so the promise on the button
                    // is exactly what signing in delivers.
                    <div id="couponGuestGate" className="coupon-guest-gate">
                        <p className="coupon-list-note">
                            Showing {visibleRows.length} of {paging.total} codes
                        </p>
                        <button
                            type="button"
                            id="couponLoginGateBtn"
                            className="supported-sites-btn"
                            onClick={api.openSignIn}
                        >
                            Log in to see all {paging.total} codes
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}
