// lib/relativeTime.ts
//
// Tiny, pure relative-time formatter for the app-owned "Just worked" /
// "Worked Xh ago" trust signal (W1). Deliberately dependency-free (coupons.ts
// is pure too) so it's safe to import into a 'use client' card. The extension
// popup carries a twin (popup-core.js's own formatWorkedAgo) — the two live
// across the app/extension package boundary and can't share a module, so they
// are kept in step by hand; the shared time constants (clock-skew tolerance)
// reach the popup through coupon-constants.generated.js.
import { workedAgeMs } from '@/lib/coupons'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** Older than this, the signal is not shown at all: stale trust is no trust. */
const WORKED_AGO_CEILING_MS = 7 * DAY_MS

/**
 * The trust line for a lastWorkedAt timestamp:
 *   under 1 hour  → "Just worked"   (never "worked 0h ago")
 *   under 1 day   → "Worked 3h ago" (whole hours)
 *   up to 7 days  → "Worked 2d ago" (whole days)
 * Returns null (render nothing) when the value is absent, unparseable, further
 * in the future than coupons.ts's clock-skew tolerance, or older than 7 days.
 */
export function formatWorkedAgo(
    lastWorkedAt: string | Date | null | undefined,
    now: number = Date.now(),
): string | null {
    const age = workedAgeMs(lastWorkedAt, now)
    if (age === null || age > WORKED_AGO_CEILING_MS) return null
    if (age < HOUR_MS) return 'Just worked'
    if (age < DAY_MS) return `Worked ${Math.floor(age / HOUR_MS)}h ago`
    return `Worked ${Math.floor(age / DAY_MS)}d ago`
}

// UTC + a fixed locale: the landing strip renders on the server and again in
// the browser, so the date must not depend on either machine's zone/locale.
const WORKED_ON_DATE = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
})

/**
 * The landing "Codes that just worked" line, which (unlike a store-page card)
 * lists the newest worked codes however old: formatWorkedAgo() while that has
 * a label, then the date ("Worked Sep 12"). Null only for an absent,
 * unparseable or future timestamp.
 */
export function formatWorkedLabel(
    lastWorkedAt: string | Date | null | undefined,
    now: number = Date.now(),
): string | null {
    const ago = formatWorkedAgo(lastWorkedAt, now)
    if (ago) return ago
    if (workedAgeMs(lastWorkedAt, now) === null || !lastWorkedAt) return null
    return `Worked ${WORKED_ON_DATE.format(new Date(lastWorkedAt))}`
}
