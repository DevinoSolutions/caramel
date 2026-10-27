// src/lib/sentryCronCheckIn.ts
//
// One Sentry cron check-in wrapper for the app's wall-clock timers
// (wallClockSchedule.ts): check in as in_progress, run the job, then check in ok
// or error. Without a Sentry client no check-in is sent (captureCheckIn would
// silently pretend), which is logged on every tick. If the in_progress check-in
// could not be sent there is no check-in id to finish, which is logged too. The
// monitor is upserted from the monitorConfig carried on every check-in, so the
// upsert survives a lost first one.
//
// There is deliberately no check-in at boot: an 'ok' without a run would be a
// dishonest signal.
import type { WallClockMonitorConfig } from '@/lib/wallClockSchedule'
import * as Sentry from '@sentry/nextjs'
import 'server-only'

export interface CronJobOptions {
    /** Log prefix and Sentry `area` tag root, e.g. 'couponReporterRetention'. */
    label: string
    monitorSlug: string
    monitorConfig: WallClockMonitorConfig
    /**
     * The job. Resolves to the check-in status it earned; it logs its own
     * detail. A throw is captured to Sentry and checks in as 'error'.
     */
    run: () => Promise<'ok' | 'error'>
}

/** Never rejects: every failure is captured to Sentry, logged, and checked in as 'error'. */
export async function runCronJobWithCheckIn(
    options: CronJobOptions,
): Promise<void> {
    const { label } = options
    const hasClient = Sentry.getClient() !== undefined
    if (!hasClient) {
        console.error(
            `[${label}] no Sentry client: cron check-ins DISABLED for this tick`,
        )
    }
    const checkInId = hasClient
        ? sendCheckIn(options, { status: 'in_progress' })
        : undefined
    let status: 'ok' | 'error' = 'error'
    try {
        status = await options.run()
    } catch (error) {
        Sentry.captureException(error, { tags: { area: `${label}.timer` } })
        console.error(`[${label}] scheduled run threw`, error)
    }
    if (!hasClient) return
    if (checkInId === undefined) {
        console.error(
            `[${label}] no check-in id from the in_progress check-in; the ${status} check-in was not sent`,
        )
        return
    }
    sendCheckIn(options, { status, checkInId })
}

/**
 * captureCheckIn practically never throws (transport errors are async and
 * swallowed by the SDK), so this try/catch only covers a synchronous throw; it
 * logs and captures it rather than crashing the timer.
 */
function sendCheckIn(
    options: CronJobOptions,
    checkIn:
        | { status: 'in_progress' }
        | { status: 'ok' | 'error'; checkInId: string },
): string | undefined {
    try {
        return Sentry.captureCheckIn(
            { monitorSlug: options.monitorSlug, ...checkIn },
            options.monitorConfig,
        )
    } catch (error) {
        Sentry.captureException(error, {
            tags: { area: `${options.label}.checkIn` },
        })
        console.error(
            `[${options.label}] Sentry cron check-in (${checkIn.status}) failed`,
            error,
        )
        return undefined
    }
}
