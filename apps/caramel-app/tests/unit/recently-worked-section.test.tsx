// @vitest-environment jsdom
import RecentlyWorkedSection, {
    RecentlyWorkedCouponsList,
} from '@/components/RecentlyWorkedSection'
import type { RecentlyWorkedCoupon } from '@/lib/recentlyWorkedCoupons'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The landing page's "Codes that just worked" strip. The case that matters
// most is the EMPTY one: a "Codes that just worked" heading over an empty box
// would be a freshness claim the page cannot back — so no rows (or only rows
// that aged out of the 24h window) must render NOTHING, heading included.

const { sentryMock } = vi.hoisted(() => ({
    sentryMock: { captureException: vi.fn() },
}))
vi.mock('@sentry/nextjs', () => sentryMock)

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    sentryMock.captureException.mockReset()
})

const NOW = Date.parse('2026-09-30T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

const coupon = (
    over: Partial<RecentlyWorkedCoupon> = {},
): RecentlyWorkedCoupon => ({
    id: '1',
    code: 'LEARN40',
    title: '40% off Pro annual',
    storeDomain: 'codecademy.com',
    discountType: 'PERCENTAGE',
    discountAmount: 40,
    lastWorkedAt: new Date(NOW - 10 * MINUTE).toISOString(),
    ...over,
})

describe('RecentlyWorkedCouponsList', () => {
    it('renders one tile per code: store link, discount, code, "Just worked", and the Verified check badge', () => {
        render(
            <RecentlyWorkedCouponsList
                coupons={[
                    coupon(),
                    coupon({
                        id: '2',
                        code: 'GAP5',
                        title: '$5 off',
                        storeDomain: 'gap.com',
                        discountType: 'CASH',
                        discountAmount: 5,
                        lastWorkedAt: new Date(NOW - 3 * HOUR).toISOString(),
                    }),
                ]}
                now={NOW}
            />,
        )

        expect(
            screen.getByRole('heading', { name: 'Codes that just worked' }),
        ).toBeDefined()
        const links = screen.getAllByRole('link')
        expect(links.map(a => a.getAttribute('href'))).toEqual([
            '/coupons/codecademy.com',
            '/coupons/gap.com',
        ])
        expect(screen.getByText('40% off')).toBeDefined()
        expect(screen.getByText('$5 off', { selector: 'span' })).toBeDefined()
        expect(screen.getByText('LEARN40')).toBeDefined()
        expect(screen.getByText('Just worked')).toBeDefined()
        expect(screen.getByText('Worked 3h ago')).toBeDefined()
        const badges = screen.getAllByText('✓ Verified')
        expect(badges).toHaveLength(2)
        for (const badge of badges) {
            expect(badge.getAttribute('data-tier')).toBe('green')
        }
        expect(screen.queryByText('Unverified')).toBeNull()
    })

    it('a code with no discount amount says DEAL, never an invented number', () => {
        render(
            <RecentlyWorkedCouponsList
                coupons={[coupon({ discountType: null, discountAmount: null })]}
                now={NOW}
            />,
        )
        expect(screen.getByText('DEAL')).toBeDefined()
    })

    it('renders NOTHING when there are no codes, heading included', () => {
        const { container } = render(
            <RecentlyWorkedCouponsList coupons={[]} now={NOW} />,
        )
        expect(container.innerHTML).toBe('')
    })

    it('re-applies the 24h window: rows that aged out (edge-cached response) are dropped, and all-stale renders nothing', () => {
        const { container } = render(
            <RecentlyWorkedCouponsList
                coupons={[
                    coupon({
                        lastWorkedAt: new Date(NOW - 25 * HOUR).toISOString(),
                    }),
                ]}
                now={NOW}
            />,
        )
        expect(container.innerHTML).toBe('')
    })
})

describe('RecentlyWorkedSection (fetching wrapper)', () => {
    it('fetches the cached API once and renders what it returns', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
            Response.json({
                coupons: [coupon({ lastWorkedAt: new Date().toISOString() })],
            }),
        )
        vi.stubGlobal('fetch', fetchMock)

        render(<RecentlyWorkedSection />)

        await waitFor(() =>
            expect(screen.getByText('Just worked')).toBeDefined(),
        )
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0]![0]).toBe('/api/coupons/recently-worked')
    })

    it('an empty response renders nothing', async () => {
        const fetchMock = vi.fn(async () => Response.json({ coupons: [] }))
        vi.stubGlobal('fetch', fetchMock)

        const { container } = render(<RecentlyWorkedSection />)

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        expect(container.innerHTML).toBe('')
    })

    it('a failed request keeps the section absent AND reports to Sentry (not swallowed)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('nope', { status: 500 })),
        )

        const { container } = render(<RecentlyWorkedSection />)

        await waitFor(() =>
            expect(sentryMock.captureException).toHaveBeenCalledTimes(1),
        )
        expect(container.innerHTML).toBe('')
    })

    it('a response that breaks the contract is reported, not rendered', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json({ coupons: [{ id: 1 }] })),
        )

        const { container } = render(<RecentlyWorkedSection />)

        await waitFor(() =>
            expect(sentryMock.captureException).toHaveBeenCalledTimes(1),
        )
        expect(container.innerHTML).toBe('')
    })
})
