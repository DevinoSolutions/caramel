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

describe('sanitizedUrl leak hardening', () => {
    it.each([
        ['blob:', 'blob:https://grabcaramel.com/6f1c0e1e-9a4f-4f4e-8a55-3c1d6f3b2a10'],
        ['data:', 'data:text/plain;base64,U0VDUkVU'],
        ['javascript:', 'javascript:alert("SECRET")'],
    ])('prints only the scheme for %s URLs', (scheme, raw) => {
        expect(sanitizedUrl(raw)).toBe(scheme)
    })

    it('masks path segments that look like tokens', () => {
        expect(
            sanitizedUrl(
                'https://grabcaramel.com/api/session/abcdefghijklmnopqrstuvwx/ok',
            ),
        ).toBe('grabcaramel.com/api/session/<redacted>/ok')
        // 19 characters is not token-like; a dot keeps a chunk name readable.
        expect(
            sanitizedUrl('https://grabcaramel.com/abcdefghijklmnopqrs/x.js'),
        ).toBe('grabcaramel.com/abcdefghijklmnopqrs/x.js')
        expect(
            sanitizedUrl(
                'https://grabcaramel.com/_next/static/chunks/0cz1d0mv5g_q7.js',
            ),
        ).toBe('grabcaramel.com/_next/static/chunks/0cz1d0mv5g_q7.js')
    })

    it('masks everything after /reset-password/ and /verify-email/', () => {
        expect(
            sanitizedUrl('https://grabcaramel.com/reset-password/abc/def?x=1'),
        ).toBe('grabcaramel.com/reset-password/<redacted>/<redacted>')
        expect(
            sanitizedUrl('https://grabcaramel.com/verify-email/short'),
        ).toBe('grabcaramel.com/verify-email/<redacted>')
        // The bare route (what a page load of /reset-password looks like) stays visible.
        expect(sanitizedUrl('https://grabcaramel.com/reset-password')).toBe(
            'grabcaramel.com/reset-password',
        )
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
            Array.from({ length: MAX_EVIDENCE_LINES + 5 }, (_, index) =>
                entry({ url: `https://grabcaramel.com/page-${index}` }),
            ),
        )

        expect(lines).toHaveLength(MAX_EVIDENCE_LINES + 2)
        expect(lines[lines.length - 1]).toContain('and 5 more')
    })

    it('merges duplicates and says how often they happened', () => {
        const lines = formatRequestEvidence('t', [entry(), entry(), entry()])

        expect(lines).toHaveLength(2)
        expect(lines[1]).toContain('(script) x3')
    })

    it('prints stalled and broken chunks first, so the cap never cuts them off', () => {
        const noise = Array.from({ length: MAX_EVIDENCE_LINES + 10 }, (_, i) =>
            entry({
                url: `https://analytics.example/beacon-${i}`,
                resourceType: 'ping',
                outcome: 'net::ERR_ABORTED',
            }),
        )
        const lines = formatRequestEvidence('t', [
            // Seen first, but not decisive: a healthy document and aborted prefetches.
            entry({
                url: 'https://grabcaramel.com/profile',
                resourceType: 'document',
                outcome: '200',
            }),
            ...noise,
            // Decisive, seen last.
            entry({
                url: 'https://grabcaramel.com/_next/static/chunks/gone.js',
                outcome: '404',
            }),
            entry({
                url: 'https://grabcaramel.com/_next/static/chunks/stalled.js',
                outcome: 'pending',
            }),
            entry({
                url: 'https://grabcaramel.com/profile',
                resourceType: 'document',
                outcome: 'pending',
            }),
        ])

        expect(lines[1]).toContain('chunks/gone.js -> 404')
        expect(lines[2]).toContain('chunks/stalled.js -> pending')
        expect(lines[3]).toContain('grabcaramel.com/profile -> pending')
        expect(lines).toHaveLength(MAX_EVIDENCE_LINES + 2)
        expect(lines.join('
')).toContain('more')
    })
})
