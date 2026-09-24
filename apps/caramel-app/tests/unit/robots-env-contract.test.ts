import { AI_CRAWLERS } from '@/lib/seo/aiCrawlers'
import type { MetadataRoute } from 'next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins BOTH branches of src/app/robots.ts's env-aware contract. The e2e
// suite (e2e/seo-regression.spec.ts) can only ever exercise the non-prod
// branch — CI targets localhost and dev.grabcaramel.com — so the
// production-allow branch (including the named AI-crawler allow group) is
// proven here, at unit level, where the origin is ours to choose. robots.ts
// resolves BASE_URL at module scope, hence resetModules + doMock + dynamic
// import per case.

type Rule = Extract<MetadataRoute.Robots['rules'], readonly unknown[]>[number]

// Authenticated surfaces / machine-only API stay out of the crawl budget —
// keep in sync with robots.ts DISALLOWED_PATHS. Both prod groups share it.
const DISALLOWED_PATHS = [
    '/api/',
    '/login',
    '/signup',
    '/verify',
    '/profile',
    '/monitoring',
]

// The fleet's AI-crawler allow-list, spelled out here ON PURPOSE (not
// imported) so a silent edit to src/lib/seo/aiCrawlers.ts — a dropped agent,
// a typo, a reorder — fails this test instead of quietly shipping.
const EXPECTED_AI_CRAWLERS = [
    'GPTBot',
    'OAI-SearchBot',
    'ChatGPT-User',
    'ClaudeBot',
    'Claude-User',
    'Claude-SearchBot',
    'anthropic-ai',
    'PerplexityBot',
    'Perplexity-User',
    'Google-Extended',
    'Googlebot',
    'Bingbot',
    'Applebot',
    'Applebot-Extended',
    'CCBot',
    'Amazonbot',
    'Bytespider',
    'meta-externalagent',
]

async function robotsFor(baseUrl: string): Promise<MetadataRoute.Robots> {
    vi.resetModules()
    vi.doMock('@/lib/env.client', () => ({ BASE_URL: baseUrl }))
    const { default: robots } = await import('@/app/robots')
    return robots()
}

function rulesOf(result: MetadataRoute.Robots): Rule[] {
    const rules = result.rules
    expect(Array.isArray(rules)).toBe(true)
    return rules as Rule[]
}

beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('@/lib/env.client')
})

describe('robots.ts env-aware indexing contract', () => {
    it('the AI-crawler allow-list is exactly the 18 fleet agents, in order', () => {
        expect([...AI_CRAWLERS]).toEqual(EXPECTED_AI_CRAWLERS)
        expect(new Set(AI_CRAWLERS).size).toBe(18)
    })

    it.each([
        'https://dev.grabcaramel.com',
        'http://localhost:58000',
        'https://preview-caramel.example.com',
    ])(
        'non-production origin %s blanket-disallows with ONE rule and NO sitemap',
        async (origin: string) => {
            const result = await robotsFor(origin)
            const rules = rulesOf(result)
            // No AI allow group on a staging host either — a named
            // invitation to index dev.grabcaramel.com would be worse than
            // the wildcard one.
            expect(rules).toHaveLength(1)
            const [rule] = rules
            expect(rule.userAgent).toBe('*')
            expect(rule.disallow).toBe('/')
            expect(rule.allow).toBeUndefined()
            expect(result.sitemap).toBeUndefined()
        },
    )

    it.each(['https://grabcaramel.com', 'https://www.grabcaramel.com'])(
        'production origin %s allows crawling, disallows non-content paths, and advertises the sitemap',
        async origin => {
            const result = await robotsFor(origin)
            const rules = rulesOf(result)
            expect(rules).toHaveLength(2)
            const [wildcard] = rules
            expect(wildcard.userAgent).toBe('*')
            expect(wildcard.allow).toBe('/')
            expect(wildcard.disallow).toEqual(DISALLOWED_PATHS)
            expect(result.sitemap).toBe(`${origin}/sitemap.xml`)
        },
    )

    it('production adds a second, explicit allow group for the 18 AI crawlers with the SAME disallow set', async () => {
        const result = await robotsFor('https://grabcaramel.com')
        const [, aiGroup] = rulesOf(result)
        expect(aiGroup.userAgent).toEqual(EXPECTED_AI_CRAWLERS)
        // /api/coupons is the API the caramel-coupons skill and
        // /agent-setup/prompt.md tell agents to call; the longer allow rule
        // beats the `/api/` disallow for robots-honouring fetchers (#257).
        expect(aiGroup.allow).toEqual(['/', '/api/coupons'])
        // Private paths stay private for answer engines too.
        expect(aiGroup.disallow).toEqual(DISALLOWED_PATHS)
    })

    it('a trailing slash on BASE_URL still resolves the production branch', async () => {
        const result = await robotsFor('https://grabcaramel.com/')
        expect(result.sitemap).toBe('https://grabcaramel.com/sitemap.xml')
    })
})
