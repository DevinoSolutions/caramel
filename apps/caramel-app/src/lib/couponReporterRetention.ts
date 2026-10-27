// src/lib/couponReporterRetention.ts
//
// The SCHEDULE for the reporter-row retention sweep (couponSignals.ts
// sweepExpiredReporters). The privacy policy promises that the hashed reporter
// identifiers behind failure/success reports are deleted after 30 days; the
// report route also sweeps, but only when someone reports, so a quiet period
// would keep expired rows. One unref'd timer on the one long-running process
// the app owns, started once from instrumentation.ts's register(), idempotent,
// production only (the decision is logged at boot so "is it running?" is never
// a guess). One process = one schedule: the sweep itself is single-flight, and
// a second web replica would only run a harmless second DELETE.
//
// The tick is pinned to the WALL CLOCK, not to boot (wallClockSchedule.ts holds
// the why, the boot guard and the no-sweep-at-boot rule shared by every timer):
// minute 7 UTC of every hour. A restart costs a slot only if the container is
// down at that minute; a restart anywhere else in the hour still sweeps on
// schedule. There is deliberately NO check-in at boot either: an 'ok' without
// a sweep would be a dishonest signal.
//
// Provable runs (T-6398 / T-8983): every sweep logs one summary line (see
// couponSignals.ts), and this timer, and only the timer, checks in to the
// Sentry cron monitor below (in_progress, then ok or error), so a missed or
// failed hourly run pages instead of going unnoticed. The monitor is upserted
// from the check-in's monitorConfig. A timer tick that joins an in-flight
// report-triggered run checks in from THAT run's result, so that hour's summary
// line can say trigger=report.
import { sweepExpiredReporters } from '@/lib/couponSignals'
import { runCronJobWithCheckIn } from '@/lib/sentryCronCheckIn'
import {
    startWallClockTimer,
    type TimerStartDecision,
    wallClockMonitorConfig,
    type WallClockSchedule,
} from '@/lib/wallClockSchedule'
import * as Sentry from '@sentry/nextjs'
import 'server-only'

/**
 * Minute 7 of every UTC hour. Off the :00 and :30 marks that other hourly jobs
 * and crons pile onto (the email-delivery monitor takes :23, the proposal sweep
 * :37).
 */
export const REPORTER_RETENTION_SCHEDULE: WallClockSchedule = {
    periodMinutes: 60,
    offsetMinutes: 7,
}

export const REPORTER_RETENTION_MONITOR_SLUG =
    'caramel-coupon-reporter-retention'
// The sweep settles within 60 s, so a 3 minute maxRuntime flags a hung run. The
// crontab is built from the schedule above; with a 30 minute margin plus
// failureIssueThreshold 2, one missed slot (a deploy that straddles :07) does
// not alert, while two consecutive misses (or errors) do.
export const REPORTER_RETENTION_MONITOR_CONFIG = wallClockMonitorConfig(
    REPORTER_RETENTION_SCHEDULE,
    { checkinMargin: 30, maxRuntime: 3 },
)

let started = false

/**
 * Start the hourly sweep. Idempotent (a second call is a no-op). The first run
 * is the next wall-clock slot, never boot. sweepExpiredReporters never rejects
 * and reports its own failures to Sentry; the tick turns its returned outcome
 * into the cron check-in. A failed or timed-out run, or a skipped tick (an
 * abandoned DELETE still unsettled), checks in as 'error'; backlog checks in as
 * 'ok' on purpose (a saturated sweep is visible in the logs, not a paging
 * alert). Without a Sentry client check-ins are impossible, which the boot
 * reason and every tick say loudly.
 */
export function startCouponReporterRetentionSweep(): TimerStartDecision {
    if (process.env.NODE_ENV !== 'production') {
        return {
            enabled: false,
            reason: 'non-production (the report route still sweeps on writes)',
        }
    }
    if (started) return { enabled: true, reason: 'already started' }
    started = true
    const { nextSlotAt } = startWallClockTimer({
        name: 'couponReporterRetention',
        schedule: REPORTER_RETENTION_SCHEDULE,
        onSlot: runMonitoredSweep,
    })
    return {
        enabled: true,
        reason: Sentry.getClient()
            ? `production default, next sweep ${nextSlotAt}`
            : `production default, next sweep ${nextSlotAt}, but cron check-ins DISABLED (no Sentry client)`,
    }
}

/** One timer tick: the forced sweep, mapped onto a cron check-in. */
export function runMonitoredSweep(): Promise<void> {
    return runCronJobWithCheckIn({
        label: 'couponReporterRetention',
        monitorSlug: REPORTER_RETENTION_MONITOR_SLUG,
        monitorConfig: REPORTER_RETENTION_MONITOR_CONFIG,
        run: async () => {
            const run = await sweepExpiredReporters({
                force: true,
                trigger: 'timer',
            })
            if (run.outcome === 'skipped') {
                console.error(
                    `[couponReporterRetention] tick skipped: ${
                        run.reason === 'abandoned'
                            ? 'previous DELETE still unsettled'
                            : run.reason
                    }`,
                )
                return 'error'
            }
            return run.outcome === 'ok' || run.outcome === 'backlog'
                ? 'ok'
                : 'error'
        },
    })
}
