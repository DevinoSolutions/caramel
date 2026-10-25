'use client'

import { reportUserVisibleFailure } from '@/lib/feedback/reportUserVisibleFailure'
import { useId, useRef, useState } from 'react'

// "Did it work?" on a web coupon card: the shopper who just copied a code tells
// us whether it worked at checkout. It POSTs to the SAME endpoint the extension
// reports to (POST /api/coupons/[id]/report, {outcome}), so a web vote and an
// auto-apply report are one signal in coupon_signals; the server rate-limits it
// and those signals can only REORDER a store's codes (coupons.ts
// isRecentlyFailing), never hide one.
//
// Mounted by CouponCard only AFTER the shopper copies the code, so it is never
// in the server HTML crawlers read and needs no mount gate against hydration.
//
// ONE VOTE PER COUPON PER BROWSER, remembered in localStorage. It is a courtesy
// that keeps an honest shopper from double-voting, not a defence: the endpoint
// is anonymous and rate-limited, so a determined caller bypasses it by posting
// directly, which is why the signal is never allowed to do more than reorder.
// A failed request is NOT remembered, so the shopper can retry.
//
// A 404 is not a failure: the page was rendered before the code left the
// catalog (a tombstone or an id remap), so there is nothing left to vote on. It
// gets a quiet "no longer listed" note and nothing is reported (a stale page is
// not a bug, and each one would otherwise be a Sentry event).

const VOTE_KEY_PREFIX = 'caramel:coupon-vote:'

type Vote = 'worked' | 'failed'

const BUTTONS: ReadonlyArray<{ vote: Vote; label: string }> = [
    { vote: 'worked', label: 'Yes, it worked' },
    { vote: 'failed', label: "No, it didn't" },
]

const THANKS_MESSAGE = 'Thanks! Your answer helps other shoppers.'
const RATE_LIMITED_MESSAGE = 'Too many answers just now. Try again in a minute.'
const GENERIC_FAILURE_MESSAGE = "Couldn't send that. Try again."
const NO_LONGER_LISTED_MESSAGE = 'That code is no longer listed.'

/** The vote this browser already cast for a coupon, or null. */
function readStoredVote(couponId: string): Vote | null {
    try {
        const stored = window.localStorage.getItem(VOTE_KEY_PREFIX + couponId)
        return stored === 'worked' || stored === 'failed' ? stored : null
    } catch {
        // Storage blocked (privacy mode / disabled cookies): not an error to
        // report, the vote still goes out. We only lose the cross-reload
        // "already answered" memory.
        return null
    }
}

function storeVote(couponId: string, vote: Vote): void {
    try {
        window.localStorage.setItem(VOTE_KEY_PREFIX + couponId, vote)
    } catch {
        // Same stance as readStoredVote: the vote was already sent.
    }
}

export default function CouponFeedback({ couponId }: { couponId: string }) {
    const [vote, setVote] = useState<Vote | null>(() =>
        readStoredVote(couponId),
    )
    const [busy, setBusy] = useState(false)
    const [errorText, setErrorText] = useState<string | null>(null)
    const [noLongerListed, setNoLongerListed] = useState(false)
    // Synchronous double-click guard: `busy` only updates on the next render.
    const inFlight = useRef(false)
    const questionId = useId()

    const send = async (chosen: Vote) => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(true)
        setErrorText(null)
        try {
            const res = await fetch(
                `/api/coupons/${encodeURIComponent(couponId)}/report`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ outcome: chosen }),
                },
            )
            if (res.status === 404) {
                setNoLongerListed(true)
                return
            }
            if (!res.ok) {
                reportUserVisibleFailure({
                    error: new Error(`coupons/report ${res.status}`),
                    operation: 'coupon_vote_report',
                    errorCode: String(res.status),
                    extra: { coupon_id: couponId },
                })
                setErrorText(
                    res.status === 429
                        ? RATE_LIMITED_MESSAGE
                        : GENERIC_FAILURE_MESSAGE,
                )
                return
            }
            storeVote(couponId, chosen)
            setVote(chosen)
        } catch (error) {
            reportUserVisibleFailure({
                error,
                operation: 'coupon_vote_report',
                errorCode: 'network',
                extra: { coupon_id: couponId },
            })
            setErrorText(GENERIC_FAILURE_MESSAGE)
        } finally {
            inFlight.current = false
            setBusy(false)
        }
    }

    return (
        <div className="mt-4 border-t border-orange-100 pt-3 dark:border-orange-900/50">
            {vote === null && !noLongerListed && (
                <div
                    role="group"
                    aria-labelledby={questionId}
                    className="flex flex-wrap items-center gap-2"
                >
                    <span
                        id={questionId}
                        className="text-sm font-medium text-gray-700 dark:text-gray-300"
                    >
                        Did it work?
                    </span>
                    {BUTTONS.map(({ vote: option, label }) => (
                        <button
                            key={option}
                            type="button"
                            disabled={busy}
                            onClick={() => void send(option)}
                            className="hover:border-caramel hover:text-caramel focus-visible:ring-caramel dark:focus-visible:ring-offset-darkSurface rounded-full border border-orange-200 px-3 py-1 text-sm font-semibold text-gray-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-orange-900/60 dark:text-gray-200"
                        >
                            {label}
                        </button>
                    ))}
                </div>
            )}
            {/* Always mounted so a screen reader announces the text swapped
                into it (a live region inserted together with its text is not
                reliably announced). */}
            <p
                aria-live="polite"
                className={
                    errorText
                        ? 'mt-2 text-sm font-medium text-red-700 dark:text-red-300'
                        : noLongerListed
                          ? 'text-sm font-medium text-gray-600 dark:text-gray-400'
                          : 'text-sm font-medium text-green-700 dark:text-green-400'
                }
            >
                {vote !== null
                    ? THANKS_MESSAGE
                    : noLongerListed
                      ? NO_LONGER_LISTED_MESSAGE
                      : errorText}
            </p>
        </div>
    )
}
