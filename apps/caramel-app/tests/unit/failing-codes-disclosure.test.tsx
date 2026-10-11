// @vitest-environment jsdom
import CouponsSection from '@/components/coupons/coupons-section'
import FailingCodesDisclosure from '@/components/coupons/FailingCodesDisclosure'
import type { Coupon } from '@/types/coupon'
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #288 — codes that keep failing (coupons.ts keepsFailing, flagged server-side)
// are collapsed behind a "N codes reported not working" disclosure at the end of
// a STORE's list. Pinned here: the disclosure's accessibility contract, that the
// collapsed codes stay in the server HTML (collapsed, not removed), and how
// CouponsSection partitions across pages (the count is exact only once the last
// page is in; the site-less browse list is left alone).

vi.mock('@/components/coupons/coupon-filters', () => ({
    default: () => <div data-testid="filters-stub" />,
}))
vi.mock('next/image', () => ({
    default: (props: { alt?: string }) => <img alt={props.alt ?? ''} />,
}))

function coupon(id: string, extra: Partial<Coupon> = {}): Coupon {
    return {
        id,
        code: `CODE${id}`,
        site: 'example.com',
        title: `Title ${id}`,
        description: 'desc',
        rating: 4,
        discount_type: 'PERCENTAGE',
        discount_amount: 10,
        expiry: null,
        expired: false,
        timesUsed: 0,
        keepsFailing: false,
        ...extra,
    }
}

const failingOne = (id: string) =>
    coupon(id, {
        keepsFailing: true,
        failCount: 4,
        lastFailedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    })

const filtersResponse = {
    ok: true,
    json: async () => ({ sites: [], discountTypes: [] }),
}

