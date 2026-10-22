// @vitest-environment jsdom
import CouponsSection from '@/components/coupons/coupons-section'
import FailingCodesDisclosure from '@/components/coupons/FailingCodesDisclosure'
import type { Coupon } from '@/types/coupon'
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
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
    vi.useRealTimers()
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

    it('moreToLoad shows "N+"; allFlagged shows the line (singular wording for one code)', () => {
        const { rerender } = render(
            <FailingCodesDisclosure
                coupons={[failingOne('1')]}
                startIndex={0}
                moreToLoad
            />,
        )
        expect(
            screen.getByRole('button', {
                name: '1+ codes reported not working',
            }),
        ).toBeTruthy()

        rerender(
            <FailingCodesDisclosure
                coupons={[failingOne('1')]}
                startIndex={0}
                allFlagged
            />,
        )
        expect(
            screen.getByText('The only code was reported not working'),
        ).toBeTruthy()
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

    it('while more pages remain, flagged codes loaded so far are STILL rendered (collapsed) and the count reads "N+"', () => {
        render(
            <CouponsSection
                defaultFilters={{ site: 'example.com' }}
                initialCoupons={[coupon('1'), failingOne('2')]}
                initialTotal={9}
                disableInitialFetch
            />,
        )

        const button = screen.getByRole('button', {
            name: '1+ codes reported not working',
        })
        const region = document.getElementById(
            button.getAttribute('aria-controls') ?? '',
        )!
        expect(region.hidden).toBe(true)
        expect(within(region).getByText('Title 2')).toBeTruthy()
        expect(screen.getByText('Title 1')).toBeTruthy()
    })

    it('the server HTML of a store list with more pages contains the flagged codes inside the hidden region', () => {
        const html = renderToString(
            <CouponsSection
                defaultFilters={{ site: 'example.com' }}
                initialCoupons={[coupon('1'), failingOne('2')]}
                initialTotal={9}
                disableInitialFetch
            />,
        )

        expect(html).toContain('Title 1')
        expect(html).toContain('Title 2')
        expect(html).toContain('1+ codes reported not working')
        // Title 2 sits after the disclosure's hidden region opens.
        const hiddenAt = html.search(/<div[^>]*\shidden=""/)
        expect(hiddenAt).toBeGreaterThan(-1)
        expect(html.indexOf('Title 2')).toBeGreaterThan(hiddenAt)
        expect(html.indexOf('Title 1')).toBeLessThan(hiddenAt)
    })

    it('a row returned on BOTH pages (signals moved between fetches) is rendered once, in one list, with unique keys', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        ;(fetch as ReturnType<typeof vi.fn>).mockImplementation(
            (input: string | URL) => {
                if (String(input).includes('/api/coupons/filters')) {
                    return Promise.resolve(filtersResponse)
                }
                return Promise.resolve({
                    ok: true,
                    json: async () => ({
                        // 2 was flagged on page 1 and 1 re-appears flagged too
                        coupons: [failingOne('2'), failingOne('1')],
                        page: 2,
                        total: 3,
                        hasMore: false,
                    }),
                })
            },
        )
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

        // Coupon 1 is first seen healthy (page 1) then flagged (page 2): the
        // first occurrence wins, so it stays in the main list and is not
        // duplicated into the disclosure.
        await screen.findByRole('button', {
            name: '1 code reported not working',
        })
        expect(screen.getAllByText('Title 1')).toHaveLength(1)
        expect(screen.getAllByText('Title 2')).toHaveLength(1)
        expect(
            errorSpy.mock.calls.some(call =>
                String(call[0]).includes('unique "key"'),
            ),
        ).toBe(false)
        errorSpy.mockRestore()
    })

    it('when EVERY code is flagged (last page in) a line says so above the disclosure', () => {
        render(
            <CouponsSection
                defaultFilters={{ site: 'example.com' }}
                initialCoupons={[failingOne('1'), failingOne('2')]}
                initialTotal={2}
                disableInitialFetch
            />,
        )

        expect(
            screen.getByText('All 2 codes were reported not working'),
        ).toBeTruthy()
        expect(
            screen.getByRole('button', {
                name: '2 codes reported not working',
            }),
        ).toBeTruthy()
        expect(screen.queryByText('No coupons found')).toBeNull()
    })

    it('the all-flagged line is absent when healthy codes exist, and absent while more pages remain', () => {
        const { rerender } = render(
            <CouponsSection
                defaultFilters={{ site: 'example.com' }}
                initialCoupons={[coupon('1'), failingOne('2')]}
                initialTotal={2}
                disableInitialFetch
            />,
        )
        expect(screen.queryByText(/were reported not working/)).toBeNull()
        rerender(<div />)
        cleanup()

        render(
            <CouponsSection
                defaultFilters={{ site: 'example.com' }}
                initialCoupons={[failingOne('1')]}
                initialTotal={5}
                disableInitialFetch
            />,
        )
        expect(screen.queryByText(/were reported not working/)).toBeNull()
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
        // load-more's finally block parks setIsLoadingMore(false) behind a
        // MIN_LOADING_DELAY_MS setTimeout. Under real timers it can outlive the
        // test and fire after jsdom is torn down (T-6309), so fake timers own
        // it and the test drains it before ending.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

        render(
            <CouponsSection
                defaultFilters={{ site: 'example.com' }}
                initialCoupons={[coupon('1'), failingOne('2')]}
                initialTotal={3}
                pageSize={2}
                disableInitialFetch
            />,
        )

        // Flush the fetch promises, then run the min-loading-delay timer.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000)
        })

        const button = screen.getByRole('button', {
            name: '2 codes reported not working',
        })
        expect(button.getAttribute('aria-expanded')).toBe('false')
        const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([u]) =>
            String(u),
        )
        expect(urls.some(u => u.includes('page=2'))).toBe(true)
        // Guard: no timer may outlive the test.
        expect(vi.getTimerCount()).toBe(0)
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
