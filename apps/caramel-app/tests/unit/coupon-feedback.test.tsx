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

// #288: the web card's "Did it work?" control and its "Reported not working"
// hint. The failure reporter and toast are mocked (test doubles, named ...Mock);
// fetch is stubbed per test; localStorage is jsdom's real one.
const { reportMock } = vi.hoisted(() => ({
    reportMock: vi.fn(() => ({ sentryEventId: null, rateLimited: false })),
}))
vi.mock('@/lib/feedback/reportUserVisibleFailure', () => ({
    reportUserVisibleFailure: reportMock,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

const baseCoupon: Coupon = {
    id: '4242',
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

function stubFetch(response: unknown) {
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}

const okResponse = { ok: true, status: 200, json: async () => ({ ok: true }) }

async function copyCode() {
    vi.stubGlobal('navigator', {
        ...navigator,
        clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Get Coupon Code' }))
    await screen.findByText('Did it work?')
}

beforeEach(() => {
    window.localStorage.clear()
    reportMock.mockClear()
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

describe('CouponCard — "Did it work?" control', () => {
    it('is absent until the shopper copies the code (so never in the server HTML)', () => {
        render(<CouponCard coupon={baseCoupon} index={0} />)

        expect(screen.queryByText('Did it work?')).toBeNull()
        expect(screen.queryByRole('button', { name: /it worked/i })).toBeNull()
    })

    it('after the copy, shows labelled Yes / No buttons', async () => {
        render(<CouponCard coupon={baseCoupon} index={0} />)
        await copyCode()

        expect(
            screen.getByRole('button', { name: 'Yes, it worked' }),
        ).toBeTruthy()
        expect(
            screen.getByRole('button', { name: "No, it didn't" }),
        ).toBeTruthy()
        expect(screen.getByRole('group', { name: 'Did it work?' })).toBeTruthy()
    })

    it('Yes POSTs outcome worked to the report endpoint, thanks the shopper, and remembers the vote', async () => {
        const fetchMock = stubFetch(okResponse)
        render(<CouponCard coupon={baseCoupon} index={0} />)
        await copyCode()
        fireEvent.click(screen.getByRole('button', { name: 'Yes, it worked' }))

        expect(
            await screen.findByText(
                'Thanks! Your answer helps other shoppers.',
            ),
        ).toBeTruthy()
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('/api/coupons/4242/report')
        expect(init.method).toBe('POST')
        expect(JSON.parse(String(init.body))).toEqual({ outcome: 'worked' })
        expect(window.localStorage.getItem('caramel:coupon-vote:4242')).toBe(
            'worked',
        )
        // The question is replaced by the thanks.
        expect(
            screen.queryByRole('button', { name: 'Yes, it worked' }),
        ).toBeNull()
    })

    it('No POSTs outcome failed', async () => {
        const fetchMock = stubFetch(okResponse)
        render(<CouponCard coupon={baseCoupon} index={0} />)
        await copyCode()
        fireEvent.click(screen.getByRole('button', { name: "No, it didn't" }))

        await screen.findByText('Thanks! Your answer helps other shoppers.')
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(JSON.parse(String(init.body))).toEqual({ outcome: 'failed' })
        expect(window.localStorage.getItem('caramel:coupon-vote:4242')).toBe(
            'failed',
        )
    })

    it('the thanks is announced through a polite live region', async () => {
        stubFetch(okResponse)
        render(<CouponCard coupon={baseCoupon} index={0} />)
        await copyCode()
        fireEvent.click(screen.getByRole('button', { name: 'Yes, it worked' }))

        const thanks = await screen.findByText(
            'Thanks! Your answer helps other shoppers.',
        )
        expect(thanks.getAttribute('aria-live')).toBe('polite')
    })

    it('a browser that already voted sees the thanks, not the question, and sends nothing', async () => {
        window.localStorage.setItem('caramel:coupon-vote:4242', 'failed')
        const fetchMock = stubFetch(okResponse)
        render(<CouponCard coupon={baseCoupon} index={0} />)
        vi.stubGlobal('navigator', {
            ...navigator,
            clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Get Coupon Code' }))

        expect(
            await screen.findByText(
                'Thanks! Your answer helps other shoppers.',
            ),
        ).toBeTruthy()
        expect(
            screen.queryByRole('button', { name: 'Yes, it worked' }),
        ).toBeNull()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('a 429 is reported (not swallowed), shown, and leaves the card usable for a retry', async () => {
        stubFetch({ ok: false, status: 429, json: async () => ({}) })
        render(<CouponCard coupon={baseCoupon} index={0} />)
        await copyCode()
        fireEvent.click(screen.getByRole('button', { name: 'Yes, it worked' }))

        expect(
            await screen.findByText(
                'Too many answers just now. Try again in a minute.',
            ),
        ).toBeTruthy()
        await waitFor(() => expect(reportMock).toHaveBeenCalledTimes(1))
        const [arg] = reportMock.mock.calls[0] as unknown as [
            { operation: string; errorCode: string; error: Error },
        ]
        expect(arg.operation).toBe('coupon_vote_report')
        expect(arg.errorCode).toBe('429')
        expect(arg.error.message).toContain('429')
        // Not remembered: the shopper can try again.
        expect(
            window.localStorage.getItem('caramel:coupon-vote:4242'),
        ).toBeNull()
        expect(
            (
                screen.getByRole('button', {
                    name: 'Yes, it worked',
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(false)
        // The rest of the card is intact.
        expect(screen.getByText('Save 10%')).toBeTruthy()
    })

    it('a 404 (the code left the catalog since the page rendered) is a quiet "no longer listed" note: nothing reported, nothing remembered, no retry', async () => {
        stubFetch({
            ok: false,
            status: 404,
            json: async () => ({ error: 'Unknown coupon' }),
        })
        render(<CouponCard coupon={baseCoupon} index={0} />)
        await copyCode()
        fireEvent.click(screen.getByRole('button', { name: 'Yes, it worked' }))

        expect(
            await screen.findByText('That code is no longer listed.'),
        ).toBeTruthy()
        expect(reportMock).not.toHaveBeenCalled()
        expect(
            window.localStorage.getItem('caramel:coupon-vote:4242'),
        ).toBeNull()
        expect(
            screen.queryByRole('button', { name: 'Yes, it worked' }),
        ).toBeNull()
        expect(screen.queryByText("Couldn't send that. Try again.")).toBeNull()
    })

    it('a 500 shows the generic message and is reported', async () => {
        stubFetch({ ok: false, status: 500, json: async () => ({}) })
        render(<CouponCard coupon={baseCoupon} index={0} />)
        await copyCode()
        fireEvent.click(screen.getByRole('button', { name: "No, it didn't" }))

        expect(
            await screen.findByText("Couldn't send that. Try again."),
        ).toBeTruthy()
        expect(reportMock).toHaveBeenCalledTimes(1)
    })

    it('a network failure is reported and shown, never swallowed', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('net')))
        render(<CouponCard coupon={baseCoupon} index={0} />)
        await copyCode()
        fireEvent.click(screen.getByRole('button', { name: 'Yes, it worked' }))

        expect(
            await screen.findByText("Couldn't send that. Try again."),
        ).toBeTruthy()
        expect(reportMock).toHaveBeenCalledTimes(1)
        expect(
            window.localStorage.getItem('caramel:coupon-vote:4242'),
        ).toBeNull()
    })
})

describe('CouponCard — "Reported not working" hint', () => {
    it('shows with relative time for a recently failing code', () => {
        render(
            <CouponCard
                coupon={{
                    ...baseCoupon,
                    failWeight: 4,
                    lastFailedAt: iso(5 * HOUR),
                }}
                index={0}
            />,
        )

        expect(screen.getByText('Reported not working 5h ago')).toBeTruthy()
    })

    it('does not show for a sub-quorum (3 anonymous reporters), an old failure, or no signal', () => {
        for (const signal of [
            { failWeight: 3, lastFailedAt: iso(HOUR) },
            { failWeight: 9, lastFailedAt: iso(40 * DAY) },
            {},
        ]) {
            const { unmount } = render(
                <CouponCard coupon={{ ...baseCoupon, ...signal }} index={0} />,
            )
            expect(screen.queryByText(/reported not working/i)).toBeNull()
            unmount()
        }
    })

    it('replaces the "Worked Xh ago" line when the failure is newer than the success', () => {
        render(
            <CouponCard
                coupon={{
                    ...baseCoupon,
                    failWeight: 4,
                    lastFailedAt: iso(HOUR),
                    lastWorkedAt: iso(2 * DAY),
                }}
                index={0}
            />,
        )

        expect(screen.getByText('Reported not working 1h ago')).toBeTruthy()
        expect(screen.queryByText(/^worked|just worked/i)).toBeNull()
    })

    it('does not show (and the success line stays) when a success came after the failures', () => {
        render(
            <CouponCard
                coupon={{
                    ...baseCoupon,
                    failWeight: 4,
                    lastFailedAt: iso(2 * DAY),
                    lastWorkedAt: iso(2 * HOUR),
                }}
                index={0}
            />,
        )

        expect(screen.queryByText(/reported not working/i)).toBeNull()
        expect(screen.getByText('Worked 2h ago')).toBeTruthy()
    })

    it('does not upgrade an Unverified code to Verified off a success the later failures superseded', () => {
        render(
            <CouponCard
                coupon={{
                    ...baseCoupon,
                    status: 'pending',
                    failWeight: 4,
                    lastFailedAt: iso(10 * 60 * 1000),
                    lastWorkedAt: iso(20 * 60 * 1000),
                }}
                index={0}
            />,
        )

        expect(screen.getByText('Unverified')).toBeTruthy()
        expect(screen.queryByText('✓ Verified')).toBeNull()
    })

    it('words it as a report, with the provenance in the tooltip', () => {
        render(
            <CouponCard
                coupon={{
                    ...baseCoupon,
                    failWeight: 4,
                    lastFailedAt: iso(HOUR),
                }}
                index={0}
            />,
        )

        const hint = screen.getByText(/reported not working/i)
        expect(hint.getAttribute('title')).toMatch(/reports from shoppers/i)
    })
})
