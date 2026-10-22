import { GET } from '@/app/md/[...path]/route'
import robots from '@/app/robots'
import type { attachSignals } from '@/lib/couponSignals'
import { VISIBLE_COUPON_STATUSES } from '@/lib/coupons'
import type { CouponListRow } from '@/lib/couponsDb'
import { listStoreCoupons, type StoreCouponFacts } from '@/lib/couponsRepo'
import {
    couponMarkdown,
    markdownCode,
    markdownText,
} from '@/lib/seo/markdownTwins/content'
import { guidePageBuilders } from '@/lib/seo/markdownTwins/guidePages'
import {
    buildMarkdownHeaders,
    buildMarkdownRewrites,
    MARKDOWN_ACCEPT,
    MARKDOWN_TWIN_PATHS,
    markdownPath,
} from '@/lib/seo/markdownTwins/registry.mjs'
import { staticPageBuilders } from '@/lib/seo/markdownTwins/staticPages'
import { createStoreMarkdownBuilder } from '@/lib/seo/markdownTwins/storePage'
import { buildStoreFaq } from '@/lib/seo/storeFaq'
import { middleware } from '@/middleware'
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import config from '../../next.config.mjs'

vi.mock('@/lib/couponsRepo', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/couponsRepo')>()),
    listStoreCoupons: vi.fn(),
}))

// Explicit fixture overlay: no DB reads in these route tests.
const signalOverlay: typeof attachSignals = async rows =>
    rows.map(row => ({
        ...row,
        lastWorkedAt:
            row.id === 'visible'
                ? new Date(Date.now() - 3_600_000).toISOString()
                : null,
        lastFailedAt: null,
        failCount: 0,
        failWeight: row.id === 'hidden' ? 6 : 0,
        keepsFailing: row.id === 'hidden',
    }))

vi.mock('@/lib/couponSignals', () => ({
    attachSignals: async (rows: CouponListRow[]) => signalOverlay(rows),
}))

const facts: StoreCouponFacts = {
    percentOffCodes: 2,
    bestPercentOff: 20,
    fixedAmountCodes: 0,
    lastUpdated: new Date('2026-10-20T00:00:00Z'),
}

function coupon(id: string, code: string): CouponListRow {
    return {
        id,
        code,
        site: 'nike.com',
        title: `${code} offer`,
        description: 'Shopper-facing offer',
        rating: 1,
        discount_type: 'PERCENTAGE',
        discount_amount: 20,
        expiry: null,
        expired: false,
        timesUsed: 0,
        status: VISIBLE_COUPON_STATUSES[0],
        verificationMessage: 'Internal verifier text must never be published',
        newCustomersOnly: false,
    }
}

function request(path: string[]): Promise<Response> {
    return GET(new Request('https://grabcaramel.com/index.md'), {
        params: Promise.resolve({ path }),
    })
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'))
    vi.mocked(listStoreCoupons)
        .mockReset()
        .mockResolvedValue({
            coupons: [
                coupon('visible', 'PUBLIC20'),
                coupon('hidden', 'HIDDEN20'),
            ],
            total: 2,
            facts,
            hasSupplierRow: true,
        })
})
afterEach(() => vi.useRealTimers())

