// @vitest-environment jsdom
import DataPrivacySection from '@/app/profile/sections/DataPrivacySection'
import type { ProfileOverview } from '@/lib/profile/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// T-8946: the confirm click of account deletion was autocaptured by posthog-js
// under the user's distinct id and flushed AFTER the server purged their
// PostHog person, re-creating it. posthog-js skips autocapture for an element
// with `ph-no-capture` and for its descendants.

vi.mock('@/lib/analytics/identity', () => ({
    resetPosthogIdentity: vi.fn(),
}))
vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))
vi.mock('@/lib/feedback/promptSupportOnFailure', () => ({
    promptSupportOnFailure: vi.fn(),
}))

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

function dialogWithTitle(title: string): HTMLDialogElement {
    return Array.from(document.querySelectorAll('dialog')).find(d =>
        d.textContent?.includes(title),
    )!
}

beforeEach(() => {
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
})
afterEach(cleanup)

describe('account deletion is excluded from PostHog autocapture', () => {
    it('keeps the opener, DELETE input, Cancel and confirm button inside ph-no-capture', () => {
        render(
            <DataPrivacySection overview={overview()} onDeleted={() => {}} />,
        )
        const opener = screen.getByRole('button', { name: 'Delete my account' })
        expect(opener.closest('.ph-no-capture')).not.toBeNull()

        fireEvent.click(opener)
        const dialog = dialogWithTitle('Delete your Caramel account?')
        const input = dialog.querySelector('input')!
        const buttons = Array.from(dialog.querySelectorAll('button'))
        const cancel = buttons.find(b => b.textContent === 'Cancel')!
        const confirm = buttons.find(
            b => b.textContent === 'Delete my account',
        )!

        for (const el of [input, cancel, confirm]) {
            expect(el.closest('.ph-no-capture')).not.toBeNull()
        }
    })

    it('leaves the "Delete my Caramel data" dialog capturable', () => {
        const withData = overview()
        withData.reports.reportCount = 1
        render(<DataPrivacySection overview={withData} onDeleted={() => {}} />)
        fireEvent.click(screen.getByRole('button', { name: 'Delete my data' }))
        const dialog = dialogWithTitle('Delete your Caramel data?')
        expect(dialog.closest('.ph-no-capture')).toBeNull()
    })
})
