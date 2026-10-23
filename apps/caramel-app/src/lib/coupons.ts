// lib/coupons.ts
//
// SINGLE source of truth for the coupon status vocabulary (F-006). Pure —
// no server imports — so it's importable by the 'use client' coupon-card.tsx
// component AND by the extension codegen script
// (scripts/generate-coupon-constants.ts), neither of which can pull in a
// server-only DB client (@/lib/prisma). couponsRepo.ts's SQL fragments
// import VISIBLE_COUPON_STATUSES from here, not the other way around — no
// cycle.
//
// Before this module existed, "which statuses are visible" was hand-copied
// across 6 SQL call sites and had already drifted into 3 different
// definitions (coupons/route.ts's 7-status list, filters/route.ts's
// 'valid'-only list, stats/route.ts's 'valid'-only-without-expired-filter —
// see coupons-visibility.test.ts's pre-F-006 pins for the verbatim drift).
// The status->label/tier map was independently re-declared in the app
// (coupon-card.tsx's STATUS_BADGE) and the extension (popup.js's BADGE +
// shared-utils.js's RESTRICTED_STATUSES). STATUS_TABLE below is now the only
// place a coupon status is defined; every one of those sites derives from
// it instead.
const STATUS_TABLE = [
    {
        status: 'valid',
        label: '✓ Verified',
        tier: 'green',
        // Machine-verified by the Python verification service.
        visible: true,
        restricted: false,
    },
    {
        status: 'valid_with_warning',
        label: 'Verified · may vary',
        tier: 'amber',
        visible: true,
        restricted: true,
    },
    {
        status: 'product_restriction',
        label: 'Restrictions apply',
        tier: 'amber',
        visible: true,
        restricted: true,
    },
    {
        status: 'category_restricted',
        label: 'Category-limited',
        tier: 'amber',
        visible: true,
        restricted: true,
    },
    {
        status: 'seller_specific',
        label: 'Seller-specific',
        tier: 'amber',
        visible: true,
        restricted: true,
    },
    {
        status: 'pending',
        label: 'Unverified',
        tier: 'grey',
        // The bulk of the catalog: scraped, not yet run through
        // verification. Still shown with a neutral badge.
        visible: true,
        restricted: false,
    },
    {
        status: 'retry',
        label: 'Unverified',
        tier: 'grey',
        // Mid-verification in the DB (a prior attempt failed transiently) —
        // but presented as plain "Unverified", the same badge as `pending`.
        // The old "Checking…" label promised live activity, and while the
        // verification pipeline is paused (post-cutover hold, 2026-08-10)
        // rows sat on that promise for days. "Unverified" is true in both
        // worlds: pipeline running or not, the code has no proof yet.
        visible: true,
        restricted: false,
    },
    {
        status: 'invalid',
        label: 'Not valid',
        tier: 'red',
        // Known-dead — never surfaced in a listing.
        visible: false,
        restricted: false,
    },
    {
        status: 'expired',
        label: 'Expired',
        tier: 'red',
        visible: false,
        restricted: false,
    },
] as const

/** The 4 presentation tiers a status can render as. Tier->color (Tailwind classes app-side, hex popup-side) stays local to each platform — genuinely platform-specific and, being only 4 values, cannot drift on the 9-status axis the way the status vocabulary itself did. */
export type CouponStatusTier = (typeof STATUS_TABLE)[number]['tier']

export type CouponStatus = (typeof STATUS_TABLE)[number]['status']

/** All 9 statuses, table order. */
export const COUPON_STATUSES: readonly CouponStatus[] = STATUS_TABLE.map(
    s => s.status,
)

/**
 * The 7 statuses a listing should ever surface: verified, restriction-
 * tagged, AND not-yet-verified coupons. Excludes 'invalid'/'expired' so
 * known-dead codes are never shown. Drives every coupons-DB read query's
 * WHERE clause via couponsDb.ts's visibleCouponsWhere().
 */
export const VISIBLE_COUPON_STATUSES: readonly CouponStatus[] =
    STATUS_TABLE.filter(s => s.visible).map(s => s.status)

/**
 * The 4 statuses that carry a restriction the user might trip over (e.g.
 * "this code only applies to a specific category"). Drives the extension's
 * cart-classification trigger and restriction warning banner.
 */
export const RESTRICTED_COUPON_STATUSES: readonly CouponStatus[] =
    STATUS_TABLE.filter(s => s.restricted).map(s => s.status)

