// @vitest-environment jsdom
import ReportsImpactSection from '@/app/profile/sections/ReportsImpactSection'
import SavingsSection from '@/app/profile/sections/SavingsSection'
import type { ProfileOverview } from '@/lib/profile/types'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

// The account page ships two sentences that interleave a <strong>/<Link> with
// the prose around it, and BOTH shipped to production with the space silently
// eaten: "…and 2matched what we found…" and "…delete themfrom Data & privacy".
//
// The cause is a JSX-whitespace rule, not a typo: a literal space that sits
// between an element and the text following it is dropped when the compiler
// normalizes the text node, so the fix is an explicit `{' '}` expression that
// cannot be normalized away. That also means the bug is INVISIBLE in the
// source — the file reads as if the space is there — which is exactly why it
// needs a rendered-output assertion rather than a review rule.
//
// These pin the rendered sentence, so re-introducing the literal-space form
// (or a prettier reflow that moves a `{' '}` onto its own line) fails here
// instead of on the live page.

function textOf(node: HTMLElement): string {
    // textContent, not innerText: jsdom does not lay out, so innerText is
    // unreliable. Collapse runs of whitespace the way a browser renders them.
    return (node.textContent ?? '').replace(/\s+/g, ' ')
}

const savingsWithHistorySyncOff: ProfileOverview['savings'] = {
    syncEnabled: false,
    eventCount: 7,
    storeCount: 3,
    totals: [{ currency: 'USD', minorUnits: 14237 }],
    firstEventAt: '2026-03-19T10:00:00.000Z',
    recentEvents: [],
}

afterEach(cleanup)

describe('account page copy keeps its spaces around inline elements', () => {
    it('renders "and 2 matched what we found" with a space after the count', () => {
        const { container } = render(
            <ReportsImpactSection
                reports={{
                    reportCount: 3,
                    confirmedCount: 2,
                    shoppersHelped: null,
                }}
            />,
        )
        const text = textOf(container)
        // Precondition: this really is the tier-B sentence, so a future tier
        // change cannot make the assertions below pass vacuously.
        expect(text).toContain('Thanks for reporting')
        expect(text).toContain('and 2 matched what we found when we checked')
        expect(text).not.toContain('2matched')
    })

    it('renders "delete them from Data & privacy" with a space before "from"', () => {
        const { container } = render(
            <SavingsSection
                savings={savingsWithHistorySyncOff}
                onSyncChange={() => {}}
            />,
        )
        const text = textOf(container)
        // Precondition: the sync-off-with-history branch, not the pitch.
        expect(text).toContain('Sync is off.')
        expect(text).toContain('delete them from Data & privacy')
        expect(text).not.toContain('themfrom')
    })

    it('agrees verb and pronoun with a single event', () => {
        const { container } = render(
            <SavingsSection
                savings={{ ...savingsWithHistorySyncOff, eventCount: 1 }}
                onSyncChange={() => {}}
            />,
        )
        const text = textOf(container)
        expect(text).toContain('The 1 event already in your account is still')
        expect(text).toContain('delete it from Data & privacy')
    })
})
