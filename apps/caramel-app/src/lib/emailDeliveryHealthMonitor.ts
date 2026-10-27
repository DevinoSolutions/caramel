// src/lib/emailDeliveryHealthMonitor.ts
//
// The SCHEDULE for the async email-delivery check in ./emailDeliveryHealth.ts.
//
// Caramel has no cron, no worker and no queue — the Next.js server is the only
// long-running process the app owns, so the lightest honest scheduler is an
// unref'd wall-clock timer (wallClockSchedule.ts) started once from
// instrumentation.ts's register(). That is deliberate and has two consequences
// worth knowing before you extend it:
//
//   * one process = one schedule. The prod compose runs a single web container
//     (compose-input-bluetooth-application-qvdfbq-web-1); if that ever becomes
//     N replicas, N checks run and N Sentry events fire per bad hour. At that
//     point this moves to a real scheduler — do not paper over it with a lock.
//   * runs are pinned to the WALL CLOCK (minute 23 UTC for the default hourly
//     period), never to boot, and never AT boot. A boot-relative interval
//     starts counting at every restart, so deploys closer together than the
//     interval starved it silently (T-9436, same bug as CARAMEL-39). A
//     crash-looping container still cannot machine-gun Sentry: a boot just
//     before a slot waits for the next one, and "email delivery in the last
//     hour" is not a boot-time question anyway.
//
// Each run checks in to a Sentry cron monitor (in_progress, then ok or error),
// so a run that never happens pages. 'ok' means the CHECK ran, even when it
// found delivery problems (those are their own Sentry event below); 'error'
// means it could not run: provider unreachable or refused, unusable sender,
// Sendly unconfigured, a thrown cycle, or an overlapping cycle.
//
// On top of that, `lastSentryHourBucket` caps the alert rate at ONE Sentry event
// per clock hour per process even if the interval is configured shorter.
//
// Enabled by default in production when Sendly is configured; the env var
// EMAIL_DELIVERY_HEALTH_ENABLED is an explicit override in BOTH directions
// ('false' = opt out of the default, 'true' = force it on outside production).
import {
    checkEmailDeliveryHealth,
    formatEmailDeliveryHealthLine,
    type EmailDeliveryHealthReport,
} from '@/lib/emailDeliveryHealth'
import { env } from '@/lib/env'
import { runCronJobWithCheckIn } from '@/lib/sentryCronCheckIn'
import {
    startWallClockTimer,
    wallClockMonitorConfig,
    type TimerStartDecision,
    type WallClockMonitorConfig,
    type WallClockSchedule,
} from '@/lib/wallClockSchedule'
import * as Sentry from '@sentry/nextjs'
import 'server-only'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/**
 * Minute 23 past UTC midnight, taken modulo the period: :23 every hour by
 * default. Off the :00/:30 marks and away from the :07 reporter sweep and the
 * :37 proposal sweep.
 */
const EMAIL_HEALTH_SLOT_OFFSET_MINUTES = 23
export const EMAIL_HEALTH_MONITOR_SLUG = 'caramel-email-delivery-health'

/**
 * The run schedule: every EMAIL_DELIVERY_HEALTH_INTERVAL_MINUTES, which is also
 * the window each run reads. Consecutive slots read consecutive windows, but a
 * missed slot (a restart across it, or the boot guard) leaves its window unread,
 * and timer lag shifts a window by milliseconds.
 */
export function emailDeliveryHealthSchedule(
    periodMinutes: number,
): WallClockSchedule {
    return { periodMinutes, offsetMinutes: EMAIL_HEALTH_SLOT_OFFSET_MINUTES }
}

/**
 * The cron monitor config, built from the same schedule as the timer. The
 * margin is half the period (at most 30 minutes) so a short period's miss is
 * noticed before the next slot; maxRuntime covers the page-budgeted Sendly
 * reads plus the 2 s Sentry flush.
 */
export function emailDeliveryHealthMonitorConfig(
    periodMinutes: number,
): WallClockMonitorConfig {
    return wallClockMonitorConfig(emailDeliveryHealthSchedule(periodMinutes), {
        checkinMargin: Math.min(30, Math.floor(periodMinutes / 2)),
        maxRuntime: 5,
    })
}

let started = false
let running = false
let lastSentryHourBucket: number | null = null

// The state above is module state on purpose: there is exactly one server
// process and exactly one schedule. Tests get a clean slate with
// vi.resetModules() + a fresh dynamic import rather than a test-only reset
// export (which knip would rightly call dead code in src/).

export interface EmailDeliveryHealthSettings {
    NODE_ENV?: string
    SENDLY_API_KEY?: string
    EMAIL_DELIVERY_HEALTH_ENABLED?: 'true' | 'false'
    EMAIL_DELIVERY_HEALTH_INTERVAL_MINUTES?: number
}

/**
 * Decide whether the monitor should run. Pure, so the whole default/override
 * matrix is a table test rather than a deploy-time surprise.
 */
export function decideEmailDeliveryHealthMonitor(
    settings: EmailDeliveryHealthSettings,
): TimerStartDecision {
    const configured = Boolean(settings.SENDLY_API_KEY)
    if (settings.EMAIL_DELIVERY_HEALTH_ENABLED === 'false') {
        return {
            enabled: false,
            reason: 'disabled by EMAIL_DELIVERY_HEALTH_ENABLED=false',
        }
    }
    if (!configured) {
        return {
            enabled: false,
            reason: 'Sendly is not configured (SENDLY_API_KEY unset)',
        }
    }
    if (settings.EMAIL_DELIVERY_HEALTH_ENABLED === 'true') {
        return { enabled: true, reason: 'EMAIL_DELIVERY_HEALTH_ENABLED=true' }
    }
    if (settings.NODE_ENV === 'production') {
        return { enabled: true, reason: 'production default' }
    }
    return {
        enabled: false,
        reason: 'non-production default (set EMAIL_DELIVERY_HEALTH_ENABLED=true to force)',
    }
}