const VISIBLE_SET: ReadonlySet<string> = new Set(VISIBLE_COUPON_STATUSES)
const RESTRICTED_SET: ReadonlySet<string> = new Set(RESTRICTED_COUPON_STATUSES)

/** Type-guards an arbitrary (e.g. DB-sourced) status string against the visible set. */
export function isVisibleStatus(status: string): status is CouponStatus {
    return VISIBLE_SET.has(status)
}

/** Type-guards an arbitrary (e.g. DB-sourced) status string against the restricted set. */
export function isRestrictedStatus(status: string): status is CouponStatus {
    return RESTRICTED_SET.has(status)
}

/**
 * label + tier per status — the shared half of the app's coupon-card badge
 * and the extension's popup badge. Both platforms still keep their own
 * tier->color map (Tailwind vs. hex) locally; only the label/tier pairing
 * (the part that actually drifted) lives here.
 */
export const STATUS_META: Readonly<
    Record<CouponStatus, { label: string; tier: CouponStatusTier }>
> = STATUS_TABLE.reduce(
    (acc, s) => {
        acc[s.status] = { label: s.label, tier: s.tier }
        return acc
    },
    {} as Record<CouponStatus, { label: string; tier: CouponStatusTier }>,
)

/**
 * The discount badge text a coupon card shows: "15%" for a PERCENTAGE amount,
 * "$20" for any other type with an amount, and null when the catalog has no
 * amount — the caller then renders a number-free "DEAL", and must NEVER invent
 * a figure (a fabricated "20% off" is a false public claim). The read boundary
 * upper-cases discount_type, so the comparison is exact.
 */
export function discountBadgeText(
    discountType: string | null | undefined,
    discountAmount: number | null | undefined,
): string | null {
    if (!discountAmount) return null
    return discountType === 'PERCENTAGE'
        ? `${discountAmount}%`
        : `$${discountAmount}`
}

// ---------------------------------------------------------------------------
// Proven-by-use trust (the "just worked" rule, 2026-09-30).
//
// The extension reports every successful checkout apply to
// POST /api/coupons/[id]/report, which stamps the app-owned
// `coupon_signals.last_worked_at` (couponSignals.recordWorked). A code a real
// shopper applied successfully in the last day has stronger proof than the
// verification pipeline's "not checked yet" — so an UNVERIFIED (grey-tier)
// code with such a signal is DISPLAYED as Verified. This is a read-time
// derivation only: nothing writes the catalog's `status`, and the next
// catalog push from the pipeline stays authoritative for it.
//
// Scope of the upgrade, deliberately narrow:
//   * grey (pending/retry) or no status → Verified (the contradiction users
//     saw: a green "worked 0h ago" line next to an "Unverified" badge).
//   * amber (restriction-tagged) stays amber — a restricted code that worked
//     for one cart can still fail on yours, and the amber label is the useful
//     warning ("Restrictions apply"), not a lack of proof.
//   * red (invalid/expired) stays red — never surfaced in a listing anyway,
//     and a conflicting report there is a question for the pipeline.
//
// The window + predicate below are the ONLY definition: the extension popup
// reads WORKED_VERIFIED_WINDOW_MS + WORKED_AT_CLOCK_SKEW_TOLERANCE_MS from
// coupon-constants.generated.js. (The landing page's "Codes that just worked"
// read is NOT windowed since 2026-10-02: it lists the newest worked codes
// however old, and only the tile's badge applies this window.)

/** How recent a successful apply must be to count as proof (hours). */
export const WORKED_VERIFIED_WINDOW_HOURS = 24

/** WORKED_VERIFIED_WINDOW_HOURS in milliseconds. */
export const WORKED_VERIFIED_WINDOW_MS =
    WORKED_VERIFIED_WINDOW_HOURS * 60 * 60 * 1000

/**
 * `last_worked_at` is stamped by the SERVER clock but compared against
 * whatever clock renders it (a shopper's browser may run minutes behind).
 * A timestamp up to this far in the future is treated as "just now" rather
 * than as a bogus future value — otherwise a slow client clock would hide
 * exactly the freshest signals.
 */
export const WORKED_AT_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000

/**
 * Milliseconds since `lastWorkedAt` (clamped to 0 within the clock-skew
 * tolerance), or null when there is no usable signal: absent, unparseable, or
 * further in the future than the tolerance allows.
 */
