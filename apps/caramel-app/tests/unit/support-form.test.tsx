// @vitest-environment jsdom
import SupportForm from '@/components/support/support-form'
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The support form's feedback_id lifecycle is load-bearing: ONE id per logical
// submission, REUSED on retry after a failure (so a retry is idempotent on the
// server), regenerated only after a success. These pins drive the real form and
// read the id off the posted body.
const { toastMock } = vi.hoisted(() => ({
    toastMock: {
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
    },
}))
vi.mock('sonner', () => ({ toast: toastMock }))
// PostHog inactive → no session/distinct id branch (keeps the body minimal).
vi.mock('@/lib/analytics/identity', () => ({ isPosthogActive: () => false }))
vi.mock('posthog-js', () => ({ default: {} }))

function postedBody(callIndex: number): Record<string, unknown> {
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[callIndex] as [
        string,
        RequestInit,
    ]
    return JSON.parse(call[1].body as string)
}

let uuidCounter = 0

beforeEach(() => {
    toastMock.success.mockClear()
    toastMock.warning.mockClear()
    toastMock.error.mockClear()
    uuidCounter = 0
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
        () =>
            `id-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`,
    )
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

function typeMessage(text: string) {
    const textarea = screen.getByLabelText('Your message')
    fireEvent.change(textarea, { target: { value: text } })
    return textarea
}

describe('SupportForm — feedback_id lifecycle', () => {
    it('REUSES the same feedback_id when a failed submit is retried', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
                status: 502,
                json: async () => ({
                    ok: false,
                    analytics: 'failed',
                    email: 'failed',
                    feedback_id: 'id-1',
                }),
            }),
        )
        render(<SupportForm accountEmail={null} />)

        typeMessage('first attempt')
        fireEvent.submit(
            screen
                .getByLabelText('Your message')
                .closest('form') as HTMLFormElement,
        )
        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

        // Retry — form state is kept, submit again.
        fireEvent.submit(
            screen
                .getByLabelText('Your message')
                .closest('form') as HTMLFormElement,
        )
        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

        expect(postedBody(0).feedback_id).toBe('id-1')
        expect(postedBody(1).feedback_id).toBe('id-1')
        expect(toastMock.error).toHaveBeenCalled()
    })

    it('regenerates a NEW feedback_id for a fresh submission after a success', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({ ok: true, analytics: 'ok', email: 'ok' }),
            }),
        )
        render(<SupportForm accountEmail={null} />)

        typeMessage('first message')
        fireEvent.submit(
            screen
                .getByLabelText('Your message')
                .closest('form') as HTMLFormElement,
        )
        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
        await waitFor(() =>
            expect(screen.getByText('Send another')).toBeTruthy(),
        )

        // Start a brand-new submission.
        fireEvent.click(screen.getByText('Send another'))
        typeMessage('second message')
        fireEvent.submit(
            screen
                .getByLabelText('Your message')
                .closest('form') as HTMLFormElement,
        )
        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

        expect(postedBody(0).feedback_id).toBe('id-1')
        expect(postedBody(1).feedback_id).toBe('id-2')
    })
})
