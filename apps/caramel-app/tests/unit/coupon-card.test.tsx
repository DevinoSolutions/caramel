// @vitest-environment jsdom
import CouponCard from '@/components/coupons/coupon-card'
import type { Coupon } from '@/types/coupon'
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastMock = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMock }))

// W1 — the web card surfaces the app-owned "worked Xh ago" trust line only
// when a recent lastWorkedAt is present. These pins prove it renders for a
// fresh signal and stays absent when there's none or it's stale — and since
// the signal table starts empty (W2 wires the reporting), "absent" is the
// common path this must get right. Mirrors coupons-section.test.tsx's jsdom +
// RTL shape; framer-motion renders plain elements under jsdom (unmocked, same
// as that suite).
const baseCoupon: Coupon = {
    id: '1',
    code: 'SAVE10',
    site: 'example.com',
    title: 'Save 10%',
    description: '10% off',
    rating: 4,
    discount_type: 'PERCENTAGE',
    discount_amount: 10,
    expiry: null,
    expired: false,
    timesUsed: 0,
}

afterEach(cleanup)

describe('CouponCard — worked-ago trust line (W1)', () => {
    it('shows "Worked Xh ago" when lastWorkedAt is recent', () => {
        const twoHoursAgo = new Date(
            Date.now() - 2 * 60 * 60 * 1000,
        ).toISOString()

        render(
            <CouponCard
                coupon={{ ...baseCoupon, lastWorkedAt: twoHoursAgo }}
                index={0}
            />,
        )

        expect(screen.getByText('Worked 2h ago')).toBeTruthy()
    })

    it('renders no worked-ago line when lastWorkedAt is absent (the normal W1 state)', () => {
        render(<CouponCard coupon={baseCoupon} index={0} />)

        expect(screen.queryByText(/worked/i)).toBeNull()
    })

    it('renders no worked-ago line when lastWorkedAt is older than 7 days', () => {
        const eightDaysAgo = new Date(
            Date.now() - 8 * 24 * 60 * 60 * 1000,
        ).toISOString()

        render(
            <CouponCard
                coupon={{ ...baseCoupon, lastWorkedAt: eightDaysAgo }}
                index={0}
            />,
        )

        expect(screen.queryByText(/worked/i)).toBeNull()
    })
})

describe('CouponCard — discount badge claim integrity', () => {
    it('shows the real discount when the catalog has one', () => {
        render(<CouponCard coupon={baseCoupon} index={0} />)

        expect(screen.getByText('10%')).toBeTruthy()
        expect(screen.getByText('off')).toBeTruthy()
    })

    it('falls back to a number-free DEAL badge when no discount amount exists (never a fabricated "20%")', () => {
        render(
            <CouponCard
                coupon={{ ...baseCoupon, discount_amount: null }}
                index={0}
            />,
        )

        expect(screen.getByText('DEAL')).toBeTruthy()
        expect(screen.queryByText('20%')).toBeNull()
        expect(screen.queryByText('off')).toBeNull()
    })
})

describe('CouponCard — "Just worked" is Verified, never beside "Unverified"', () => {
    const pending: Coupon = { ...baseCoupon, status: 'pending' }

    it('an Unverified code applied successfully minutes ago says "Just worked" and wears the Verified check badge', () => {
        const tenMinutesAgo = new Date(
            Date.now() - 10 * 60 * 1000,
        ).toISOString()

        render(
            <CouponCard
                coupon={{ ...pending, lastWorkedAt: tenMinutesAgo }}
                index={0}
            />,
        )

        expect(screen.getByText('Just worked')).toBeTruthy()
        expect(screen.queryByText(/worked 0h ago/i)).toBeNull()
        const badge = screen.getByText('✓ Verified')
        expect(badge.getAttribute('data-tier')).toBe('green')
        expect(badge.getAttribute('title')).toMatch(/last 24 hours/)
        expect(screen.queryByText('Unverified')).toBeNull()
    })

    it('the same code with no recent apply stays Unverified', () => {
        render(<CouponCard coupon={pending} index={0} />)

        expect(screen.getByText('Unverified')).toBeTruthy()
        expect(screen.queryByText('✓ Verified')).toBeNull()
    })

    it('an apply older than 24h keeps the trust line but not the Verified upgrade', () => {
        const twoDaysAgo = new Date(
            Date.now() - 2 * 24 * 60 * 60 * 1000,
        ).toISOString()

        render(
            <CouponCard
                coupon={{ ...pending, lastWorkedAt: twoDaysAgo }}
                index={0}
            />,
        )

        expect(screen.getByText('Worked 2d ago')).toBeTruthy()
        expect(screen.getByText('Unverified')).toBeTruthy()
    })
})

