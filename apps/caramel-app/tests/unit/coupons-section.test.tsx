// @vitest-environment jsdom
import CouponsSection from '@/components/coupons/coupons-section'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// NF-06 — the store filter was permanently empty: `setStoreOptions` was never
// called while its sibling `setDiscountOptions` WAS wired from the same
// /api/coupons/filters fetch (which also opted out of sites via
// includeSites=false). These pins prove BOTH option lists now populate from
// that fetch response and reach the filter UI. CouponFilters is stubbed to
// surface the props it receives, isolating the fetch -> state -> prop wiring
// this fix restores from react-select internals. (Red before the fix — the
// store-options prop stayed empty.)
const { filtersProps } = vi.hoisted(() => ({
    filtersProps: {
        storeOptions: [] as string[],
        discountOptions: [] as string[],
    },
}))

vi.mock('@/components/coupons/coupon-filters', () => ({
    default: (props: {
        storeOptions?: string[]
        discountOptions?: string[]
    }) => {
        filtersProps.storeOptions = props.storeOptions ?? []
        filtersProps.discountOptions = props.discountOptions ?? []
        return (
            <div data-testid="filters-stub">
                <span data-testid="store-options">
                    {(props.storeOptions ?? []).join(',')}
                </span>
                <span data-testid="discount-options">
                    {(props.discountOptions ?? []).join(',')}
                </span>
            </div>
        )
    },
}))

vi.mock('next/image', () => ({
    default: (props: { alt?: string }) => <img alt={props.alt ?? ''} />,
}))

beforeEach(() => {
    filtersProps.storeOptions = []
    filtersProps.discountOptions = []
    class MockIntersectionObserver {
        observe() {}
        disconnect() {}
        unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL) => {
            const url = String(input)
            if (url.includes('/api/coupons/filters')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({
                        sites: ['a.com', 'b.com'],
                        discountTypes: ['PERCENTAGE', 'CASH'],
                    }),
                })
            }
            // /api/coupons — empty listing keeps the InfiniteScroll path out.
            return Promise.resolve({
                ok: true,
                json: async () => ({ coupons: [], total: 0, hasMore: false }),
            })
        }),
    )
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

describe('CouponsSection filter metadata (NF-06)', () => {
    it('populates store AND discount options from the /api/coupons/filters response', async () => {
        render(<CouponsSection />)
        await waitFor(() =>
            expect(screen.getByTestId('store-options').textContent).toBe(
                'a.com,b.com',
            ),
        )
        expect(screen.getByTestId('discount-options').textContent).toBe(
            'PERCENTAGE,CASH',
        )
    })

    it('requests the filters endpoint with sites included (includeSites=true)', async () => {
        render(<CouponsSection />)
        await waitFor(() => {
            const requestedSites = (
                fetch as ReturnType<typeof vi.fn>
            ).mock.calls.some(
                ([u]) =>
                    String(u).includes('/api/coupons/filters') &&
                    String(u).includes('includeSites=true'),
            )
            expect(requestedSites).toBe(true)
        })
    })
})

describe('CouponsSection SSR hydration (server-rendered coupon pages)', () => {
    const ssrCoupon = {
        id: '7',
        code: 'SSR10',
        site: 'example.com',
        title: 'SSR-rendered coupon',
        description: '10% off',
        rating: 4,
        discount_type: 'PERCENTAGE',
        discount_amount: 10,
        expiry: null,
        expired: false,
        timesUsed: 0,
        lastWorkedAt: null,
    }

    it('keeps server-provided coupons on mount and never refetches /api/coupons (the old filter effect wiped SSR content with a duplicate fetch)', async () => {
        render(
            <CouponsSection
                initialCoupons={[ssrCoupon]}
                initialTotal={1}
                disableInitialFetch
            />,
        )

        // The SSR rows must stay rendered…
        expect(screen.getByText('SSR-rendered coupon')).toBeTruthy()

        // …and once the (legitimate) filters-metadata fetch has happened, no
        // /api/coupons listing call may have been made at any point.
        await waitFor(() => {
            const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
                ([u]) => String(u),
            )
            expect(calls.some(u => u.includes('/api/coupons/filters'))).toBe(
                true,
            )
        })
        const listingCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls
            .map(([u]) => String(u))
            .filter(
                u =>
                    u.includes('/api/coupons') &&
                    !u.includes('/api/coupons/filters'),
            )
        expect(listingCalls).toEqual([])
        expect(screen.getByText('SSR-rendered coupon')).toBeTruthy()
    })
})
