import { beforeEach, describe, expect, it, vi } from 'vitest'

// createModelCallBudget (src/lib/modelCallBudget.ts): the optional `daily`
// bucket. Without it a budget behaves exactly as before (classify-cart's
// tests in classify-cart-model-budget.test.ts pin that end to end).

const { captureMessageMock } = vi.hoisted(() => ({
    captureMessageMock: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: captureMessageMock,
}))
// MOCK (announced): abuseSignal's own fan-out is pinned in abuse-signal.test.ts.
vi.mock('@/lib/abuseSignal', () => ({
    reportRateLimitRejection: vi.fn(async () => false),
}))

import {
    createModelCallBudget,
    ModelCallBudgetExceededError,
} from '@/lib/modelCallBudget'

const client = (ip: string) => ({ ip, path: '/x', userAgent: 'ua' })

beforeEach(() => captureMessageMock.mockClear())

describe('createModelCallBudget daily bucket', () => {
    const make = (dailyPoints?: number) =>
        createModelCallBudget({
            label: 'test-route',
            abuseKind: 'test-model',
            perClient: { points: 100, duration: 600 },
            global: { points: 100, duration: 3600 },
            ...(dailyPoints === undefined
                ? {}
                : { daily: { points: dailyPoints, duration: 86400 } }),
        })

    it('absent: no daily limit and no daily entry in limits', async () => {
        const budget = make()
        expect(budget.limits).toEqual({ perClient: 100, global: 100 })
        for (let i = 0; i < 50; i++) await budget.admit(client(`1.1.1.${i}`))
    })

    it('trips at N with scope daily, a retry-after, and ONE Sentry event per window', async () => {
        const budget = make(3)
        expect(budget.limits.daily).toBe(3)
        for (let i = 0; i < 3; i++) await budget.admit(client('1.1.1.1'))

        const trip = await budget.admit(client('1.1.1.2')).catch(e => e)
        expect(trip).toBeInstanceOf(ModelCallBudgetExceededError)
        expect(trip).toMatchObject({ scope: 'daily' })
        expect(trip.retryAfterSec).toBeGreaterThan(0)
        expect(trip.retryAfterSec).toBeLessThanOrEqual(86400)

        for (let i = 0; i < 4; i++) {
            await expect(budget.admit(client('1.1.1.3'))).rejects.toMatchObject(
                { scope: 'daily' },
            )
        }
        expect(captureMessageMock).toHaveBeenCalledTimes(1)
        expect(captureMessageMock.mock.calls[0]![0]).toBe(
            'test-route daily model-call budget exhausted',
        )
    })

    it('0 refuses the first call', async () => {
        const budget = make(0)
        await expect(budget.admit(client('1.1.1.1'))).rejects.toMatchObject({
            scope: 'daily',
        })
    })

    it('a daily refusal refunds the client and global points it consumed', async () => {
        const budget = createModelCallBudget({
            label: 'refund-route',
            abuseKind: 'refund-model',
            perClient: { points: 2, duration: 600 },
            global: { points: 2, duration: 3600 },
            daily: { points: 1, duration: 86400 },
        })
        await budget.admit(client('9.9.9.9'))
        // Refused on the daily cap, many times: if each refusal kept its
        // client/global point, the next errors would turn into scope client
        // or global after one or two tries instead of staying daily.
        for (let i = 0; i < 6; i++) {
            await expect(budget.admit(client('9.9.9.9'))).rejects.toMatchObject(
                { scope: 'daily' },
            )
        }
    })

    it('the resetForTests reset also clears the daily bucket and its report throttle', async () => {
        const budget = make(1)
        await budget.admit(client('1.1.1.1'))
        await expect(budget.admit(client('1.1.1.1'))).rejects.toMatchObject({
            scope: 'daily',
        })
        budget.resetForTests()
        await budget.admit(client('1.1.1.1'))
        await expect(budget.admit(client('1.1.1.1'))).rejects.toMatchObject({
            scope: 'daily',
        })
        expect(captureMessageMock).toHaveBeenCalledTimes(2)
    })
})
