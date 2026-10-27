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
// The tick is pinned to the WALL CLOCK, not to boot: it fires at minute
// REPORTER_RETENTION_SLOT_MINUTE (UTC) of every hour. A boot-relative
// setInterval starts counting from each restart, so on 2026-10-27, when prod
// restarted every 30-40 minutes (deploys), no tick ever fired, the sweep did
// not run on its timer and the Sentry monitor alerted (CARAMEL-39, T-9433). On
// the wall clock a restart costs a slot only if the container is down at that
// minute; a restart anywhere else in the hour still sweeps on schedule.
//
// There is deliberately NO sweep and NO check-in at boot: an 'ok' without a
// sweep would be a dishonest signal, and a crash-looping container must not
// hammer the database. For the same reason a boot that lands within
// BOOT_GUARD_MS before the slot (or after it) waits for the NEXT slot, so a
// crash loop sweeps at most once an hour, never once per restart.
//
// Provable runs (T-6398 / T-8983): every sweep logs one summary line (see
// couponSignals.ts), and this timer, and only the timer, checks in to the
// Sentry cron monitor below (in_progress, then ok or error), so a missed or
// failed hourly run pages instead of going unnoticed. The monitor is upserted
// from the check-in's monitorConfig. A timer tick that joins an in-flight
// report-triggered run checks in from THAT run's result, so that hour's summary
// line can say trigger=report.
import { sweepExpiredReporters } from '@/lib/couponSignals'
import * as Sentry from '@sentry/nextjs'
import 'server-only'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

/**
 * Minute past every UTC hour at which the sweep runs. Off the :00 and :30
 * marks that other hourly jobs and crons pile onto; the Sentry monitor's
 * crontab below is built from this same constant.
 */
export const REPORTER_RETENTION_SLOT_MINUTE = 7

/**
 * A boot closer than this before the slot waits for the next one instead of
 * sweeping seconds after start, so a crash-looping container cannot hammer the
 * database.
 */
const BOOT_GUARD_MS = 2 * MINUTE_MS

export const REPORTER_RETENTION_MONITOR_SLUG =
    'caramel-coupon-reporter-retention'
// checkinMargin / maxRuntime are minutes. The sweep settles within 60 s, so a
// 3 minute maxRuntime flags a hung run. The crontab expects the check-in at :07
// UTC; with a 30 minute margin plus failureIssueThreshold 2, one missed slot (a
// deploy that straddles :07) does not alert, while two consecutive misses (or
// errors) do. The timezone is pinned to UTC because the slot is computed on UTC
// hour boundaries.
export const REPORTER_RETENTION_MONITOR_CONFIG = {
    schedule: {
        type: 'crontab',
        value: `${REPORTER_RETENTION_SLOT_MINUTE} * * * *`,
    },
    timezone: 'UTC',
    checkinMargin: 30,
    maxRuntime: 3,
    failureIssueThreshold: 2,
    recoveryThreshold: 1,
} as const

let timer: NodeJS.Timeout | null = null

export interface RetentionDecision {
    enabled: boolean
    /** Why it is (not) running, logged at boot. */
    reason: string
}

/**
 * Milliseconds from `nowMs` to the next slot that is at least BOOT_GUARD_MS
 * away. Pure wall-clock arithmetic (no state), so a re-arm after a tick never
 * drifts and a timer that fires a few ms early cannot run the same slot twice.
 */
export function msUntilNextRetentionSlot(nowMs: number): number {
    let slotMs =
        Math.floor(nowMs / HOUR_MS) * HOUR_MS +
        REPORTER_RETENTION_SLOT_MINUTE * MINUTE_MS
    while (slotMs - nowMs < BOOT_GUARD_MS) slotMs += HOUR_MS
    return slotMs - nowMs
}

/**
 * Arm the one-shot timer for the next wall-clock slot. The tick re-arms BEFORE
 * it sweeps, so nothing the sweep does can end the schedule. Timers are
 * unref'd, so they never hold the process open.
 */
function armNextSlot(): void {
    timer = setTimeout(() => {
        armNextSlot()
        void runMonitoredSweep()
    }, msUntilNextRetentionSlot(Date.now()))
    // Guarded because a faked timer (vitest) is not always a real Node Timeout.
    if (typeof timer.unref === 'function') timer.unref()
}

/**
 * Start the hourly sweep. Idempotent (a second call is a no-op). The first run
 * is the next wall-clock slot that is at least BOOT_GUARD_MS away, never at
 * boot. sweepExpiredReporters never rejects and reports its own failures to
 * Sentry; the tick turns its returned outcome into the cron check-in. A failed
 * or timed-out run, or a skipped tick (an abandoned DELETE still unsettled),
 * checks in as 'error'; backlog checks in as 'ok' on purpose (a saturated
 * sweep is visible in the logs, not a paging alert). Without a Sentry client
 * check-ins are impossible, which the boot reason and every tick say loudly.
 */
export function startCouponReporterRetentionSweep(): RetentionDecision {
    if (process.env.NODE_ENV !== 'production') {
        return {
            enabled: false,
            reason: 'non-production (the report route still sweeps on writes)',
        }
    }
    if (timer) return { enabled: true, reason: 'already started' }
    const now = Date.now()
    armNextSlot()
    const nextSweepAt = new Date(
        now + msUntilNextRetentionSlot(now),
    ).toISOString()
    return {
        enabled: true,
        reason: Sentry.getClient()
            ? `production default, next sweep ${nextSweepAt}`
            : `production default, next sweep ${nextSweepAt}, but cron check-ins DISABLED (no Sentry client)`,
    }
}

/**
 * One timer tick: check in as in_progress, run the forced sweep, then check in
 * ok or error. Without a Sentry client no check-in is sent (captureCheckIn would
 * silently pretend), which is logged on every tick. If the in_progress check-in
 * could not be sent there is no check-in id to finish, which is logged too.
 */
export async function runMonitoredSweep(): Promise<void> {
    const hasClient = Sentry.getClient() !== undefined
    if (!hasClient) {
        console.error(
            '[couponReporterRetention] no Sentry client: cron check-ins DISABLED for this tick',
        )
    }
    const checkInId = hasClient
        ? sendCheckIn({ status: 'in_progress' })
        : undefined
    let status: 'ok' | 'error' = 'error'
    try {
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
        } else if (run.outcome === 'ok' || run.outcome === 'backlog') {
            status = 'ok'
        }
    } catch (error) {
        Sentry.captureException(error, {
            tags: { area: 'couponReporterRetention.timer' },
        })
        console.error('[couponReporterRetention] sweep tick threw', error)
    }
    if (!hasClient) return
    if (checkInId === undefined) {
        console.error(
            `[couponReporterRetention] no check-in id from the in_progress check-in; the ${status} check-in was not sent`,
        )
        return
    }
    sendCheckIn({ status, checkInId })
}

/**
 * captureCheckIn practically never throws (transport errors are async and
 * swallowed by the SDK), so this try/catch only covers a synchronous throw; it
 * logs and captures it rather than crashing the timer.
 */
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
