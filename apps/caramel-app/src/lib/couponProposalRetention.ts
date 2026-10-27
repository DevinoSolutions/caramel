// src/lib/couponProposalRetention.ts
//
// SCHEDULE for the proposal-row retention sweep. coupon_box_proposals rows
// older than AUTO_DETECT_CONFIG_MAX_AGE_DAYS (30 days) can never count toward
// a quorum, so they are dead weight. Same pattern as couponReporterRetention.ts:
// one unref'd wall-clock timer on the long-running process (wallClockSchedule.ts
// holds the why: a boot-relative interval never fires when deploys are closer
// together than the interval), started once from instrumentation.ts,
// idempotent, production only, no sweep at boot.
//
// Every six hours at 00:37, 06:37, 12:37 and 18:37 UTC. Each tick checks in to
// the Sentry cron monitor below (in_progress, then ok or error), so a missed or
// failed sweep pages instead of going unnoticed; a sweep that fails is returned
// as `failed` by sweepExpiredProposals (it also reports to Sentry itself).
import { sweepExpiredProposals } from '@/lib/couponBoxSave'
import { runCronJobWithCheckIn } from '@/lib/sentryCronCheckIn'
import {
    startWallClockTimer,
    type TimerStartDecision,
    wallClockMonitorConfig,
    type WallClockSchedule,
} from '@/lib/wallClockSchedule'
import * as Sentry from '@sentry/nextjs'
import 'server-only'

export const PROPOSAL_RETENTION_SCHEDULE: WallClockSchedule = {
    periodMinutes: 6 * 60,
    offsetMinutes: 37,
}

export const PROPOSAL_RETENTION_MONITOR_SLUG =
    'caramel-coupon-proposal-retention'
// One DELETE over created_at (indexed) settles in seconds; 5 minutes flags a
// hung run. The margin is 30 minutes against a 6 hour period, and with
// failureIssueThreshold 2 one missed slot does not alert.
export const PROPOSAL_RETENTION_MONITOR_CONFIG = wallClockMonitorConfig(
    PROPOSAL_RETENTION_SCHEDULE,
    { checkinMargin: 30, maxRuntime: 5 },
)

let started = false

export function startCouponProposalRetentionSweep(): TimerStartDecision {
    if (process.env.NODE_ENV !== 'production') {
        return { enabled: false, reason: 'non-production' }
    }
    if (started) return { enabled: true, reason: 'already started' }
    started = true
    const { nextSlotAt } = startWallClockTimer({
        name: 'couponProposalRetention',
        schedule: PROPOSAL_RETENTION_SCHEDULE,
        onSlot: runMonitoredProposalSweep,
    })
    return {
        enabled: true,
        reason: Sentry.getClient()
            ? `production default, next sweep ${nextSlotAt}`
            : `production default, next sweep ${nextSlotAt}, but cron check-ins DISABLED (no Sentry client)`,
    }
}

/** One timer tick: the sweep, mapped onto a cron check-in. */
function runMonitoredProposalSweep(): Promise<void> {
    return runCronJobWithCheckIn({
        label: 'couponProposalRetention',
        monitorSlug: PROPOSAL_RETENTION_MONITOR_SLUG,
        monitorConfig: PROPOSAL_RETENTION_MONITOR_CONFIG,
        run: async () => {
            const result = await sweepExpiredProposals()
            if (result.outcome === 'failed') {
                console.error(
                    '[couponProposalRetention] sweep failed (details logged and captured by sweepExpiredProposals)',
                )
                return 'error'
            }
            console.log(
                `[couponProposalRetention] swept deleted=${result.deleted}`,
            )
            return 'ok'
        },
    })
}
