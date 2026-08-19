import { posthogSupportEventUrl } from '@/lib/analytics/posthogLinks'
import { describe, expect, it } from 'vitest'

// Pins for the support email's PostHog deep link. The `#q=` fragment shape
// (DataTableNode → EventsQuery with an `exact` feedback_id property filter)
// was PROVEN against the live self-hosted explorer on 2026-08-19 — navigating
// it renders the filter chip and exactly the one matching event. These tests
// freeze that shape so a refactor cannot silently degrade the link into one
// that loads an unfiltered (or broken) explorer.

const FEEDBACK_ID = '1b0a369b-7eab-4a27-91ee-3ebef9ea5ea1'
const BASE = 'https://posthog.example.com/project/123'

function decodeQ(url: string): Record<string, unknown> {
    const fragment = url.split('#q=')[1]
    expect(fragment).toBeTruthy()
    return JSON.parse(decodeURIComponent(fragment!)) as Record<string, unknown>
}

describe('posthogSupportEventUrl', () => {
    it('no configured project UI URL → undefined (the email carries no link)', () => {
        expect(posthogSupportEventUrl(FEEDBACK_ID, undefined)).toBeUndefined()
        expect(posthogSupportEventUrl(FEEDBACK_ID, '')).toBeUndefined()
    })

    it('builds the proven activity-explorer URL: base + /activity/explore + #q=', () => {
        const url = posthogSupportEventUrl(FEEDBACK_ID, BASE)!
        expect(url.startsWith(`${BASE}/activity/explore#q=`)).toBe(true)
    })

    it('the #q= payload is the proven query shape, filtered EXACTLY on this feedback_id', () => {
        const q = decodeQ(posthogSupportEventUrl(FEEDBACK_ID, BASE)!)
        expect(q).toMatchObject({
            kind: 'DataTableNode',
            source: {
                kind: 'EventsQuery',
                event: 'support_request_submitted',
                properties: [
                    {
                        key: 'feedback_id',
                        value: [FEEDBACK_ID],
                        operator: 'exact',
                        type: 'event',
                    },
                ],
            },
        })
        // The window must outlive triage lag — the explorer default (24h)
        // would show an empty table for a report opened days later.
        expect((q.source as { after: string }).after).toBe('-90d')
    })

    it('tolerates trailing slashes on the configured base without doubling them', () => {
        const url = posthogSupportEventUrl(FEEDBACK_ID, `${BASE}//`)!
        expect(url.startsWith(`${BASE}/activity/explore#q=`)).toBe(true)
        expect(url).not.toContain('//activity')
    })
})