export function workedAgeMs(
    lastWorkedAt: string | Date | null | undefined,
    now: number = Date.now(),
): number | null {
    if (!lastWorkedAt) return null
    const then =
        typeof lastWorkedAt === 'string'
            ? Date.parse(lastWorkedAt)
            : lastWorkedAt.getTime()
    if (Number.isNaN(then)) return null
    const age = now - then
    if (age < -WORKED_AT_CLOCK_SKEW_TOLERANCE_MS) return null
    return Math.max(0, age)
}

/** True when a shopper's successful apply was reported within WORKED_VERIFIED_WINDOW_MS. */
export function isRecentlyWorked(
    lastWorkedAt: string | Date | null | undefined,
    now: number = Date.now(),
): boolean {
    const age = workedAgeMs(lastWorkedAt, now)
    return age !== null && age <= WORKED_VERIFIED_WINDOW_MS
}

/** The badge a coupon card renders, plus WHY it is green when that is proof-by-use. */
export type CouponBadge = {
    label: string
    tier: CouponStatusTier
    /** True when the badge is Verified because of a recent successful apply, not the catalog status. */
    provenByRecentWork: boolean
}

/**
 * The status badge to DISPLAY for a coupon: the catalog status's STATUS_META
 * entry, upgraded to the Verified badge when the code is unverified (grey) or
 * status-less AND isRecentlyWorked(). Null when there is nothing to show (no
 * status, no recent proof — or a status outside this vocabulary). See the
 * block comment above for why amber and red are never upgraded.
 */
export function couponBadge(
    status: string | null | undefined,
    lastWorkedAt: string | Date | null | undefined,
    now: number = Date.now(),
): CouponBadge | null {
    const catalogMeta =
        status && Object.prototype.hasOwnProperty.call(STATUS_META, status)
            ? STATUS_META[status as CouponStatus]
            : null
    const upgradable = catalogMeta === null || catalogMeta.tier === 'grey'
    if (upgradable && isRecentlyWorked(lastWorkedAt, now)) {
        return { ...STATUS_META.valid, provenByRecentWork: true }
    }
    return catalogMeta ? { ...catalogMeta, provenByRecentWork: false } : null
}

// ---------------------------------------------------------------------------
// Recently-failing codes: SINK, never hide.
//
// The extension reports every auto-apply outcome (POST /api/coupons/[id]/report
// → coupon_signals). A code that keeps failing is moved BELOW the codes that
// are not, on store pages and in the store-scoped /api/coupons list the popup
// reads. It stays listed: these are shopper/extension reports, not verification,
// and anonymous reports are cheap to forge, so they may reorder but never remove
// a code or change its status. A single later success resets it (the failure is
// no longer newer than the last success). The window and the minimum count are
// the ONLY definition; couponsRepo.failingSinkSql() composes the same numbers
// into the ORDER BY, so SQL ordering and the card's hint cannot disagree.
//
// A code that KEEPS failing (keepsFailing, below) is collapsed by the store page
// and the popup into a "reported not working" group at the end of the list. That
// is still presentation only: the code is in the response and in the HTML, and
// one later success un-collapses it.

/**
 * Failure QUORUM needed before a code sinks, in reporter weight (not raw
 * reports): the sum of the weights of the DISTINCT reporters whose failure is
 * newer than the last success (couponSignals.ts recordFailed keeps it in
 * coupon_signals.fail_weight). An anonymous network (or a young account) weighs
 * 1, an established signed-in account 2 (couponSignals.ts REPORTER_WEIGHT), and
 * the weight-1 reporters together stop at MAX_LOW_TRUST_FAIL_WEIGHT (1), so it
 * takes 2 established accounts. Anonymous networks, young accounts and one
 * aged account plus any number of them can never sink a code. One failed attempt is
 * noise (a flaky checkout, a minimum-spend miss), and three forged anonymous
 * reports (the old threshold was 2 raw reports) must not be enough.
 */
export const FAILING_MIN_FAIL_WEIGHT = 4

/**
 * Most failure weight the LOW-TRUST reporters of one coupon can add together:
 * anonymous networks and accounts younger than COUPON_TRUST_MIN_ACCOUNT_AGE_DAYS
 * (accountReputation.ts), each weighing 1. It is 1 on purpose: one established
 * account (weight 2, couponSignals.ts REPORTER_WEIGHT) plus this pool must stay
 * BELOW FAILING_MIN_FAIL_WEIGHT, so sinking a code takes two established
 * accounts, and no number of anonymous networks or throwaway accounts, with or
 * without a single aged account, can do it. couponSignals.ts
 * recomputeFailWeight applies it; coupon-failure-quorum.test.ts pins the
 * relationship to the account weight and the sink threshold.
 */
