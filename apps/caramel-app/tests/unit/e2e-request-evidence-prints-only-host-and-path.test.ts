import { describe, expect, it } from 'vitest'
import {
    formatRequestEvidence,
    isHydrationCritical,
    MAX_EVIDENCE_LINES,
    sanitizedUrl,
    type RequestEvidence,
} from '../../e2e/support/request-evidence'

// T-9427 — the failed-request list that lands in the PUBLIC job log must never
// carry anything beyond method, host + path, resource type and outcome.
function entry(overrides: Partial<RequestEvidence> = {}): RequestEvidence {
    return {
        method: 'GET',
        url: 'https://grabcaramel.com/_next/static/chunks/abc.js',
        resourceType: 'script',
        outcome: '404',
        ...overrides,
    }
}

describe('sanitizedUrl', () => {
    it('drops the query string and the fragment', () => {
        expect(
            sanitizedUrl(
                'https://grabcaramel.com/api/auth/callback?token=SECRET&code=SECRET#frag',
            ),
        ).toBe('grabcaramel.com/api/auth/callback')
    })

    it('drops credentials embedded in the URL', () => {
        expect(sanitizedUrl('https://user:SECRET@grabcaramel.com/x?y=1')).toBe(
            'grabcaramel.com/x',
        )
    })

    it('prints a fixed marker, never the raw string, for a URL that does not parse', () => {
        expect(sanitizedUrl('not a url?token=SECRET')).toBe('(unparseable url)')
    })

    it('cuts a very long path', () => {
        const shown = sanitizedUrl(`https://grabcaramel.com/${'a'.repeat(500)}`)
        expect(shown.length).toBeLessThan(130)
        expect(shown.endsWith('...')).toBe(true)
    })
})

describe('isHydrationCritical', () => {
    it('keeps documents and /_next/ requests, drops third-party beacons', () => {
        expect(isHydrationCritical(entry())).toBe(true)
        expect(
            isHydrationCritical(
                entry({
                    url: 'https://grabcaramel.com/profile',
                    resourceType: 'document',
                }),
            ),
        ).toBe(true)
        expect(
            isHydrationCritical(
                entry({
                    url: 'https://static.cloudflareinsights.com/beacon.min.js',
                }),
            ),
        ).toBe(false)
    })
})

describe('formatRequestEvidence', () => {
    it('prints method, host + path, outcome and resource type only', () => {
        const lines = formatRequestEvidence('t (attempt 1, failed)', [
            entry({
                url: 'https://grabcaramel.com/_next/static/chunks/abc.js?v=SECRET',
                outcome: 'net::ERR_NETWORK_CHANGED',
            }),
        ])

        expect(lines).toEqual([
            '[request-evidence] t (attempt 1, failed)',
            '[request-evidence]   GET grabcaramel.com/_next/static/chunks/abc.js -> net::ERR_NETWORK_CHANGED (script)',
        ])
        expect(lines.join('\n')).not.toContain('SECRET')
    })

    it('says so when nothing went wrong', () => {
        expect(formatRequestEvidence('t', [])[1]).toContain('no failed')
    })

    it('caps the list and counts the remainder', () => {
        const lines = formatRequestEvidence(
            't',
            Array.from({ length: MAX_EVIDENCE_LINES + 5 }, () => entry()),
        )

        expect(lines).toHaveLength(MAX_EVIDENCE_LINES + 2)
        expect(lines.at(-1)).toContain('and 5 more')
    })
})
