// @vitest-environment jsdom
import SuggestionForm from '@/components/supported-site/suggestion-form'
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// NF-05 — the form previously had NO editable input and never called setUrl,
// so it could only ever submit its `initialValue` verbatim. These pins prove
// it is now a real controlled form: the input reflects `initialValue`, the
// user can edit it, and submitting posts the EDITED url to /api/sites/suggest
// then fires the existing `resetValue` handler. (Red before the fix — the
// input the first pin queries did not exist.)
const { toastMock } = vi.hoisted(() => ({
    toastMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: toastMock }))
const { sentryMock } = vi.hoisted(() => ({
    sentryMock: { captureMessage: vi.fn() },
}))
vi.mock('@sentry/nextjs', () => sentryMock)
// The real retry logic, without the real waits between attempts.
vi.mock('@/lib/postThroughDeploy', async importOriginal => {
    const real =
        await importOriginal<typeof import('@/lib/postThroughDeploy')>()
    return {
        ...real,
        postJsonThroughDeploy: (
            ...[url, body, options]: Parameters<
                typeof real.postJsonThroughDeploy
            >
        ) =>
            real.postJsonThroughDeploy(url, body, {
                ...options,
                sleep: async () => {},
            }),
    }
})

// What the edge answers while a deploy has Caramel off it (swap drill
// 2026-09-25): another app's HTML 404 page, not Caramel's JSON.
const foreignHtml404 = () => ({
    ok: false,
    status: 404,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    json: async () => {
        throw new SyntaxError('Unexpected token <')
    },
})

beforeEach(() => {
    toastMock.success.mockClear()
    toastMock.warning.mockClear()
    toastMock.error.mockClear()
    sentryMock.captureMessage.mockClear()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

describe('SuggestionForm (NF-05)', () => {
    it('renders an editable input pre-filled with initialValue', () => {
        render(
            <SuggestionForm
                initialValue="https://initial.example.com"
                resetValue={vi.fn()}
            />,
        )
        const input = screen.getByPlaceholderText(
            'https://example.com',
        ) as HTMLInputElement
        expect(input.value).toBe('https://initial.example.com')
    })

    it('submits the EDITED value (not initialValue) and fires resetValue', async () => {
        const resetValue = vi.fn()
        render(
            <SuggestionForm
                initialValue="https://initial.example.com"
                resetValue={resetValue}
            />,
        )
        const input = screen.getByPlaceholderText('https://example.com')
        fireEvent.change(input, {
            target: { value: 'https://edited.example.com' },
        })
        fireEvent.submit(input.closest('form') as HTMLFormElement)

        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
        const [calledUrl, options] = (fetch as ReturnType<typeof vi.fn>).mock
            .calls[0] as [string, RequestInit]
        expect(calledUrl).toBe('/api/sites/suggest')
        expect(JSON.parse(options.body as string)).toEqual({
            url: 'https://edited.example.com',
        })
        await waitFor(() => expect(resetValue).toHaveBeenCalledTimes(1))
    })

    it('an optional email, when filled in, rides along as `email` (omitted when blank — the previous pin)', async () => {
        render(
            <SuggestionForm
                initialValue="https://initial.example.com"
                resetValue={vi.fn()}
            />,
        )
        const emailInput = screen.getByLabelText(
            'Email me when this store is supported (optional)',
        )
        fireEvent.change(emailInput, {
            target: { value: '  shopper@example.com ' },
        })
        fireEvent.submit(emailInput.closest('form') as HTMLFormElement)

        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
        const [, options] = (fetch as ReturnType<typeof vi.fn>).mock
            .calls[0] as [string, RequestInit]
        expect(JSON.parse(options.body as string)).toEqual({
            url: 'https://initial.example.com',
            email: 'shopper@example.com',
        })
        await waitFor(() =>
            expect(toastMock.success).toHaveBeenCalledWith(
                expect.stringContaining('shopper@example.com'),
            ),
        )
    })

    it('a 4xx from the route (not a store) → warning with the server message, NO success toast, NO reset', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
                status: 400,
                json: async () => ({ error: 'Please enter a store URL' }),
            }),
        )
        const resetValue = vi.fn()
        render(
            <SuggestionForm
                initialValue="https://not-a-store.example"
                resetValue={resetValue}
            />,
        )
        const input = screen.getByPlaceholderText('https://example.com')
        fireEvent.submit(input.closest('form') as HTMLFormElement)

        await waitFor(() =>
            expect(toastMock.warning).toHaveBeenCalledWith(
                'Please enter a store URL',
            ),
        )
        expect(toastMock.success).not.toHaveBeenCalled()
        expect(resetValue).not.toHaveBeenCalled()
    })

    it('a deploy gap (a foreign HTML 404) is ridden out: the same suggestion is re-sent and succeeds, no "bad URL" warning', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(foreignHtml404())
            .mockResolvedValueOnce(foreignHtml404())
            .mockResolvedValueOnce({ ok: true, status: 200 })
        vi.stubGlobal('fetch', fetchMock)
        const resetValue = vi.fn()
        render(
            <SuggestionForm
                initialValue="https://store.example.com"
                resetValue={resetValue}
            />,
        )
        const input = screen.getByPlaceholderText('https://example.com')
        fireEvent.submit(input.closest('form') as HTMLFormElement)

        await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1))
        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(toastMock.warning).not.toHaveBeenCalled()
        expect(resetValue).toHaveBeenCalledTimes(1)
        expect(sentryMock.captureMessage).toHaveBeenCalledWith(
            'Site suggestion rode out a deploy gap',
            expect.objectContaining({
                extra: { recovered: true, attempts: 3, lastStatus: 404 },
            }),
        )
    })

    it('a deploy gap that outlasts the retries says so in a sentence and keeps the input (never "enter a store URL")', async () => {
        const fetchMock = vi
            .fn()
            .mockImplementation(async () => foreignHtml404())
        vi.stubGlobal('fetch', fetchMock)
        const resetValue = vi.fn()
        render(
            <SuggestionForm
                initialValue="https://store.example.com"
                resetValue={resetValue}
            />,
        )
        const input = screen.getByPlaceholderText('https://example.com')
        fireEvent.submit(input.closest('form') as HTMLFormElement)

        await waitFor(() =>
            expect(toastMock.error).toHaveBeenCalledWith(
                'Caramel is restarting after an update, so this was not sent. Please try again in a minute.',
            ),
        )
        expect(fetchMock).toHaveBeenCalledTimes(5)
        expect(toastMock.warning).not.toHaveBeenCalled()
        expect(toastMock.success).not.toHaveBeenCalled()
        expect(resetValue).not.toHaveBeenCalled()
    })
})
