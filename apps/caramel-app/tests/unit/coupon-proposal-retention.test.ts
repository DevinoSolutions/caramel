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
        const result = await sweepExpiredProposals()

        expect(result).toEqual({ outcome: 'ok', deleted: 42 })
        expect(deleteMany).toHaveBeenCalledOnce()

        const where = deleteMany.mock.calls[0][0].where
        const cutoffMs = where.createdAt.lt.getTime()
        const nowMs = new Date('2026-08-15T12:00:00Z').getTime()
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
        expect(cutoffMs).toBe(nowMs - thirtyDaysMs)
    })

    it('returns a failed outcome (not 0 deleted) and reports to Sentry on failure', async () => {
        deleteMany.mockRejectedValueOnce(new Error('db down'))
        const { sweepExpiredProposals } = await import('@/lib/couponBoxSave')
        const { captureException } = await import('@sentry/nextjs')

        const result = await sweepExpiredProposals()

        expect(result).toEqual({ outcome: 'failed' })
        expect(captureException).toHaveBeenCalledOnce()
    })
})
