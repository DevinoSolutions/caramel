import type { MetadataRoute } from 'next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins BOTH branches of src/app/robots.ts's env-aware contract. The e2e
// suite (e2e/seo-regression.spec.ts) can only ever exercise the non-prod
// branch — CI targets localhost and dev.grabcaramel.com — so the
// production-allow branch is proven here, at unit level, where the origin
// is ours to choose. robots.ts resolves BASE_URL at module scope, hence
// resetModules + doMock + dynamic import per case.

async function robotsFor(baseUrl: string): Promise<MetadataRoute.Robots> {
    vi.resetModules()
    vi.doMock('@/lib/env.client', () => ({ BASE_URL: baseUrl }))
    const { default: robots } = await import('@/app/robots')
    return robots()
}

function soleRule(
    result: MetadataRoute.Robots,
): Extract<MetadataRoute.Robots['rules'], readonly unknown[]>[number] {
    const rules = result.rules
    expect(Array.isArray(rules)).toBe(true)
    const list = rules as Extract<
        MetadataRoute.Robots['rules'],
        readonly unknown[]
    >
    expect(list).toHaveLength(1)
    return list[0]
}

beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('@/lib/env.client')
})

describe('robots.ts env-aware indexing contract', () => {
    it.each([
        'https://dev.grabcaramel.com',
        'http://localhost:58000',
        'https://preview-caramel.example.com',
    ])(
        'non-production origin %s blanket-disallows with NO sitemap',
        async (origin: string) => {
            const result = await robotsFor(origin)
            const rule = soleRule(result)
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
            const rule = soleRule(result)
            expect(rule.userAgent).toBe('*')
            expect(rule.allow).toBe('/')
            // Authenticated surfaces / machine-only API stay out of the
            // crawl budget — keep in sync with robots.ts DISALLOWED_PATHS.
            expect(rule.disallow).toEqual([
                '/api/',
                '/login',
                '/signup',
                '/verify',
                '/profile',
                '/monitoring',
            ])
            expect(result.sitemap).toBe(`${origin}/sitemap.xml`)
        },
    )

    it('a trailing slash on BASE_URL still resolves the production branch', async () => {
        const result = await robotsFor('https://grabcaramel.com/')
        expect(result.sitemap).toBe('https://grabcaramel.com/sitemap.xml')
    })
})