beforeEach(() => {
    class MockIntersectionObserver {
        observe() {}
        disconnect() {}
        unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(filtersResponse)),
    )
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

describe('FailingCodesDisclosure', () => {
    it('renders nothing when there are no collapsed codes', () => {
        const { container } = render(
            <FailingCodesDisclosure coupons={[]} startIndex={0} />,
        )
        expect(container.innerHTML).toBe('')
    })

    it('is a collapsed button (aria-expanded=false) with the exact count, plural and singular', () => {
        const { rerender } = render(
            <FailingCodesDisclosure
                coupons={[failingOne('1'), failingOne('2')]}
                startIndex={0}
            />,
        )
        const button = screen.getByRole('button', {
            name: '2 codes reported not working',
        })
        expect(button.getAttribute('aria-expanded')).toBe('false')

        rerender(
            <FailingCodesDisclosure
                coupons={[failingOne('1')]}
                startIndex={0}
            />,
        )
        expect(
            screen.getByRole('button', {
                name: '1 code reported not working',
            }),
        ).toBeTruthy()
    })

    it('toggles: the controlled region is hidden until opened, then the codes are reachable and keep the "Reported not working" hint', () => {
        render(
            <FailingCodesDisclosure
                coupons={[failingOne('1'), failingOne('2')]}
                startIndex={0}
            />,
        )
        const button = screen.getByRole('button', {
            name: /reported not working/,
        })
        const region = document.getElementById(
            button.getAttribute('aria-controls') ?? '',
        )!
        expect(region.hidden).toBe(true)

        fireEvent.click(button)

        expect(button.getAttribute('aria-expanded')).toBe('true')
        expect(region.hidden).toBe(false)
        expect(within(region).getAllByTestId('coupon-card')).toHaveLength(2)
        expect(
            within(region).getAllByText(/Reported not working 2h ago/),
        ).toHaveLength(2)
        expect(
            within(region).getAllByRole('button', { name: 'Get Coupon Code' }),
        ).toHaveLength(2)

        fireEvent.click(button)
        expect(button.getAttribute('aria-expanded')).toBe('false')
        expect(region.hidden).toBe(true)
    })

    it('keeps the collapsed codes in the server HTML (collapsed, never removed)', () => {
        const html = renderToString(
            <FailingCodesDisclosure
                coupons={[failingOne('1')]}
                startIndex={0}
            />,
        )
        expect(html).toContain('Title 1')
        expect(html).toContain('1 code reported not working')
        expect(html).toMatch(/aria-expanded="false"/)
        expect(html).toMatch(/<div[^>]*\shidden=""/)
    })
})

describe('CouponsSection groups keeps-failing codes at the end of a store list', () => {
    it('store list, last page in: good codes in the main list, flagged ones inside the disclosure with an exact count', () => {
        render(
            <CouponsSection
                defaultFilters={{ site: 'example.com' }}
                initialCoupons={[
                    coupon('1'),
                    coupon('2'),
                    failingOne('3'),
                    failingOne('4'),
                ]}
                initialTotal={4}
                disableInitialFetch
            />,
        )

        const button = screen.getByRole('button', {
            name: '2 codes reported not working',
        })
        const region = document.getElementById(
            button.getAttribute('aria-controls') ?? '',
        )!
        expect(within(region).getByText('Title 3')).toBeTruthy()
        expect(within(region).getByText('Title 4')).toBeTruthy()

        const outside = screen
            .getAllByTestId('coupon-card')
            .filter(card => !region.contains(card))
        expect(outside.map(card => card.textContent)).toEqual([
            expect.stringContaining('Title 1'),
            expect.stringContaining('Title 2'),
        ])
    })

    it('while more pages remain, flagged codes loaded so far are held back and no partial count is shown', () => {
        render(
            <CouponsSection
                defaultFilters={{ site: 'example.com' }}
                initialCoupons={[coupon('1'), failingOne('2')]}
                initialTotal={9}
                disableInitialFetch
            />,
        )

        expect(screen.queryByTestId('failing-codes')).toBeNull()
        expect(screen.getByText('Title 1')).toBeTruthy()
        expect(screen.queryByText('Title 2')).toBeNull()
    })

    it('load-more still works: the final page brings the disclosure, counting the flagged codes from every page', async () => {
        ;(fetch as ReturnType<typeof vi.fn>).mockImplementation(
            (input: string | URL) => {
                if (String(input).includes('/api/coupons/filters')) {
                    return Promise.resolve(filtersResponse)
                }
                return Promise.resolve({
                    ok: true,
                    json: async () => ({
                        coupons: [failingOne('3')],
                        page: 2,
                        total: 3,
                        hasMore: false,
                    }),
                })
            },
        )
        // Reach loadMore through the component's IntersectionObserver fallback.
        class FiringObserver {
            constructor(
                private cb: (entries: { isIntersecting: boolean }[]) => void,
            ) {}
            observe() {
                this.cb([{ isIntersecting: true }])
            }
            disconnect() {}
            unobserve() {}
        }
        vi.stubGlobal('IntersectionObserver', FiringObserver)

        render(
            <CouponsSection
                defaultFilters={{ site: 'example.com' }}
                initialCoupons={[coupon('1'), failingOne('2')]}
                initialTotal={3}
                pageSize={2}
                disableInitialFetch
            />,
        )

        const button = await screen.findByRole('button', {
            name: '2 codes reported not working',
        })
        expect(button.getAttribute('aria-expanded')).toBe('false')
        await waitFor(() => {
            const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(
                ([u]) => String(u),
            )
            expect(urls.some(u => u.includes('page=2'))).toBe(true)
        })
    })

    it('a site-less browse list leaves flagged codes in place (no grouping, no disclosure)', () => {
        render(
            <CouponsSection
                initialCoupons={[failingOne('1'), coupon('2')]}
                initialTotal={2}
                disableInitialFetch
            />,
        )

        expect(screen.queryByTestId('failing-codes')).toBeNull()
        expect(screen.getByText('Title 1')).toBeTruthy()
        expect(screen.getByText('Title 2')).toBeTruthy()
    })
})
