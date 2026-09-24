import { urlBreakSegments } from '@/app/(marketing)/agent-setup/UrlBreakableText'
import { describe, expect, it } from 'vitest'

// The agent-setup pages render long URLs through UrlBreakableText so narrow
// screens wrap them at URL boundaries instead of mid-word. The real-browser
// layout proof lives in e2e/agent-setup.spec.ts; this pins the split rules.

describe('urlBreakSegments', () => {
    it('breaks after path slashes but never inside the scheme //', () => {
        expect(
            urlBreakSegments('https://grabcaramel.com/agent-setup/prompt.md'),
        ).toEqual(['https://grabcaramel.com/', 'agent-setup/', 'prompt.md'])
    })

    it('breaks after ? and & in a query string', () => {
        expect(
            urlBreakSegments(
                'curl -s "https://grabcaramel.com/api/coupons?site=nike.com&limit=1"',
            ),
        ).toEqual([
            'curl -s "https://grabcaramel.com/',
            'api/',
            'coupons?',
            'site=nike.com&',
            'limit=1"',
        ])
    })

    it('never adds or drops characters', () => {
        const samples = [
            'Fetch and execute the appropriate instructions to set me up for Caramel from https://grabcaramel.com/agent-setup/prompt.md',
            'npx -y skills add DevinoSolutions/caramel --skill caramel-coupons --yes --global --agent codex',
            'ends with a slash/',
            '',
            'no url here',
        ]
        for (const text of samples) {
            expect(urlBreakSegments(text).join('')).toBe(text)
        }
    })

    it('returns no empty segments', () => {
        expect(urlBreakSegments('a/')).toEqual(['a/'])
        expect(urlBreakSegments('')).toEqual([])
    })
})
