import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { CouponCard } from '../entrypoints/popup/components/CouponCard'

// Owner decision 2026-10-19 (T-2956): a code that works only for a new account
// carries a "New customers only" label in the popup, from the coupons API's
// `newCustomersOnly` (the same field the website card reads).

beforeAll(() => {
    initCouponConstants()
})

afterEach(cleanup)

const coupon = { code: 'PTSCS7AI', title: 'Kikoff referral', status: 'pending' }

describe('popup CouponCard — "New customers only" label', () => {
    it('shows the label when the API flags the coupon', () => {
        render(
            <CouponCard
                coupon={{ ...coupon, newCustomersOnly: true }}
                onCopy={() => {}}
            />,
        )
        expect(screen.getByText('New customers only')).toBeTruthy()
    })

    it('shows no label when the flag is false or absent (an older server)', () => {
        render(
            <CouponCard
                coupon={{ ...coupon, newCustomersOnly: false }}
                onCopy={() => {}}
            />,
        )
        render(<CouponCard coupon={coupon} onCopy={() => {}} />)
        expect(screen.queryByText('New customers only')).toBeNull()
    })
})