describe('CouponCard: keeps-failing codes lose the green Verified badge', () => {
    const verified = { ...baseCoupon, status: 'valid' as const }
    const hoursAgo = (h: number) =>
        new Date(Date.now() - h * 60 * 60 * 1000).toISOString()

    it('a verified code shows the Verified badge', () => {
        render(<CouponCard coupon={verified} index={0} />)
        expect(screen.getByText(/Verified/)).toBeTruthy()
    })

    it('the same code flagged keepsFailing shows the "Reported not working" hint and NO Verified badge', () => {
        render(
            <CouponCard
                coupon={{
                    ...verified,
                    keepsFailing: true,
                    failCount: 4,
                    lastFailedAt: hoursAgo(2),
                }}
                index={0}
            />,
        )
        expect(screen.getByText(/Reported not working 2h ago/)).toBeTruthy()
        expect(screen.queryByText(/Verified/)).toBeNull()
    })

    it('a merely-failing code (not keepsFailing) keeps its badge: only the collapse tier drops it', () => {
        render(
            <CouponCard
                coupon={{
                    ...verified,
                    keepsFailing: false,
                    failCount: 2,
                    lastFailedAt: hoursAgo(2),
                }}
                index={0}
            />,
        )
        expect(screen.getByText(/Verified/)).toBeTruthy()
    })
})

// Owner decision 2026-10-19 (T-2956): a code that only works for a new account
// (the kept referral codes) says so on the card, instead of being hidden.
describe('CouponCard — "New customers only" label', () => {
    it('shows the label when the coupon is flagged newCustomersOnly', () => {
        render(
            <CouponCard
                coupon={{ ...baseCoupon, newCustomersOnly: true }}
                index={0}
            />,
        )

        expect(screen.getByText('New customers only')).toBeTruthy()
    })

    it('shows no label when the flag is false or absent', () => {
        render(
            <CouponCard
                coupon={{ ...baseCoupon, newCustomersOnly: false }}
                index={0}
            />,
        )
        render(<CouponCard coupon={baseCoupon} index={1} />)

        expect(screen.queryByText('New customers only')).toBeNull()
    })
})

// T-6893: the browser can refuse the clipboard write (document not focused,
// in-app browsers, Permissions-Policy: Sentry CARAMEL-2F). The click used to
// reject unhandled and do nothing at all; the code must still be shown.
describe('CouponCard: "Get Coupon Code" when the clipboard is refused', () => {
    const setClipboard = (writeText: () => Promise<void>) =>
        Object.defineProperty(window.navigator, 'clipboard', {
            value: { writeText: vi.fn(writeText) },
            configurable: true,
        })

    beforeEach(() => {
        toastMock.success.mockReset()
        toastMock.info.mockReset()
    })

    it('a refused write still shows the code, asks to copy it by hand, and keeps the "Did it work?" vote', async () => {
        setClipboard(() =>
            Promise.reject(
                new DOMException('Document is not focused.', 'NotAllowedError'),
            ),
        )
        render(<CouponCard coupon={baseCoupon} index={0} />)

        fireEvent.click(screen.getByRole('button', { name: 'Get Coupon Code' }))

        await waitFor(() => expect(screen.getByText('SAVE10')).toBeTruthy())
        expect(screen.getByText('Select the code above to copy it')).toBeTruthy()
        expect(screen.queryByText('Code copied to clipboard!')).toBeNull()
        expect(screen.getByText('Did it work?')).toBeTruthy()
        expect(toastMock.info).toHaveBeenCalledWith(
            'Copy the code shown on the card',
        )
        expect(toastMock.success).not.toHaveBeenCalled()
    })

    it('a successful write still says the code was copied', async () => {
        setClipboard(() => Promise.resolve())
        render(<CouponCard coupon={baseCoupon} index={0} />)

        fireEvent.click(screen.getByRole('button', { name: 'Get Coupon Code' }))

        await waitFor(() =>
            expect(screen.getByText('Code copied to clipboard!')).toBeTruthy(),
        )
        expect(toastMock.success).toHaveBeenCalledWith('Coupon code copied!')
        expect(toastMock.info).not.toHaveBeenCalled()
        expect(screen.getByText('Did it work?')).toBeTruthy()
    })
})
