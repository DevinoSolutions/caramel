// @vitest-environment jsdom
import DataPrivacySection from '@/app/profile/sections/DataPrivacySection'
import type { ProfileOverview } from '@/lib/profile/types'
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// T-7505: after the server deletes the account (and its PostHog person), the
// browser must drop its persisted PostHog distinct id, or posthog-js keeps
// sending events under the deleted id and re-creates the person. A failed
// deletion must NOT reset (the account still exists).

const { resetMock, toastMock } = vi.hoisted(() => ({
    resetMock: vi.fn(),
    toastMock: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))
vi.mock('@/lib/analytics/identity', () => ({
    resetPosthogIdentity: resetMock,
}))
vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('@/lib/feedback/promptSupportOnFailure', () => ({
    promptSupportOnFailure: vi.fn(),
}))

const fetchMock = vi.fn<typeof fetch>()

function overview(): ProfileOverview {
    return {
        memberSince: '2026-03-14T10:00:00.000Z',
        hasExtensionActivity: false,
        growthPromptsEnabled: true,
        savings: {
            syncEnabled: false,
            eventCount: 0,
            storeCount: 0,
            totals: [],
            firstEventAt: null,
            recentEvents: [],
        },
        favorites: [],
        siteSuggestions: { identifyingCount: 0 },
        reports: { reportCount: 0, confirmedCount: null, shoppersHelped: null },
    }
}

async function confirmAccountDelete() {
    render(<DataPrivacySection overview={overview()} onDeleted={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
    // Two <dialog>s exist (delete data, delete account); take the account one.
    const dialog = Array.from(document.querySelectorAll('dialog')).find(d =>
        d.textContent?.includes('Delete your Caramel account?'),
    )!
    const input = dialog.querySelector('input')!
    fireEvent.change(input, { target: { value: 'DELETE' } })
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
        b => b.textContent === 'Delete my account',
    )!
    fireEvent.click(confirm)
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    HTMLDialogElement.prototype.showModal = function showModal(this: {
        open: boolean
    }) {
        this.open = true
    }
    HTMLDialogElement.prototype.close = function close(this: {
        open: boolean
    }) {
        this.open = false
    }
    // jsdom cannot navigate; the component assigns location.href after success.
    vi.stubGlobal('location', { href: '' })
})
afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

describe('account deletion on /profile and the PostHog identity', () => {
    it('resets the browser PostHog identity after a successful deletion', async () => {
        fetchMock.mockResolvedValue(Response.json({ deleted: true }))

        await confirmAccountDelete()

        await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1))
        expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/account/delete')
    })

    it('resets the identity BEFORE redirecting to /login', async () => {
        const order: string[] = []
        resetMock.mockImplementation(() => order.push('reset'))
        vi.stubGlobal('location', {
            set href(value: string) {
                order.push(`href:${value}`)
            },
        })
        fetchMock.mockResolvedValue(Response.json({ deleted: true }))

        await confirmAccountDelete()

        await waitFor(() => expect(order).toContain('href:/login'))
        expect(order).toEqual(['reset', 'href:/login'])
    })

    it('does not reset when the deletion failed', async () => {
        fetchMock.mockResolvedValue(new Response('no', { status: 500 }))

        await confirmAccountDelete()

        await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
        expect(resetMock).not.toHaveBeenCalled()
    })
})
