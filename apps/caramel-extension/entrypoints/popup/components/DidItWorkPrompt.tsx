import { useEffect, useId, useRef, useState } from 'react'
import {
    caramelSendMessage,
    currentBrowser,
    logError,
} from '../../../caramel-base.js'
import {
    clearPendingVote,
    recordVote,
    type PendingVote,
    type Vote,
} from '../couponVote'

/**
 * "Did CODE work?" (issue #288) — asked the NEXT time the popup opens on the
 * store where the shopper copied a code, because the popup closes itself right
 * after a copy (#249) and a question shown then would never be seen.
 *
 * The vote rides the apply flow's own report path (background.js
 * `reportOutcome`, POST /api/coupons/[id]/report) with `awaitResult`, so the
 * real status comes back instead of the fire-and-forget answer. A failed send
 * is shown inline and stays retryable — nothing is remembered as voted until
 * the server said yes. Wording mirrors the website card (CouponFeedback.tsx).
 */

const BUTTONS: ReadonlyArray<{ vote: Vote; label: string }> = [
    { vote: 'worked', label: 'Yes, it worked' },
    { vote: 'failed', label: "No, it didn't" },
]

const RATE_LIMITED_MESSAGE = 'Too many answers just now. Try again in a minute.'
const GENERIC_FAILURE_MESSAGE = "Couldn't send that. Try again."

export function DidItWorkPrompt({
    pending,
    onVoted,
    onDismiss,
}: {
    pending: PendingVote
    /** The vote landed; "failed" also hides the code (the caller mirrors it). */
    onVoted: (couponId: string, vote: Vote) => void
    /** The prompt is gone: the caller owns where focus goes next. */
    onDismiss: () => void
}) {
    const [done, setDone] = useState<Vote | null>(null)
    const [busy, setBusy] = useState(false)
    const [errorText, setErrorText] = useState<string | null>(null)
    // Synchronous double-click guard: `busy` only updates on the next render.
    const inFlight = useRef(false)
    const questionId = useId()
    // The answer buttons unmount on a successful vote; focus follows the
    // thanks, which is also the live region, so it is both read and kept.
    const thanksRef = useRef<HTMLParagraphElement>(null)
    useEffect(() => {
        if (done !== null) thanksRef.current?.focus()
    }, [done])

    const send = async (vote: Vote) => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(true)
        setErrorText(null)
        try {
            const resp = await caramelSendMessage({
                action: 'reportOutcome',
                id: pending.couponId,
                outcome: vote,
                awaitResult: true,
            })
            if (resp.error) {
                throw Object.assign(new Error(resp.error), {
                    status: resp.status,
                })
            }
            // The vote is on the server. A failed local write only costs the
            // "already answered" memory, so it is reported and not fatal.
            await recordVote(currentBrowser, pending.couponId, vote).catch(
                (err: Error) => logError('recordCouponVote', err),
            )
            setDone(vote)
            onVoted(pending.couponId, vote)
        } catch (err) {
            logError('couponVote', err)
            setErrorText(
                (err as { status?: number }).status === 429
                    ? RATE_LIMITED_MESSAGE
                    : GENERIC_FAILURE_MESSAGE,
            )
        } finally {
            inFlight.current = false
            setBusy(false)
        }
    }

    const dismiss = () => {
        if (inFlight.current) return
        void clearPendingVote(currentBrowser).catch((err: Error) =>
            logError('clearPendingVote', err),
        )
        onDismiss()
    }

    return (
        <div id="didItWorkPrompt" className="coupon-vote">
            {done === null && (
                <div
                    role="group"
                    aria-labelledby={questionId}
                    className="coupon-vote-row"
                >
                    <span id={questionId} className="coupon-vote-question">
                        Did <b>{pending.code}</b> work?
                    </span>
                    <div className="coupon-vote-actions">
                        {BUTTONS.map(({ vote, label }) => (
                            <button
                                key={vote}
                                type="button"
                                className="coupon-vote-btn"
                                // aria-disabled, not disabled: a disabled
                                // button drops focus, and after a failed send
                                // the shopper is still on this control.
                                aria-disabled={busy}
                                onClick={() => void send(vote)}
                            >
                                {label}
                            </button>
                        ))}
                        <button
                            type="button"
                            className="coupon-vote-dismiss"
                            aria-disabled={busy}
                            onClick={dismiss}
                        >
                            Not now
                        </button>
                    </div>
                </div>
            )}
            {/* Always mounted so a screen reader announces the text swapped
                into it (a live region inserted together with its text is not
                reliably announced). */}
            <p
                ref={thanksRef}
                tabIndex={-1}
                aria-live="polite"
                className={
                    errorText
                        ? 'coupon-vote-msg coupon-vote-msg--error'
                        : 'coupon-vote-msg'
                }
            >
                {done === 'worked'
                    ? 'Thanks! Your answer helps other shoppers.'
                    : done === 'failed'
                      ? `Thanks! We've hidden ${pending.code} for you.`
                      : errorText}
            </p>
        </div>
    )
}
