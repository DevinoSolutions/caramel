// @vitest-environment jsdom
import AddCodeForm from '@/components/coupons/AddCodeForm'
import { SHOPPER_DAILY_SUBMISSION_CAP } from '@/lib/shopperCoupons'
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The "Add a code" form on /coupons/[store]. The session hook and
// the failure reporter are mocked; fetch is stubbed per test with the exact
// status/body shapes POST /api/coupons/submit answers with.
const { sessionState, reportMock } = vi.hoisted(() => ({
    sessionState: {
        current: { data: null as unknown, isPending: false },
    },
    reportMock: vi.fn(() => ({ sentryEventId: null, rateLimited: false })),
}))
vi.mock('@/lib/auth/client', () => ({
    useSession: () => sessionState.current,
}))
vi.mock('@/lib/feedback/reportUserVisibleFailure', () => ({
    reportUserVisibleFailure: reportMock,
}))

const SIGNED_IN = { data: { user: { id: 'u1' } }, isPending: false }

function jsonResponse(status: number, body: unknown) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    }
}

function stubFetch(response: unknown) {
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}

async function submit(code: string) {
    fireEvent.change(await screen.findByLabelText('Coupon code'), {
        target: { value: code },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add code' }))
}

beforeEach(() => {
    sessionState.current = SIGNED_IN
    reportMock.mockClear()
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

describe('AddCodeForm — signed out', () => {
    it('shows the sign-in prompt linking to /login, and no form', async () => {
        sessionState.current = { data: null, isPending: false }
        render(<AddCodeForm store="example.com" />)

        const link = await screen.findByRole('link', {
            name: 'Sign in to share a code',
        })
        expect(link.getAttribute('href')).toBe('/login')
        expect(screen.queryByLabelText('Coupon code')).toBeNull()
    })

    it('renders nothing while the session is still loading', () => {
        sessionState.current = { data: null, isPending: true }
        const { container } = render(<AddCodeForm store="example.com" />)
        expect(container.innerHTML).toBe('')
    })
})

describe('AddCodeForm — signed in', () => {
    it('POSTs the trimmed code as source manual, then confirms', async () => {
        const fetchMock = stubFetch(
            jsonResponse(200, {
                couponId: '900000000000000001',
                created: true,
                status: 'unverified',
            }),
        )
        render(<AddCodeForm store="example.com" />)
        await submit('  SAVE10 ')

        expect(await screen.findByText(/Added as Unverified/)).toBeTruthy()
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
        expect(url).toBe('/api/coupons/submit')
        expect(init.method).toBe('POST')
        expect(JSON.parse(init.body as string)).toEqual({
            site: 'example.com',
            code: 'SAVE10',
            source: 'manual',
        })
        expect(
            (screen.getByLabelText('Coupon code') as HTMLInputElement).value,
        ).toBe('')
    })

    it('says so when the code is already listed (created: false)', async () => {
        stubFetch(
            jsonResponse(200, {
                couponId: '1',
                created: false,
                status: 'unverified',
            }),
        )
        render(<AddCodeForm store="example.com" />)
        await submit('SAVE10')

        expect(await screen.findByText(/already listed/)).toBeTruthy()
    })

    it('refuses an implausible code client-side without calling the API', async () => {
        const fetchMock = stubFetch(jsonResponse(200, {}))
        render(<AddCodeForm store="example.com" />)
        await submit('a b')

        expect(
            await screen.findByText("That doesn't look like a coupon code."),
        ).toBeTruthy()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('maps a server 422 invalid-code to the same message', async () => {
        stubFetch(jsonResponse(422, { error: 'invalid-code' }))
        render(<AddCodeForm store="example.com" />)
        await submit('SAVE10')

        expect(
            await screen.findByText("That doesn't look like a coupon code."),
        ).toBeTruthy()
        expect(reportMock).not.toHaveBeenCalled()
    })

    it('maps 422 not-a-store to its own message', async () => {
        stubFetch(jsonResponse(422, { error: 'not-a-store' }))
        render(<AddCodeForm store="example.com" />)
        await submit('SAVE10')

        expect(
            await screen.findByText("We can't add codes for this store yet."),
        ).toBeTruthy()
        expect(reportMock).not.toHaveBeenCalled()
    })

    it('puts the real daily cap in the 429 daily-limit message', async () => {
        stubFetch(jsonResponse(429, { error: 'daily-limit' }))
        render(<AddCodeForm store="example.com" />)
        await submit('SAVE10')

        expect(
            await screen.findByText(
                `You've shared ${SHOPPER_DAILY_SUBMISSION_CAP} codes today. Try again tomorrow.`,
            ),
        ).toBeTruthy()
    })

    it("does not blame the daily cap for the rate limiter's own 429", async () => {
        stubFetch(jsonResponse(429, { error: 'Too many requests' }))
        render(<AddCodeForm store="example.com" />)
        await submit('SAVE10')

        expect(await screen.findByText(/Too many attempts/)).toBeTruthy()
        expect(screen.queryByText(/codes today/)).toBeNull()
        expect(reportMock).not.toHaveBeenCalled()
    })

    it('falls back to the sign-in prompt when the server answers 401', async () => {
        stubFetch(jsonResponse(401, { error: 'Unauthorized' }))
        render(<AddCodeForm store="example.com" />)
        await submit('SAVE10')

        expect(
            await screen.findByRole('link', {
                name: 'Sign in to share a code',
            }),
        ).toBeTruthy()
        expect(screen.queryByLabelText('Coupon code')).toBeNull()
    })

    it('reports an unexpected status to Sentry and shows the generic message', async () => {
        stubFetch(jsonResponse(500, { error: 'Internal server error' }))
        render(<AddCodeForm store="example.com" />)
        await submit('SAVE10')

        expect(
            await screen.findByText("Couldn't add that code. Try again."),
        ).toBeTruthy()
        await waitFor(() => expect(reportMock).toHaveBeenCalledTimes(1))
        const [arg] = reportMock.mock.calls[0] as unknown as [
            { operation: string; error: Error },
        ]
        expect(arg.operation).toBe('shopper_code_submit')
        expect(arg.error.message).toContain('500')
    })

    it('reports a network failure instead of swallowing it', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('net')))
        render(<AddCodeForm store="example.com" />)
        await submit('SAVE10')

        expect(
            await screen.findByText("Couldn't add that code. Try again."),
        ).toBeTruthy()
        expect(reportMock).toHaveBeenCalledTimes(1)
    })
})