describe('Markdown twin registry and Next configuration', () => {
    it('has exactly one path set for builders, rewrites and alternate headers', async () => {
        const paths = [
            ...Object.keys(staticPageBuilders),
            ...Object.keys(guidePageBuilders),
            '/coupons/:store',
        ]
        expect(new Set(paths).size).toBe(paths.length)
        expect([...MARKDOWN_TWIN_PATHS].sort()).toEqual(paths.sort())
        const rewrites = buildMarkdownRewrites()
        expect(rewrites).toHaveLength(MARKDOWN_TWIN_PATHS.length * 2)
        MARKDOWN_TWIN_PATHS.forEach((path, index) => {
            const alias = rewrites[index * 2]
            const negotiated = rewrites[index * 2 + 1]
            expect(
                getPathMatch(alias.source)(
                    markdownPath(path.replace(':store', 'nike.com')),
                ),
            ).toBeTruthy()
            expect(alias.destination).toBe(negotiated.destination)
            expect(negotiated.source).toBe(path)
            expect(negotiated.has).toEqual([
                { type: 'header', key: 'accept', value: MARKDOWN_ACCEPT },
            ])
        })
        expect(buildMarkdownHeaders()).toHaveLength(MARKDOWN_TWIN_PATHS.length)
        for (const path of MARKDOWN_TWIN_PATHS) {
            const example = path.replace(':store', 'nike.com')
            expect(
                buildMarkdownHeaders().some(rule =>
                    getPathMatch(rule.source)(example),
                ),
            ).toBe(true)
        }
        const configuredRewrites = await config.rewrites!()
        expect(configuredRewrites).toHaveProperty('beforeFiles', rewrites)
        const headers = await config.headers!()
        expect(headers).toEqual(expect.arrayContaining(buildMarkdownHeaders()))
        expect(headers).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    source: '/:path*',
                    headers: expect.arrayContaining([
                        { key: 'X-Content-Type-Options', value: 'nosniff' },
                    ]),
                }),
            ]),
        )
    })

    it.each([
        ['text/markdown', true],
        ['application/json, text/markdown;q=0.9', true],
        ['text/html,text/markdown', false],
        ['text/markdown,text/html', false],
        ['text/html,application/xhtml+xml,*/*;q=0.8', false],
        ['*/*', false],
        ['', false],
    ])('Accept %j negotiates Markdown: %s', (accept, expected) => {
        expect(new RegExp(`^${MARKDOWN_ACCEPT}$`).test(accept)).toBe(expected)
    })

    it('does not shadow prompt.md or route unregistered Markdown pages', () => {
        for (const path of [
            '/agent-setup/prompt.md',
            '/privacy.md',
            '/not-a-page.md',
            '/openapi.json',
            '/.well-known/mcp/server-card.json',
        ]) {
            expect(
                buildMarkdownRewrites().filter(rule =>
                    getPathMatch(rule.source)(path),
                ),
            ).toEqual([])
        }
        expect(
            buildMarkdownHeaders().find(rule =>
                getPathMatch(rule.source)('/coupons/nike.com'),
            )?.headers,
        ).toContainEqual({
            key: 'Link',
            value: '<https://grabcaramel.com/coupons/:store.md>; rel="alternate"; type="text/markdown"',
        })
    })

    it('never lets HTML alternate headers override a Markdown canonical', () => {
        for (const header of buildMarkdownHeaders()) {
            expect(header.missing).toEqual([
                { type: 'header', key: 'accept', value: MARKDOWN_ACCEPT },
            ])
            for (const path of MARKDOWN_TWIN_PATHS) {
                const twin = markdownPath(path.replace(':store', 'nike.com'))
                expect(getPathMatch(header.source)(twin)).toBe(false)
            }
        }
    })

    it('preserves canonical .md country domains and appends a separate twin suffix', () => {
        const aliases = buildMarkdownRewrites().filter(rule => !rule.has)
        expect(
            aliases.some(rule => getPathMatch(rule.source)('/coupons/jysk.md')),
        ).toBe(false)
        expect(
            aliases
                .map(rule => getPathMatch(rule.source)('/coupons/jysk.md.md'))
                .filter(Boolean),
        ).toEqual([{ store: 'jysk.md' }])
        expect(
            buildMarkdownHeaders().some(rule =>
                getPathMatch(rule.source)('/coupons/jysk.md'),
            ),
        ).toBe(true)
        expect(
            buildMarkdownHeaders().some(rule =>
                getPathMatch(rule.source)('/coupons/jysk.md.md'),
            ),
        ).toBe(false)
    })

    it('keeps production robots open for every registered twin', () => {
        const rules = robots().rules
        for (const rule of Array.isArray(rules) ? rules : [rules]) {
            const disallowed = Array.isArray(rule.disallow)
                ? rule.disallow
                : [rule.disallow]
            for (const path of MARKDOWN_TWIN_PATHS.map(markdownPath)) {
                expect(
                    disallowed.some(
                        prefix => prefix && path.startsWith(prefix),
                    ),
                ).toBe(false)
            }
        }
    })

    it.each([
        '/index.md',
        '/pricing.md',
        '/coupons/nike.com.md',
        '/agent-setup/prompt.md',
    ])('preserves combined canonical middleware redirects for %s', path => {
        const response = middleware(
            new NextRequest(`http://www.grabcaramel.com${path}/?test=1`, {
                headers: {
                    host: 'www.grabcaramel.com',
                    'cf-visitor': '{"scheme":"http"}',
                },
            }),
        )
        expect(response.status).toBe(308)
        expect(response.headers.get('location')).toBe(
            `https://grabcaramel.com${path}?test=1`,
        )
    })
})

