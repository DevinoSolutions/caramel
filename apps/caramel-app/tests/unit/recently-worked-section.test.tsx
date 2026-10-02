// @vitest-environment jsdom
import RecentlyWorkedCouponsStrip, {
    RecentlyWorkedCouponsList,
} from '@/components/RecentlyWorkedCouponsStrip'
import RecentlyWorkedSection from '@/components/RecentlyWorkedSection'
import type { RecentlyWorkedCoupon } from '@/lib/recentlyWorkedCoupons'
import { storeLogoUrl } from '@/lib/storeLogo'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { PHASE_PRODUCTION_BUILD } from 'next/constants'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The landing page's "Codes that just worked" strip: the newest worked codes
// however old (since 2026-10-02), each dated, Verified only inside the proof
// window. The EMPTY case still matters: a heading over an empty box would be a
// claim the page cannot back, so no usable rows must render NOTHING, heading
// included.

const { sentryMock } = vi.hoisted(() => ({
    sentryMock: { captureException: vi.fn() },
}))
vi.mock('@sentry/nextjs', () => sentryMock)

// The server section's one data dependency: the uncached catalog read.
// (Its SQL is pinned in couponsRepo.test.ts and run for real in
// tests/integration/recently-worked.itest.ts.)
const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }))
vi.mock('@/lib/recentlyWorkedCouponsCache', () => ({
    readRecentlyWorkedCoupons: readMock,
}))

afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    sentryMock.captureException.mockReset()
    readMock.mockReset()
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

    it('keeps codes older than the proof window: dated, but with no Verified badge', () => {
        render(
            <RecentlyWorkedCouponsList
                coupons={[
                    coupon({
                        id: '1',
                        lastWorkedAt: new Date(NOW - 25 * HOUR).toISOString(),
                    }),
                    coupon({
                        id: '2',
                        code: 'OLD10',
                        storeDomain: 'gap.com',
                        lastWorkedAt: '2026-09-12T08:00:00.000Z',
                    }),
                ]}
                now={NOW}
            />,
        )
        expect(screen.getAllByRole('link')).toHaveLength(2)
        expect(screen.getByText('Worked 1d ago')).toBeDefined()
        expect(screen.getByText('Worked Sep 12')).toBeDefined()
        expect(screen.queryByText('✓ Verified')).toBeNull()
    })

    it('shows each store logo beside its domain', () => {
        const { container } = render(
            <RecentlyWorkedCouponsList coupons={[coupon()]} now={NOW} />,
        )
        const logo = container.querySelector('img')
        expect(logo?.getAttribute('src')).toContain(
            encodeURIComponent(storeLogoUrl('codecademy.com')),
        )
        // Decorative: the domain text beside it already names the store.
        expect(logo?.getAttribute('alt')).toBe('')
    })

    it('drops a row with an unusable timestamp, and renders nothing when none is left', () => {
        const { container } = render(
            <RecentlyWorkedCouponsList
                coupons={[
                    coupon({ lastWorkedAt: 'not-a-date' }),
                    coupon({
                        id: '2',
                        lastWorkedAt: new Date(NOW + 2 * HOUR).toISOString(),
                    }),
                ]}
                now={NOW}
            />,
        )
        expect(container.innerHTML).toBe('')
    })
})

describe('RecentlyWorkedCouponsStrip (client clock)', () => {
    it('hydrates with the render time, then re-judges against the visitor clock: a code that left the proof window keeps its tile but loses Verified', async () => {
        // Rendered 23h after the apply; the visitor arrives 2h later.
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(NOW + 2 * HOUR)

        render(
            <RecentlyWorkedCouponsStrip
                coupons={[
                    coupon({
                        lastWorkedAt: new Date(NOW - 23 * HOUR).toISOString(),
                    }),
                ]}
                renderedAt={NOW}
            />,
        )

        await waitFor(() =>
            expect(screen.getByText('Worked 1d ago')).toBeDefined(),
        )
        expect(screen.queryByText('✓ Verified')).toBeNull()
        expect(screen.getByRole('link')).toBeDefined()
    })

    it('relabels "Worked Xh ago" with the visitor clock', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(NOW + 3 * HOUR)

        render(
            <RecentlyWorkedCouponsStrip
                coupons={[
                    coupon({ lastWorkedAt: new Date(NOW).toISOString() }),
                ]}
                renderedAt={NOW}
            />,
        )

        await waitFor(() =>
            expect(screen.getByText('Worked 3h ago')).toBeDefined(),
        )
    })
})

describe('RecentlyWorkedSection (server)', () => {
    it('renders the catalog read into the HTML: tiles and their store links', async () => {
        readMock.mockResolvedValue([
            coupon({ lastWorkedAt: new Date().toISOString() }),
        ])

        render(await RecentlyWorkedSection())

        expect(
            screen.getByRole('heading', { name: 'Codes that just worked' }),
        ).toBeDefined()
        expect(screen.getByRole('link').getAttribute('href')).toBe(
            '/coupons/codecademy.com',
        )
        expect(readMock).toHaveBeenCalledTimes(1)
    })

    it('renders nothing and reads nothing during `next build` (the image builds against an unreachable placeholder DB)', async () => {
        vi.stubEnv('NEXT_PHASE', PHASE_PRODUCTION_BUILD)

        expect(await RecentlyWorkedSection()).toBeNull()
        expect(readMock).not.toHaveBeenCalled()
    })

    it('a failed read leaves the section out AND reports to Sentry (not swallowed)', async () => {
        const failure = new Error('db down')
        readMock.mockRejectedValue(failure)

        expect(await RecentlyWorkedSection()).toBeNull()
        expect(sentryMock.captureException).toHaveBeenCalledWith(failure, {
            tags: { area: 'landing.recently-worked' },
        })
    })
})
