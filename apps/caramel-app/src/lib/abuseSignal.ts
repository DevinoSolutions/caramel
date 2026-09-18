// src/lib/abuseSignal.ts
//
// Makes rate-limit rejections VISIBLE outside the container log.
//
// Why this exists: on 2026-09-16 prod had 3377 rate-limit rejections in seven
// days — 2690 of them from ONE IP running `DealsbuckCouponBot/1.0` against
// /api/coupons, i.e. a competitor walking our catalog. Every one of those was
// a `console.warn('[ratelimit] …')` line inside the web container and NOTHING
// else: no Sentry issue, no analytics event, no alertable signal. The guard
// worked; the knowledge that it had to work never left the box. Sentry silence
// was therefore not "no abuse", it was "no reporter" — exactly the
// no-activity-is-a-claim-about-your-telemetry failure this module closes.
//
// Contract:
//   * EVERY rejection leaves a breadcrumb (cheap, no network) so any later
//     Sentry event from the same request carries the abuse context.
//   * SUSTAINED abuse from one client escalates ONCE per client per window to
//     a real Sentry event + a server-side PostHog event, so a scrape is a
//     query and an alert, not a grep.
//   * It is throttled ON PURPOSE: 2690 Sentry events would be noise, one
//     event carrying `rejections: 2690` is a decision.
//   * It NEVER throws and never blocks the request — the caller already has
//     its 429 in hand.
//   * The client IP is never sent raw to analytics: the PostHog distinct id is
//     a truncated SHA-256 of the IP, which is stable enough to count a
//     repeat offender and useless as a personal identifier. Sentry (our own
//     ops surface, not a product analytics store) does get the raw IP,
//     because acting on a scraper means writing an edge rule for that IP.
import * as Sentry from '@sentry/nextjs'
import { createHash } from 'node:crypto'

/** Rejections from one client within a window before we escalate once. */
export const SUSTAINED_THRESHOLD = 50
/** Escalation window. One escalation per client per window, then it resets. */
export const WINDOW_MS = 60 * 60 * 1000
/** Hard cap on tracked clients so a rotating-IP flood cannot grow the map. */
const MAX_TRACKED = 5000

interface ClientCounter {
    windowStartedAt: number
    rejections: number
    escalated: boolean
    paths: Set<string>
}

const counters = new Map<string, ClientCounter>()

/** Test seam: drop all accumulated state. Not used by production code. */
export function resetAbuseCountersForTest(): void {
    counters.clear()
}

/** Truncated SHA-256 of the client IP — stable, non-reversible in practice. */
export function hashClientIp(ip: string): string {
    return createHash('sha256').update(ip).digest('hex').slice(0, 16)
}

function counterFor(ip: string, now: number): ClientCounter {
    const existing = counters.get(ip)
    if (existing && now - existing.windowStartedAt < WINDOW_MS) return existing

    if (!existing && counters.size >= MAX_TRACKED) {
        // Oldest insertion first — Map preserves insertion order.
        const oldest = counters.keys().next().value
        if (oldest) counters.delete(oldest)
    }
    const fresh: ClientCounter = {
        windowStartedAt: now,
        rejections: 0,
        escalated: false,
        paths: new Set<string>(),
    }
    counters.set(ip, fresh)
    return fresh
}

export interface RateLimitRejection {
    ip: string
    path: string
    kind: string
    userAgent: string
    retryAfterSec: number
}

/**
 * Record one rate-limit rejection. Returns true when this call escalated
 * (Sentry event + analytics event), false otherwise — so a test can assert
 * the throttle instead of spying on two SDKs.
 */
export async function reportRateLimitRejection(
    rejection: RateLimitRejection,
): Promise<boolean> {
    try {
        const now = Date.now()
        const counter = counterFor(rejection.ip, now)
        counter.rejections += 1
        counter.paths.add(rejection.path)

        Sentry.addBreadcrumb({
            category: 'ratelimit',
            level: 'warning',
            message: `rate limited ${rejection.kind} ${rejection.path}`,
            data: {
                ip: rejection.ip,
                kind: rejection.kind,
                path: rejection.path,
                retry_after_sec: rejection.retryAfterSec,
                user_agent: rejection.userAgent,
                rejections_in_window: counter.rejections,
            },
        })

        if (counter.escalated || counter.rejections < SUSTAINED_THRESHOLD) {
            return false
        }
        counter.escalated = true

        const clientHash = hashClientIp(rejection.ip)
        const paths = Array.from(counter.paths).sort().join(',')

        Sentry.captureMessage(
            `Sustained rate-limit abuse: ${counter.rejections} rejections in ${Math.round(
                WINDOW_MS / 60000,
            )}m from one client`,
            {
                level: 'warning',
                tags: {
                    surface: 'rate-limit-abuse',
                    // Low cardinality: the route family, not the full URL.
                    abuse_kind: rejection.kind,
                },
                extra: {
                    ip: rejection.ip,
                    client_hash: clientHash,
                    rejections_in_window: counter.rejections,
                    paths,
                    user_agent: rejection.userAgent,
                    window_minutes: Math.round(WINDOW_MS / 60000),
                },
            },
        )

        // Dynamic import: posthog-node must never be pulled into the edge
        // runtime, and `server-only` must not be evaluated by an edge build.
        // Mirrors instrumentation.ts's boot capture.
        const { captureServerEvent } = await import(
            '@/lib/analytics/posthogServer'
        )
        await captureServerEvent({
            event: 'api_abuse_detected',
            distinctId: `ip:${clientHash}`,
            properties: {
                rejections_in_window: counter.rejections,
                window_minutes: Math.round(WINDOW_MS / 60000),
                paths,
                kind: rejection.kind,
                user_agent: rejection.userAgent,
            },
        })
        return true
    } catch (error) {
        // Reporting abuse must never become the incident. One Sentry line,
        // swallowed here on purpose (documented, not a silent catch).
        Sentry.captureException(error, {
            tags: { operation: 'abuse_signal_report' },
        })
        return false
    }
}
