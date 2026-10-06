import { sentryIssueSearchUrl } from '@/lib/sentryLinks'
import { describe, expect, it } from 'vitest'

// Pins the support email's Sentry link to the SELF-HOSTED instance. It used to
// point at devino.sentry.io (Sentry's SaaS), where Caramel has no org, so every
// "open in Sentry" link in a support email went nowhere.

describe('sentryIssueSearchUrl', () => {
    it('searches issues for the event id on the self-hosted devino org', () => {
        expect(sentryIssueSearchUrl('abc123')).toBe(
            'https://sentry.devino.ca/organizations/devino/issues/?query=abc123',
        )
    })

    it('never points at Sentry SaaS', () => {
        expect(sentryIssueSearchUrl('abc123')).not.toContain('sentry.io')
    })

    it('encodes the event id so it cannot break out of the query', () => {
        expect(sentryIssueSearchUrl('a b&c')).toBe(
            'https://sentry.devino.ca/organizations/devino/issues/?query=a%20b%26c',
        )
    })

    it('returns undefined when there is no event id', () => {
        expect(sentryIssueSearchUrl(undefined)).toBeUndefined()
        expect(sentryIssueSearchUrl('')).toBeUndefined()
    })
})
