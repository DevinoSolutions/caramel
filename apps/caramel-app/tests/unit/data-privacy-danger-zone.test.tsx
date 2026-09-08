// @vitest-environment jsdom
import DataPrivacySection from '@/app/profile/sections/DataPrivacySection'
import type { ProfileOverview } from '@/lib/profile/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The danger-zone gate.
//
// The button is disabled and reads "Nothing to delete" when there is genuinely
// nothing — which is right, and was WRONG for one population: it counted only
// savings, followed stores and coupon reports. A request made while SIGNED OUT
// carries nothing but the email typed into the form, so the one user whose only
// personal data is that email was told "Nothing to delete" and could never
// reach the route that removes it. The route was fixed first (#227); this is
// the half that makes it reachable.
//
// The copy has to stay honest in the other direction too: the store request is
// NOT deleted. Only the requester's identity comes off it, because other people
// may have made the same request and the coupons pipeline still needs it.

const { toastMock } = vi.hoisted(() => ({
    toastMock: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: toastMock }))

/** A real ProfileOverview with everything at zero — the shape the route
 * actually returns for a brand-new account. Built from the shared type, so a
 * field added there cannot be quietly missing here. */
function emptyOverview(): ProfileOverview {
    return {
        memberSince: '2026-03-14T10:00:00.000Z',
        hasExtensionActivity: false,
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
        reports: {
            reportCount: 0,
            confirmedCount: null,
            shoppersHelped: null,
        },
    }
}

function renderSection(overview: ProfileOverview | null) {
    return render(
        <DataPrivacySection overview={overview} onDeleted={() => {}} />,
    )
}

/** The danger-zone button, as an HTMLButtonElement so `.disabled` can be read
 * directly — this repo's vitest setup carries no jest-dom matchers. */
function deleteButton(): HTMLButtonElement {
    return screen.getByRole('button', {
        name: /nothing to delete|delete my/i,
    }) as HTMLButtonElement
}

// ConfirmDialog is built on the native <dialog> and calls showModal()/close(),
// neither of which jsdom implements. Stubbed to the `open` attribute they set
// in a real browser, so the component's own open/close effect still runs and
// the dialog's children are queryable — the copy is what these pins read.
/** The confirm dialog's own text. Scoped to the <dialog>, because the section
 * description mentions store requests too — a document-wide query would read
 * one and claim it had read the other. */
function dialogText(): string {
    const dialog = document.querySelector('dialog')
    if (!dialog) throw new Error('the confirm dialog is not open')
    return dialog.textContent ?? ''
}

beforeEach(() => {
    vi.clearAllMocks()
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

afterEach(() => {
    cleanup()
})

describe('the danger-zone gate counts store requests', () => {
    it('a user with NOTHING at all sees the button disabled and honestly labelled', () => {
        renderSection(emptyOverview())

        const button = deleteButton()
        expect(button.disabled).toBe(true)
        expect(button.textContent).toBe('Nothing to delete')
    })

    it('THE PAIR: a user whose ONLY personal data is a store request can reach the route', () => {
        // Before this change the same fixture rendered "Nothing to delete":
        // the gate read three counts and this user has zero of all three.
        const overview = emptyOverview()
        overview.siteSuggestions.identifyingCount = 1
        renderSection(overview)

        const button = deleteButton()
        expect(button.disabled).toBe(false)
        expect(button.textContent).toBe('Delete my data')
    })

    it('the PRE-CHANGE gate, kept verbatim, would still have disabled that button', () => {
        // The predicate the section carried before, run against the same
        // fixture. Keeping it here is what makes the pin above a pair rather
        // than an assertion about the current code alone.
        const overview = emptyOverview()
        overview.siteSuggestions.identifyingCount = 1
        const preChangeNothingToDelete =
            overview.savings.eventCount === 0 &&
            overview.favorites.length === 0 &&
            overview.reports.reportCount === 0
        expect(preChangeNothingToDelete).toBe(true)
    })

    it('after the scrub the count is 0, so the button returns to disabled', () => {
        // What the page sees on the refetch `onDeleted` triggers: the rows
        // still exist, but nothing on them identifies this account any more, so
        // the same predicate that counts them now counts none.
        const before = emptyOverview()
        before.siteSuggestions.identifyingCount = 2
        const { unmount } = renderSection(before)
        expect(deleteButton().disabled).toBe(false)
        unmount()

        renderSection(emptyOverview())
        expect(deleteButton().disabled).toBe(true)
    })

    it('any ONE of the four counts is enough on its own', () => {
        const cases: ((o: ProfileOverview) => void)[] = [
            o => {
                o.savings.eventCount = 1
            },
            o => {
                o.favorites = [
                    {
                        domain: 'worldofbooks.com',
                        starredAt: '2026-03-14T10:00:00.000Z',
                        couponCount: null,
                    },
                ]
            },
            o => {
                o.reports.reportCount = 1
            },
            o => {
                o.siteSuggestions.identifyingCount = 1
            },
        ]
        // Indexed loop, not `.entries()`: the tsconfig target predates
        // downlevel iteration of an array iterator.
        for (let index = 0; index < cases.length; index += 1) {
            const apply = cases[index]!
            const overview = emptyOverview()
            apply(overview)
            const { unmount } = renderSection(overview)
            expect(deleteButton().disabled, `case ${index}`).toBe(false)
            unmount()
        }
    })

    it('a failed overview load still refuses to offer a delete it cannot describe', () => {
        renderSection(null)
        expect(deleteButton().disabled).toBe(true)
    })
})

describe('the danger-zone copy stays honest about what survives', () => {
    it('the section description says the details come OFF the requests', () => {
        renderSection(emptyOverview())
        expect(
            screen.getByText(/Removes the stores you follow/i).textContent,
        ).toContain('takes your details off any store requests you sent')
    })

    it('a suggestion-only user’s dialog never claims anything is "permanently removed"', () => {
        const overview = emptyOverview()
        overview.siteSuggestions.identifyingCount = 1
        renderSection(overview)
        fireEvent.click(deleteButton())

        const body = dialogText()
        // Nothing of theirs IS removed — the request survives, without them
        // attached — so the sentence that completes "This permanently removes
        // ..." must not appear at all for this user.
        expect(body).not.toContain('permanently removes')
        expect(body).toContain(
            'takes your email and device details off 1 store request',
        )
        expect(body).toContain('the request itself stays')
        expect(body).toContain('Your account stays')
    })

    it('a user with BOTH kinds of data gets both halves, and the request half still reads as a removal FROM', () => {
        const overview = emptyOverview()
        overview.savings.eventCount = 3
        overview.siteSuggestions.identifyingCount = 2
        renderSection(overview)
        fireEvent.click(deleteButton())

        const body = dialogText()
        expect(body).toContain('This permanently removes 3 savings events')
        expect(body).toContain(
            'It also takes your email and device details off 2 store requests',
        )
        expect(body).toContain('the requests themselves stay')
    })

    it('a user with no store requests sees no sentence about them at all', () => {
        const overview = emptyOverview()
        overview.reports.reportCount = 1
        renderSection(overview)
        fireEvent.click(deleteButton())

        expect(dialogText()).not.toMatch(/store request/i)
        expect(dialogText()).toContain(
            'This permanently removes 1 coupon report',
        )
    })
})