export const MAX_LOW_TRUST_FAIL_WEIGHT = 1

/** A failure older than this no longer counts: codes get fixed and stores change. */
export const FAILING_WINDOW_DAYS = 30

/** FAILING_WINDOW_DAYS in milliseconds. */
export const FAILING_WINDOW_MS = FAILING_WINDOW_DAYS * 24 * 60 * 60 * 1000

/** The coupon_signals fields isRecentlyFailing reads (attachSignals' output shape). */
export type FailureSignal = {
    failWeight?: number | null
    lastFailedAt?: string | Date | null
    lastWorkedAt?: string | Date | null
}

/**
 * True when shoppers/the extension have reported this code failing and
 * recently: a failure quorum of at least FAILING_MIN_FAIL_WEIGHT and the latest
 * failure within FAILING_WINDOW_MS. Successes are NOT compared here: a success
 * clears failures only once a quorum of distinct reporters agree
 * (couponSignals.ts CLEARING_WORKED_WEIGHT), and that is already folded into
 * failWeight when the success is reported, so one forged "worked" cannot reset a
 * code from the client side either. Pure: absent or unparseable timestamps mean
 * "no signal", never "failing".
 */
export function isRecentlyFailing(
    signal: FailureSignal,
    now: number = Date.now(),
): boolean {
    if ((signal.failWeight ?? 0) < FAILING_MIN_FAIL_WEIGHT) return false
    const failedAge = workedAgeMs(signal.lastFailedAt, now)
    return failedAge !== null && failedAge <= FAILING_WINDOW_MS
}

/**
 * Failure quorum needed before a code is COLLAPSED (not merely sunk): a third
 * established account on top of the two that sink it. Higher than
 * FAILING_MIN_FAIL_WEIGHT because collapsing is the stronger presentation.
 */
export const KEEPS_FAILING_MIN_FAIL_WEIGHT = 6

/**
 * True when a code is recently failing (isRecentlyFailing: window rule
 * included) AND has at least
 * KEEPS_FAILING_MIN_FAIL_WEIGHT of failure quorum. The web store page and the extension
 * popup collapse these behind a "N codes reported not working" disclosure. It
 * is a presentation flag over shopper/extension reports: it never changes a
 * catalog status, and a worked quorum clears it (failWeight is recomputed when
 * the successes are reported).
 */
export function keepsFailing(
    signal: FailureSignal,
    now: number = Date.now(),
): boolean {
    return (
        isRecentlyFailing(signal, now) &&
        (signal.failWeight ?? 0) >= KEEPS_FAILING_MIN_FAIL_WEIGHT
    )
}

/**
 * Phrases that mark a PERSONAL referral code: a code that pays out to the
 * stranger who shared it and often only works for a brand-new account, so it is
 * not a coupon for the shopper looking at the store page. Matched
 * case-insensitively against title + description by isReferralCoupon.
 *
 * Every pattern is WORD-BOUNDED on purpose. Substring matching would catch
 * "Avis Preferred members" (a loyalty tier), "Musician's Friend code" (a store
 * name), "Zazzle invitations" and "Evite" (what the store sells), none of which
 * are referral codes. Measured on prod 2026-10-17: this set matches 44 visible
 * coupons on 24 sites, and no store loses all of its codes.
 */
export const REFERRAL_COUPON_PATTERNS: readonly RegExp[] = [
    /\breferrals?\b/i,
    /\brefer[\s-]+a[\s-]+friend\b/i,
    /\bcode in the link\b/i,
    /\binvited by\b/i,
    /\binvite code\b/i,
]

/**
 * True when a coupon is a personal referral code (see
 * REFERRAL_COUPON_PATTERNS). The ingest write engine (applyCatalogRows) keeps
 * such rows out of the catalog; this is the single definition of "referral".
 */
export function isReferralCoupon(row: {
    title: string
    description: string | null
}): boolean {
    const text = `${row.title} ${row.description ?? ''}`
    return REFERRAL_COUPON_PATTERNS.some(pattern => pattern.test(text))
}
