// src/lib/emailDeliveryHealthMonitor.ts
//
// The SCHEDULE for the async email-delivery check in ./emailDeliveryHealth.ts.
//
// Caramel has no cron, no worker and no queue — the Next.js server is the only
// long-running process the app owns, so the lightest honest scheduler is an
// unref'd interval started once from instrumentation.ts's register(). That is
// deliberate and has two consequences worth knowing before you extend it:
//
//   * one process = one schedule. The prod compose runs a single web container
//     (compose-input-bluetooth-application-qvdfbq-web-1); if that ever becomes
//     N replicas, N checks run and N Sentry events fire per bad hour. At that
//     point this moves to a real scheduler — do not paper over it with a lock.
//   * the first run happens one full interval AFTER boot, never at boot. A
//     crash-looping container must not be able to machine-gun Sentry, and
//     "email delivery in the last hour" is not a boot-time question anyway.
//
// On top of that, `lastSentryHourBucket` caps the alert rate at ONE Sentry event
// per clock hour per process even if the interval is configured shorter.
//
// Enabled by default in production when useSend is configured; the env var
// EMAIL_DELIVERY_HEALTH_ENABLED is an explicit override in BOTH directions
// ('false' = opt out of the default, 'true' = force it on outside production).
import {
    checkEmailDeliveryHealth,
    formatEmailDeliveryHealthLine,
    type EmailDeliveryHealthReport,
} from '@/lib/emailDeliveryHealth'
import { env } from '@/lib/env'
import * as Sentry from '@sentry/nextjs'
import 'server-only'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

let timer: NodeJS.Timeout | null = null
let running = false
let lastSentryHourBucket: number | null = null

// The three above are module state on purpose: there is exactly one server
// process and exactly one schedule. Tests get a clean slate with
// vi.resetModules() + a fresh dynamic import rather than a test-only reset
// export (which knip would rightly call dead code in src/).

export interface EmailDeliveryHealthSettings {
    NODE_ENV?: string
    USESEND_API_KEY?: string
    USESEND_BASE_URL?: string
    USESEND_FROM_EMAIL?: string
    EMAIL_DELIVERY_HEALTH_ENABLED?: 'true' | 'false'
    EMAIL_DELIVERY_HEALTH_INTERVAL_MINUTES?: number
}

export interface MonitorDecision {
    enabled: boolean
    /** Why it is (not) running — logged at boot so the posture is never a guess. */
    reason: string
}

/**
 * Decide whether the monitor should run. Pure, so the whole default/override
 * matrix is a table test rather than a deploy-time surprise.
 */
export function decideEmailDeliveryHealthMonitor(
    settings: EmailDeliveryHealthSettings,
): MonitorDecision {
    const configured = Boolean(settings.USESEND_API_KEY)
    if (settings.EMAIL_DELIVERY_HEALTH_ENABLED === 'false') {
        return {
            enabled: false,
            reason: 'disabled by EMAIL_DELIVERY_HEALTH_ENABLED=false',
        }
    }
    if (!configured) {
        return {
            enabled: false,
            reason: 'useSend is not configured (USESEND_API_KEY unset)',
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
 * Report a window to Sentry — at most one event per clock hour. A 'degraded' or
 * 'error' window is an issue; 'ok' and 'skipped' are not. Never throws: a
 * broken reporter must not kill the interval that produced the finding.
 *
 * Returns whether an event was actually sent, so the caller can log the
 * outcome instead of firing and forgetting.
 */
export async function reportEmailDeliveryHealth(
    report: EmailDeliveryHealthReport,
    now: Date = new Date(),
): Promise<boolean> {
    if (report.status !== 'degraded' && report.status !== 'error') return false
    const bucket = Math.floor(now.getTime() / HOUR_MS)
    if (lastSentryHourBucket === bucket) return false
    lastSentryHourBucket = bucket

    try {
        const level = report.failed > 0 || report.status === 'error'
        Sentry.captureMessage(
            report.status === 'error'
                ? 'Transactional email delivery health check failed'
                : 'Transactional email delivery degraded',
            {
                level: level ? 'error' : 'warning',
                tags: {
                    surface: 'email-delivery-health',
                    provider: 'usesend',
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
                    domainId: report.domainId,
                    truncated: report.truncated,
                    reason: report.reason,
                },
            },
        )
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
        baseUrl: env.USESEND_BASE_URL ?? '',
        apiKey: env.USESEND_API_KEY ?? '',
        fromEmail: env.USESEND_FROM_EMAIL,
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
 * Start the interval. Idempotent (a second call is a no-op) and unref'd, so it
 * never holds the process open. Returns the decision it acted on.
 */
export function startEmailDeliveryHealthMonitor(): MonitorDecision {
    const decision = decideEmailDeliveryHealthMonitor({
        NODE_ENV: process.env.NODE_ENV,
        USESEND_API_KEY: env.USESEND_API_KEY,
        EMAIL_DELIVERY_HEALTH_ENABLED: env.EMAIL_DELIVERY_HEALTH_ENABLED,
    })
    if (!decision.enabled || timer) return decision

    const intervalMs = env.EMAIL_DELIVERY_HEALTH_INTERVAL_MINUTES * MINUTE_MS
    timer = setInterval(() => {
        // Overlap guard: a slow provider must not stack cycles.
        if (running) {
            console.warn('[email-health] previous cycle still running, skipped')
            return
        }
        running = true
        // The interval callback cannot be awaited by anyone, so the failure
        // path is handled HERE rather than left to an unhandled rejection —
        // runEmailDeliveryHealthCycle itself never throws, and this catch is
        // the belt to that braces.
        void runEmailDeliveryHealthCycle()
            .catch((error: unknown) => {
                console.error('[email-health] cycle threw:', error)
                Sentry.captureException(error, {
                    tags: { surface: 'email-delivery-health' },
                })
            })
            .finally(() => {
                running = false
            })
    }, intervalMs)
    // Never hold the process open for a health check. Guarded because a faked
    // timer (vitest) is not always a real Node Timeout.
    if (typeof timer.unref === 'function') timer.unref()
    return decision
}
