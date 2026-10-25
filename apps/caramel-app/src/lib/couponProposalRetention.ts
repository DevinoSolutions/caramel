// src/lib/couponProposalRetention.ts
//
// SCHEDULE for the proposal-row retention sweep. coupon_box_proposals rows
// older than AUTO_DETECT_CONFIG_MAX_AGE_DAYS (30 days) can never count toward
// a quorum, so they are dead weight. Same pattern as couponReporterRetention.ts:
// one unref'd interval on the long-running process, started once from
// instrumentation.ts, idempotent, production only.
import { sweepExpiredProposals } from '@/lib/couponBoxSave'
import 'server-only'

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null

export interface RetentionDecision {
    enabled: boolean
    reason: string
}

export function startCouponProposalRetentionSweep(): RetentionDecision {
    if (process.env.NODE_ENV !== 'production') {
        return { enabled: false, reason: 'non-production' }
    }
    if (timer) return { enabled: true, reason: 'already started' }
    timer = setInterval(() => {
        void sweepExpiredProposals()
    }, SIX_HOURS_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return { enabled: true, reason: 'production default' }
}
