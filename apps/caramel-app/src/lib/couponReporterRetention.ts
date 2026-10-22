// src/lib/couponReporterRetention.ts
//
// The SCHEDULE for the reporter-row retention sweep (couponSignals.ts
// sweepExpiredReporters). The privacy policy promises that the hashed reporter
// identifiers behind failure/success reports are deleted after 30 days; the
// report route also sweeps, but only when someone reports, so a quiet period
// would keep expired rows. This copies emailDeliveryHealthMonitor.ts: one
// unref'd interval on the one long-running process the app owns, started once
// from instrumentation.ts's register(), idempotent, production only (the
// decision is logged at boot so "is it running?" is never a guess). One
// process = one schedule: the sweep itself is single-flight, and a second web
// replica would only run a harmless second DELETE.
import { sweepExpiredReporters } from '@/lib/couponSignals'
import 'server-only'

const HOUR_MS = 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null

export interface RetentionDecision {
    enabled: boolean
    /** Why it is (not) running, logged at boot. */
    reason: string
}

/**
 * Start the hourly sweep. Idempotent (a second call is a no-op) and unref'd, so
 * it never holds the process open. The first run is one interval AFTER boot,
 * never at boot (a crash-looping container must not hammer the database).
 * sweepExpiredReporters never rejects and reports its own failures to Sentry,
 * so the tick has nothing to swallow.
 */
export function startCouponReporterRetentionSweep(): RetentionDecision {
    if (process.env.NODE_ENV !== 'production') {
        return {
            enabled: false,
            reason: 'non-production (the report route still sweeps on writes)',
        }
    }
    if (timer) return { enabled: true, reason: 'already started' }
    timer = setInterval(() => {
        void sweepExpiredReporters({ force: true })
    }, HOUR_MS)
    // Guarded because a faked timer (vitest) is not always a real Node Timeout.
    if (typeof timer.unref === 'function') timer.unref()
    return { enabled: true, reason: 'production default' }
}
