// src/lib/profile/types.ts
//
// The ONE shape GET /api/account/overview returns and the whole account page
// consumes. It lives here (not inside the route) because four separate
// sections read it and the route, the hook, the sections and the route test
// must all agree character-for-character — a second hand-typed copy is how a
// field silently becomes optional on one side.
//
// Deliberately one request for four sections: four fetches would produce four
// spinners and four independent failure modes on a page whose whole job is to
// answer "what has Caramel done for me".

/** One currency's total. NEVER added to another currency's. */
export interface SavingsTotal {
    currency: string
    minorUnits: number
}

export interface SavingsEventSummary {
    storeDomain: string
    /** null for an automatic discount that carried no code. */
    code: string | null
    amountMinorUnits: number
    currency: string
    /** ISO. */
    occurredAt: string
}

export interface FavoriteStoreSummary {
    domain: string
    /** ISO. */
    starredAt: string
    /** null when no live catalog count is available — the UI then renders NO
     * count line at all rather than a placeholder or a zero. */
    couponCount: number | null
}

export interface ProfileOverview {
    /** ISO — drives "Saving with Caramel since March 2026". */
    memberSince: string | null
    /** True when this account has ever produced extension-side activity (a
     * synced saving or a report). Drives whether the page tells someone to
     * "star a store in the extension" — advice that is a dead end for a user
     * who has not installed it. */
    hasExtensionActivity: boolean
    savings: {
        syncEnabled: boolean
        eventCount: number
        storeCount: number
        /** Grouped by currency, sorted desc by minorUnits. NEVER summed
         * across currencies — a single number that adds dollars to euros is
         * a fabricated figure. */
        totals: SavingsTotal[]
        /** ISO — the oldest event, drives "since March 2026". */
        firstEventAt: string | null
        /** Server caps this list; the page slices it further for display. */
        recentEvents: SavingsEventSummary[]
    }
    favorites: FavoriteStoreSummary[]
    reports: {
        reportCount: number
        /** null when not derivable from real records — the UI then falls to a
         * lower copy tier rather than inventing the number. */
        confirmedCount: number | null
        /** null unless it is a genuine downstream count of OTHER users helped.
         * Never derived from reportCount by a multiplier or an assumption. */
        shoppersHelped: number | null
    }
}

/** Server cap on `savings.recentEvents`. The page shows 5 and expands to the
 * rest client-side, so the cap bounds the payload without adding pagination
 * chrome to a list that is almost never long. */
export const RECENT_EVENTS_LIMIT = 25