describe('Markdown document responses', () => {
    it.each(['index', 'pricing', 'faq'])(
        'serves %s with canonical, negotiated caching and no noindex',
        async path => {
            const response = await request([path])
            const canonical = `https://grabcaramel.com${path === 'index' ? '/' : `/${path}`}`
            expect(response.status).toBe(200)
            expect(response.headers.get('content-type')).toBe(
                'text/markdown; charset=utf-8',
            )
            expect(response.headers.get('link')).toBe(
                `<${canonical}>; rel="canonical"`,
            )
            expect(response.headers.get('vary')).toBe('Accept')
            expect(response.headers.has('x-robots-tag')).toBe(false)
            const text = await response.text()
            expect(text.startsWith(`[Canonical HTML](${canonical})`)).toBe(true)
            expect(text).toMatch(/^# .+/m)
            expect(text).not.toMatch(/\]\(\//)
        },
    )

    it.each([
        ['unknown'],
        ['agent-setup', 'prompt.md'],
        ['coupons', 'co.uk'],
        ['coupons', 'not-a-store'],
    ])('returns 404 for %j', async (...path) => {
        expect((await request(path)).status).toBe(404)
        expect(listStoreCoupons).not.toHaveBeenCalled()
    })

    it('returns 404 for a noindex store with zero visible coupons', async () => {
        vi.mocked(listStoreCoupons).mockResolvedValue({
            coupons: [],
            total: 0,
            facts,
            hasSupplierRow: false,
        })
        expect((await request(['coupons', 'nike.com'])).status).toBe(404)
        expect(listStoreCoupons).toHaveBeenCalledExactlyOnceWith('nike.com', 20)
    })

    it('uses one catalog read, normalized canonical, visible codes, shared FAQ and public worked label', async () => {
        const response = await request(['coupons', 'www.nike.com'])
        const text = await response.text()
        expect(response.status).toBe(200)
        expect(response.headers.get('link')).toBe(
            '<https://grabcaramel.com/coupons/nike.com>; rel="canonical"',
        )
        expect(text).toContain('PUBLIC20')
        expect(text).not.toContain('HIDDEN20')
        expect(text).not.toContain('Internal verifier')
        expect(text).toContain('Worked 1h ago')
        expect(text).toContain('https://grabcaramel.com/apps')
        for (const item of buildStoreFaq({
            base: 'nike.com',
            total: 2,
            facts,
            topCoupon: { title: 'PUBLIC20 offer', code: 'PUBLIC20' },
            uk: false,
        })) {
            expect(text).toContain(markdownText(item.answer))
        }
        expect(listStoreCoupons).toHaveBeenCalledExactlyOnceWith('nike.com', 20)
    })

    it('shares a store read within a request and fetches again in the next request', async () => {
        const builder = createStoreMarkdownBuilder({
            listStoreCoupons,
            attachSignals: signalOverlay,
        })
        const [first, second] = await Promise.all([
            builder('nike.com'),
            builder('www.nike.com'),
        ])
        expect(first).toBe(second)
        expect(listStoreCoupons).toHaveBeenCalledTimes(1)
        await createStoreMarkdownBuilder({
            listStoreCoupons,
            attachSignals: signalOverlay,
        })('nike.com')
        expect(listStoreCoupons).toHaveBeenCalledTimes(2)
    })

    it('does not promote a hidden top code through the FAQ', async () => {
        vi.mocked(listStoreCoupons).mockResolvedValue({
            coupons: [coupon('hidden', 'HIDDEN20')],
            total: 1,
            facts,
            hasSupplierRow: true,
        })
        const response = await request(['coupons', 'nike.com'])
        expect(response.status).toBe(200) // Same catalog-count indexability as HTML.
        expect(await response.text()).not.toContain('HIDDEN20')
    })

    it('uses the card freshness/failure rules and escapes merchant text', () => {
        const publicCoupon = {
            ...coupon('visible', '[fake](https://evil.example)'),
            lastWorkedAt: '2026-10-01T00:00:00Z',
        }
        expect(couponMarkdown(publicCoupon)).not.toContain('Worked')
        expect(
            couponMarkdown({
                ...publicCoupon,
                lastWorkedAt: '2026-10-22T10:00:00Z',
                lastFailedAt: '2026-10-22T11:00:00Z',
                failCount: 2,
            }),
        ).not.toContain('Worked')
        expect(couponMarkdown(publicCoupon)).toContain(
            '\\[fake\\]\\(https://evil\\.example\\)',
        )
        expect(markdownText('<script>\n# heading')).toBe(
            '&lt;script&gt; \\# heading',
        )
    })

    it('writes the code as a code span an agent can copy verbatim', () => {
        expect(couponMarkdown(coupon('dash', 'AF-12-STAT'))).toContain(
            'Code: `AF-12-STAT`',
        )
        expect(markdownCode('[fake](https://evil.example)')).toBe(
            '`[fake](https://evil.example)`',
        )
        expect(markdownCode('A`B')).toBe('``A`B``')
        expect(markdownCode('`AB')).toBe('`` `AB ``')
    })
})
