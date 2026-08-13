import { CaramelCoupons } from '../../../coupon-constants.generated.js'
import { formatWorkedAgo } from '../../../popup-core.js'
import type { Coupon } from '../types'

/**
 * One coupon row (P2 React successor to popup.js couponItemHtml). ONE builder
 * for page 1 and every appended page — a second copy of this markup is how an
 * appended row quietly loses a badge or a warning.
 *
 * Labels, tiers and the restricted set are read from CaramelCoupons
 * (coupon-constants.generated.js — F-006) rather than a local literal, so the
 * extension can't re-drift from the app's src/lib/coupons.ts.
 */

/** Statuses whose rows carry the restriction warning. */
const RESTRICTED_STATUSES = new Set<string>(CaramelCoupons.RESTRICTED_STATUSES)

/** The 4-tier badge axis. Indexed by a status the API may extend at any
 *  time, so an unknown status legitimately answers undefined (no badge). */
const STATUS_META = CaramelCoupons.STATUS_META as Record<
    string,
    { label: string; tier: string } | undefined
>

export function CouponCard({
    coupon,
    onCopy,
}: {
    coupon: Coupon
    onCopy: (code: string) => void
}) {
    const status = coupon.status ?? ''
    const isRestricted = RESTRICTED_STATUSES.has(status)
    const isDead = status === 'invalid' || status === 'expired'
    const meta = STATUS_META[status]
    // App-owned trust signal (W1): "worked Xh ago" when the extension last
    // reported this coupon working (<7 days), '' when it hasn't.
    const workedAgo: string = formatWorkedAgo(coupon.lastWorkedAt)

    const baseMsg =
        status === 'category_restricted'
            ? 'Limited to specific categories'
            : status === 'seller_specific'
              ? 'Only for items from a specific seller'
              : status === 'valid_with_warning'
                ? 'May have restrictions'
                : 'Limited to specific items'

    const copy = () => onCopy(coupon.code)

    // styles.css keys on all three class names; the separators are why they
    // are joined rather than concatenated into one template literal.
    const classNames = ['coupon-item']
    if (isRestricted) classNames.push('coupon-item-restricted')
    if (isDead) classNames.push('coupon-item-dead')

    return (
        <div
            data-code={coupon.code}
            role="button"
            tabIndex={0}
            aria-label={`${coupon.title || 'Coupon'} — copy code ${coupon.code}`}
            className={classNames.join(' ')}
            onClick={copy}
            // role="button" is a promise to keyboard users and screen
            // readers: Enter and Space must activate the card like a real
            // button would.
            onKeyDown={e => {
                if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar')
                    return
                e.preventDefault()
                copy()
            }}
        >
            <div className="coupon-head">
                <div className="coupon-title">
                    {coupon.title || 'Untitled Coupon'}
                </div>
                {meta && (
                    <span
                        className={`coupon-badge coupon-badge--${meta.tier}`}
                        title={coupon.verificationMessage || ''}
                    >
                        {meta.label}
                    </span>
                )}
                {workedAgo && (
                    <span className="coupon-worked-ago">{workedAgo}</span>
                )}
            </div>

            {coupon.description && (
                <div className="coupon-desc">{coupon.description}</div>
            )}

            {isRestricted && (
                <div
                    className="coupon-restriction"
                    title={coupon.verificationMessage || baseMsg}
                >
                    <span
                        className="coupon-restriction-icon"
                        aria-hidden="true"
                    >
                        <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <path d="M12 9v4" />
                            <path d="M12 17h.01" />
                        </svg>
                    </span>
                    <span className="coupon-restriction-text">
                        {baseMsg}
                        {coupon.cartCategory && (
                            <>
                                {' — your cart looks like '}
                                <b>{coupon.cartCategory}</b>
                                {coupon.cartCategorySecondary
                                    ? ` / ${coupon.cartCategorySecondary}`
                                    : ''}
                            </>
                        )}
                    </span>
                    {coupon.verificationMessage && (
                        <div className="coupon-restriction-detail">
                            {coupon.verificationMessage}
                        </div>
                    )}
                </div>
            )}

            <div className="coupon-code-row">
                <span className="coupon-code">{coupon.code}</span>
                <span className="coupon-copy">
                    <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                    >
                        <rect
                            x="9"
                            y="9"
                            width="11"
                            height="11"
                            rx="2.5"
                            stroke="currentColor"
                            strokeWidth="2"
                        />
                        <path
                            d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H15"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                        />
                    </svg>
                    Copy
                </span>
            </div>
        </div>
    )
}
