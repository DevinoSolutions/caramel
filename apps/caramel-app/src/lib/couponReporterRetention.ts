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
//
// Provable runs (T-6398 / T-8983): every sweep logs one summary line (see
// couponSignals.ts), and this timer, and only the timer, checks in to the
// Sentry cron monitor below (in_progress, then ok or error), so a missed or
// failed hourly run pages instead of going unnoticed. The monitor is upserted
// from the check-in's monitorConfig.
import { sweepExpiredReporters } from '@/lib/couponSignals'
import * as Sentry from '@sentry/nextjs'
import 'server-only'

const HOUR_MS = 60 * 60 * 1000

export const REPORTER_RETENTION_MONITOR_SLUG =
    'caramel-coupon-reporter-retention'
// checkinMargin / maxRuntime are minutes. The sweep settles within 60 s, so a
// 3 minute maxRuntime flags a hung run; 10 minutes of margin absorbs boot and
// event-loop jitter before a check-in counts as missed.
export const REPORTER_RETENTION_MONITOR_CONFIG = {
    schedule: { type: 'interval', value: 1, unit: 'hour' },
    checkinMargin: 10,
    maxRuntime: 3,
} as const

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
 * sweepExpiredReporters never rejects and reports its own failures to Sentry;
 * the tick turns its returned outcome into the cron check-in. A failed or
 * timed-out run (or a null result, i.e. an abandoned DELETE still unsettled)
 * checks in as 'error'.
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
        void runMonitoredSweep()
    }, HOUR_MS)
    // Guarded because a faked timer (vitest) is not always a real Node Timeout.
    if (typeof timer.unref === 'function') timer.unref()
    return { enabled: true, reason: 'production default' }
}

/**
 * One timer tick: check in as in_progress, run the forced sweep, then check in
 * ok or error. A check-in that itself throws is logged and captured loudly but
 * never crashes the timer; the sweep still runs. If the in_progress check-in
 * could not be sent there is no check-in id to finish, which is logged too.
 */
export async function runMonitoredSweep(): Promise<void> {
    const checkInId = sendCheckIn({ status: 'in_progress' })
    let status: 'ok' | 'error' = 'error'
    try {
        const run = await sweepExpiredReporters({
            force: true,
            trigger: 'timer',
        })
        status =
            run && (run.outcome === 'ok' || run.outcome === 'backlog')
                ? 'ok'
                : 'error'
    } catch (error) {
        Sentry.captureException(error, {
            tags: { area: 'couponReporterRetention.timer' },
        })
        console.error('[couponReporterRetention] sweep tick threw', error)
    }
    if (checkInId === undefined) {
        console.error(
            `[couponReporterRetention] no check-in id from the in_progress check-in; the ${status} check-in was not sent`,
        )
        return
    }
    sendCheckIn({ status, checkInId })
}

function sendCheckIn(
    checkIn:
        | { status: 'in_progress' }
        | { status: 'ok' | 'error'; checkInId: string },
): string | undefined {
    try {
        return Sentry.captureCheckIn(
            { monitorSlug: REPORTER_RETENTION_MONITOR_SLUG, ...checkIn },
            // On every check-in so the monitor upsert survives a lost first one.
            REPORTER_RETENTION_MONITOR_CONFIG,
        )
    } catch (error) {
        Sentry.captureException(error, {
            tags: { area: 'couponReporterRetention.checkIn' },
        })
        console.error(
            `[couponReporterRetention] Sentry cron check-in (${checkIn.status}) failed`,
            error,
        )
        return undefined
    }
}
