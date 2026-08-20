// lib/recentStores.ts
//
// The "Recently added" strip's two pure decisions: how many stores it shows,
// and how a store's added-at timestamp reads as English.
//
// The label is formatted on the SERVER (supported-stores/page.tsx) and handed
// to the client component as a finished string. Formatting it in the browser
// instead would compare the shopper's clock against a server-rendered
// timestamp, so the first client render could disagree with the HTML Next.js
// just sent (a hydration mismatch) purely because the two clocks or time zones
// differ. One clock, one string, no mismatch — and the page is
// `force-dynamic`, so that string is recomputed on every request and can never
// go stale in a cache.

/** Tiles in the strip. The owner asked for the 4 most recently added stores. */
export const RECENTLY_ADDED_STORE_COUNT = 4

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Whole days between two instants, counted in UTC CALENDAR days rather than
 * elapsed milliseconds. A store published at 23:00 and read at 01:00 the next
 * morning is "yesterday" to a reader, but only two elapsed hours — flooring
 * elapsed time would call it "today". UTC (not local time) keeps the answer
 * identical wherever the server runs, which is what makes it testable.
 */
function utcDaysBetween(from: Date, to: Date): number {
    const fromDay = Date.UTC(
        from.getUTCFullYear(),
        from.getUTCMonth(),
        from.getUTCDate(),
    )
    const toDay = Date.UTC(
        to.getUTCFullYear(),
        to.getUTCMonth(),
        to.getUTCDate(),
    )
    return Math.round((toDay - fromDay) / MS_PER_DAY)
}

/**
 * "Added today" / "Added yesterday" / "Added 5 days ago" / "Added 3 weeks ago"
 * / "Added 4 months ago".
 *
 * A store dated in the FUTURE (clock skew between the pipeline that stamped
 * the row and the web server reading it) reads as "Added today" rather than a
 * negative count — the strip is a freshness cue, and "Added -1 days ago" is
 * worse than a day's imprecision.
 *
 * Nothing here hides an old date. If the newest supported store is four months
 * old the strip says so, because that is the honest state of the pipeline and
 * a silent "New" badge over stale coverage is the failure this section exists
 * to prevent.
 */
export function formatStoreAddedLabel(addedAt: Date, now: Date): string {
    const days = utcDaysBetween(addedAt, now)
    if (days <= 0) return 'Added today'
    if (days === 1) return 'Added yesterday'
    if (days < 14) return `Added ${days} days ago`
    if (days < 60) {
        const weeks = Math.floor(days / 7)
        return `Added ${weeks} week${weeks === 1 ? '' : 's'} ago`
    }
    const months = Math.floor(days / 30)
    return `Added ${months} month${months === 1 ? '' : 's'} ago`
}
