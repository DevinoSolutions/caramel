import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deleteMany = vi.fn().mockResolvedValue({ count: 0 })
vi.mock('@/lib/prisma', () => ({
    default: { couponBoxProposal: { deleteMany } },
}))

vi.mock('@sentry/nextjs', () => ({
    captureException: vi.fn(),
}))

describe('sweepExpiredProposals', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-15T12:00:00Z'))
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('deletes proposals older than the 30-day promotion window', async () => {
        deleteMany.mockResolvedValueOnce({ count: 42 })
        const { sweepExpiredProposals } = await import('@/lib/couponBoxSave')
        const deleted = await sweepExpiredProposals()

        expect(deleted).toBe(42)
        expect(deleteMany).toHaveBeenCalledOnce()

        const where = deleteMany.mock.calls[0][0].where
        const cutoffMs = where.createdAt.lt.getTime()
        const nowMs = new Date('2026-08-15T12:00:00Z').getTime()
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
        expect(cutoffMs).toBe(nowMs - thirtyDaysMs)
    })

    it('returns 0 and reports to Sentry on failure', async () => {
        deleteMany.mockRejectedValueOnce(new Error('db down'))
        const { sweepExpiredProposals } = await import('@/lib/couponBoxSave')
        const { captureException } = await import('@sentry/nextjs')

        const deleted = await sweepExpiredProposals()

        expect(deleted).toBe(0)
        expect(captureException).toHaveBeenCalledOnce()
    })
})

describe('startCouponProposalRetentionSweep', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('is disabled in non-production', async () => {
        vi.stubEnv('NODE_ENV', 'test')
        const { startCouponProposalRetentionSweep } =
            await import('@/lib/couponProposalRetention')
        const decision = startCouponProposalRetentionSweep()
        expect(decision.enabled).toBe(false)
    })
})