/**
 * Report a window to Sentry — at most one event per clock hour. A 'degraded',
 * 'incomplete' (coverage gap) or 'error' window is an issue; 'ok' and 'skipped'
 * are not. Never throws: a
 * broken reporter must not kill the interval that produced the finding.
 *
 * Returns whether an event was actually sent, so the caller can log the
 * outcome instead of firing and forgetting.
 */
export async function reportEmailDeliveryHealth(
    report: EmailDeliveryHealthReport,
    now: Date = new Date(),
): Promise<boolean> {
    if (report.status === 'ok' || report.status === 'skipped') return false
    const bucket = Math.floor(now.getTime() / HOUR_MS)
    if (lastSentryHourBucket === bucket) return false
    lastSentryHourBucket = bucket

    try {
        const level = report.failed > 0 || report.status === 'error'
        const message =
            report.status === 'error'
                ? 'Transactional email delivery health check failed'
                : report.status === 'incomplete'
                  ? 'Transactional email delivery health check incomplete'
                  : 'Transactional email delivery degraded'
        Sentry.captureMessage(message, {
            level: level ? 'error' : 'warning',
            tags: {
                surface: 'email-delivery-health',
                provider: 'sendly',
                health_status: report.status,
            },
            // Counts and statuses only — the send log's to/subject/html
            // never reach this object (see emailDeliveryHealth.ts).
            extra: {
                windowStart: report.windowStart,
                windowEnd: report.windowEnd,
                scanned: report.scanned,
                failed: report.failed,
                delayed: report.delayed,
                stuckPending: report.stuckPending,
                byStatus: report.byStatus,
                senderDomain: report.senderDomain,
                truncated: report.truncated,
                reason: report.reason,
            },
        })
        await Sentry.flush(2000)
        return true
    } catch (error) {
        console.error('[email-health] Sentry report failed:', error)
        return false
    }
}

/**
 * One full cycle: read the provider's log, log the one-line summary, report a
 * bad window. Exported for the interval below and for tests; returns the report
 * so no caller has to infer what happened.
 */
export async function runEmailDeliveryHealthCycle(): Promise<EmailDeliveryHealthReport> {
    const report = await checkEmailDeliveryHealth({
        apiKey: env.SENDLY_API_KEY ?? '',
        baseUrl: env.SENDLY_BASE_URL,
        fromEmail: env.SENDLY_FROM_EMAIL,
        windowMinutes: env.EMAIL_DELIVERY_HEALTH_INTERVAL_MINUTES,
    })
    const line = formatEmailDeliveryHealthLine(report)
    if (report.status === 'ok' || report.status === 'skipped') {
        console.log(line)
    } else {
        console.warn(line)
    }
    const sent = await reportEmailDeliveryHealth(report)
    if (sent) console.warn('[email-health] reported to Sentry')
    return report
}

/**
 * One scheduled tick: the cycle, mapped onto a cron check-in. A cycle that
 * completes (ok, degraded, incomplete) earns 'ok'; a check that could not run,
 * a thrown cycle or a still-running previous cycle earns 'error'.
 */
function runMonitoredEmailHealthCycle(): Promise<void> {
    return runCronJobWithCheckIn({
        label: 'email-health',
        monitorSlug: EMAIL_HEALTH_MONITOR_SLUG,
        monitorConfig: emailDeliveryHealthMonitorConfig(
            env.EMAIL_DELIVERY_HEALTH_INTERVAL_MINUTES,
        ),
        // Kept from before the cron monitor so alert rules keyed on it still match.
        errorTags: { surface: 'email-delivery-health' },
        run: async () => {
            // Overlap guard: a slow provider must not stack cycles.
            if (running) {
                console.warn(
                    '[email-health] previous cycle still running, skipped',
                )
                return 'error'
            }
            running = true
            try {
                const report = await runEmailDeliveryHealthCycle()
                return report.status === 'error' || report.status === 'skipped'
                    ? 'error'
                    : 'ok'
            } finally {
                running = false
            }
        },
    })
}

/**
 * Start the schedule. Idempotent (a second call is a no-op) and unref'd, so it
 * never holds the process open. Returns the decision it acted on.
 */
export function startEmailDeliveryHealthMonitor(): TimerStartDecision {
    const decision = decideEmailDeliveryHealthMonitor({
        NODE_ENV: process.env.NODE_ENV,
        SENDLY_API_KEY: env.SENDLY_API_KEY,
        EMAIL_DELIVERY_HEALTH_ENABLED: env.EMAIL_DELIVERY_HEALTH_ENABLED,
    })
    if (!decision.enabled || started) return decision
    started = true

    const { nextSlotAt } = startWallClockTimer({
        name: 'email-health',
        schedule: emailDeliveryHealthSchedule(
            env.EMAIL_DELIVERY_HEALTH_INTERVAL_MINUTES,
        ),
        onSlot: runMonitoredEmailHealthCycle,
    })
    return { ...decision, reason: `${decision.reason}, next run ${nextSlotAt}` }
}
