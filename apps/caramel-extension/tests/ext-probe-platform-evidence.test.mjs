// "No platform marker found" was one sentence covering three different worlds,
// and the batch of 2026-08-14 shows the cost: 11 of 24 stores ended at
// `INCONCLUSIVE_SEED` with that sentence, no cart, no apply attempt, no verdict
// for the repair loop to act on. Three of them — kizik.com,
// peterthomasroth.com, venus.com — are plain Shopify whose `/products.json`
// answered `200` from the same machine minutes later, and kizik detected
// `shopify` cleanly on a re-run. The detector was right about the document it
// was shown and wrong about which document that was, and the report could not
// say so.
//
// What is pinned here is the difference between the three worlds:
//   - the store answered, and the answer is "not this platform"  (404)
//   - the store refused to answer                                (403/429/…)
//   - we were looking at the wrong page                          (non-2xx nav)
//
// Everything runs against a stubbed `globalThis.fetch`. No store is touched.
import { afterEach, describe, expect, it } from 'vitest'
import {
    capabilityProbeOrder,
    CART_API_PROBES,
    describeDocumentInPage,
    detectPlatformInPage,
    normalizePlatformHint,
    probeCartApiInPage,
    resolvePlatform,
    SEEDABLE_PLATFORMS,
    shouldRelookAtDocument,
} from '../../../tools/ext-probe/seed.mjs'

const originalFetch = globalThis.fetch
afterEach(() => {
    globalThis.fetch = originalFetch
    document.body.innerHTML = ''
    document.body.className = ''
    document.head.innerHTML = ''
    delete window.Shopify
    delete window.BCData
    delete window.wc_add_to_cart_params
})

/** A store that answers `answers[path-prefix]` and 404s everything else. */
function stubEndpoints(answers) {
    const seen = []
    globalThis.fetch = async url => {
        const u = String(url)
        seen.push(u)
        for (const [prefix, reply] of Object.entries(answers))
            if (u.startsWith(prefix)) {
                if (reply instanceof Error) throw reply
                return {
                    ok: reply.status >= 200 && reply.status < 300,
                    status: reply.status,
                    json: async () => {
                        if (reply.json === undefined)
                            throw new SyntaxError('Unexpected token <')
                        return reply.json
                    },
                }
            }
        return { ok: false, status: 404, json: async () => ({}) }
    }
    return seen
}

const shopifyFeed = { status: 200, json: { products: [{ id: 1 }] } }

describe('a store that serves its assets from its OWN host is still Shopify', () => {
    it('detects the first-party /cdn/shop asset path', () => {
        // Counted on peterthomasroth.com, 2026-08-14: 92 first-party
        // `/cdn/shop/` tags against 4 on cdn.shopify.com. A store that drops
        // the preconnect carries no cdn.shopify.com tag at all.
        document.head.innerHTML =
            '<script src="//www.example.com/cdn/shop/t/426/assets/theme.js"></script>'
        expect(detectPlatformInPage()).toEqual({
            platform: 'shopify',
            signal: 'first-party /cdn/shop asset',
        })
    })

    it('detects the shopifycloud module path the same way', () => {
        document.head.innerHTML =
            '<script src="//x.com/cdn/shopifycloud/shop-js/modules/v2/loader.js"></script>'
        expect(detectPlatformInPage().platform).toBe('shopify')
    })

    it('still prefers the global when both are present', () => {
        window.Shopify = { shop: 'x.myshopify.com' }
        document.head.innerHTML =
            '<script src="//x.com/cdn/shop/t/1/assets/a.js"></script>'
        expect(detectPlatformInPage().signal).toBe('window.Shopify.shop')
    })
})

describe('when markup finds nothing, the platform’s own endpoint is asked', () => {
    it('names the platform whose feed answered with the shape that platform returns', async () => {
        stubEndpoints({ '/products.json': shopifyFeed })
        const out = await probeCartApiInPage({
            order: SEEDABLE_PLATFORMS,
            endpoints: CART_API_PROBES,
        })

        expect(out.platform).toBe('shopify')
        expect(out.attempts.at(-1)).toMatchObject({
            platform: 'shopify',
            status: 200,
            ok: true,
            shape: 'products-array',
        })
    })

    it('stops asking once one endpoint answers — the rest are never fetched', async () => {
        const seen = stubEndpoints({ '/products.json': shopifyFeed })
        await probeCartApiInPage({
            order: ['shopify', 'woocommerce', 'bigcommerce'],
            endpoints: CART_API_PROBES,
        })
        expect(seen).toEqual(['/products.json?limit=1'])
    })

    it('a 200 of the WRONG shape is not that platform', async () => {
        // Measured on 5 of 167 stores (publiclands.com, wearpact.com,
        // gamefly.com, secretsales.com, strawberrynet.com): an SPA catch-all
        // answers 200 with HTML. A status-only check names every one of them
        // the wrong platform and then seeds with someone else's endpoints.
        stubEndpoints({ '/products.json': { status: 200 } })
        const out = await probeCartApiInPage({
            order: ['shopify'],
            endpoints: CART_API_PROBES,
        })

        expect(out.platform).toBe('unknown')
        expect(out.attempts[0]).toMatchObject({
            status: 200,
            shape: 'not-json',
        })
    })

    it('a 200 of the wrong JSON shape is not that platform either', async () => {
        stubEndpoints({ '/products.json': { status: 200, json: { ok: true } } })
        const out = await probeCartApiInPage({
            order: ['shopify'],
            endpoints: CART_API_PROBES,
        })
        expect(out.attempts[0].shape).toBe('unexpected-json')
        expect(out.platform).toBe('unknown')
    })

    it('records a network failure as an error, never as an absent endpoint', async () => {
        stubEndpoints({ '/products.json': new TypeError('Failed to fetch') })
        const out = await probeCartApiInPage({
            order: ['shopify'],
            endpoints: CART_API_PROBES,
        })
        expect(out.attempts[0].status).toBeNull()
        expect(out.attempts[0].error).toMatch(/Failed to fetch/)
    })

    it('every probe keeps its own status, so the trail is readable afterwards', async () => {
        stubEndpoints({
            '/products.json': { status: 403 },
            '/wp-json': { status: 404 },
            '/api/storefront': { status: 503 },
        })
        const out = await probeCartApiInPage({
            order: SEEDABLE_PLATFORMS,
            endpoints: CART_API_PROBES,
        })
        expect(out.attempts.map(a => [a.platform, a.status])).toEqual([
            ['shopify', 403],
            ['woocommerce', 404],
            ['bigcommerce', 503],
        ])
    })
})

const noMarkup = { platform: 'unknown', signal: 'no platform marker found' }
const attemptsOf = statuses =>
    statuses.map(([platform, status]) => ({
        platform,
        endpoint: CART_API_PROBES[platform].path,
        status,
        ok: false,
        shape: null,
        error: null,
    }))

describe('a blocked marker is reported differently from an absent one', () => {
    it('ABSENT: the store answered 404 everywhere — it is not one of ours', () => {
        const out = resolvePlatform({
            markup: noMarkup,
            capability: {
                platform: 'unknown',
                signal: 'no cart API answered',
                attempts: attemptsOf([
                    ['shopify', 404],
                    ['woocommerce', 404],
                    ['bigcommerce', 404],
                ]),
            },
            hint: null,
        })

        expect(out.platform).toBe('unknown')
        expect(out.blocked).toBe(false)
        expect(out.signal).toContain('shopify 404')
        expect(out.signal).not.toContain('refused')
    })

    it('BLOCKED: every endpoint refused — that is not evidence about the platform', () => {
        const out = resolvePlatform({
            markup: noMarkup,
            capability: {
                platform: 'unknown',
                signal: 'no cart API answered',
                attempts: attemptsOf([
                    ['shopify', 403],
                    ['woocommerce', 429],
                    ['bigcommerce', 503],
                ]),
            },
            hint: null,
        })

        expect(out.blocked).toBe(true)
        expect(out.signal).toContain(
            'NOT evidence the store is on another platform',
        )
    })

    it('one honest 404 among refusals is enough to stop calling it blocked', () => {
        const out = resolvePlatform({
            markup: noMarkup,
            capability: {
                platform: 'unknown',
                signal: 'no cart API answered',
                attempts: attemptsOf([
                    ['shopify', 403],
                    ['woocommerce', 404],
                    ['bigcommerce', 403],
                ]),
            },
            hint: null,
        })
        expect(out.blocked).toBe(false)
    })

    it('no capability probe at all is not "blocked" — nothing was refused', () => {
        const out = resolvePlatform({
            markup: noMarkup,
            capability: null,
            hint: null,
        })
        expect(out.blocked).toBe(false)
        expect(out.signal).toBe('no platform marker found')
    })
})

describe('who decided, and what a hint may and may not do', () => {
    it('markup decides and is recorded as the source', () => {
        const out = resolvePlatform({
            markup: { platform: 'shopify', signal: 'window.Shopify.shop' },
            capability: null,
            hint: null,
        })
        expect(out).toMatchObject({
            platform: 'shopify',
            source: 'markup',
            hintAgreed: null,
        })
    })

    it('the hint is HONOURED when markup is blind and the endpoint confirms', () => {
        const out = resolvePlatform({
            markup: { platform: 'unknown', signal: 'no platform marker found' },
            capability: {
                platform: 'woocommerce',
                signal: 'woocommerce answered /wp-json/... with array',
                attempts: [{ platform: 'woocommerce', status: 200, ok: true }],
            },
            hint: 'woocommerce',
        })
        expect(out).toMatchObject({
            platform: 'woocommerce',
            source: 'capability',
            hint: 'woocommerce',
            hintAgreed: true,
        })
    })

    it('the hint asks its own endpoint FIRST and the others still follow', () => {
        expect(capabilityProbeOrder('bigcommerce')).toEqual([
            'bigcommerce',
            'shopify',
            'woocommerce',
        ])
        expect(capabilityProbeOrder(null)).toEqual([...SEEDABLE_PLATFORMS])
        expect(capabilityProbeOrder('sfcc')).toEqual([...SEEDABLE_PLATFORMS])
    })

    it('a hint NEVER overrides markup — a replatformed store is seeded as it is today', () => {
        // The hint comes from a config discovered at some point in the past.
        // The global comes from the bundle the store is serving right now.
        const out = resolvePlatform({
            markup: { platform: 'bigcommerce', signal: 'window.BCData' },
            capability: null,
            hint: 'shopify',
        })
        expect(out.platform).toBe('bigcommerce')
        expect(out.source).toBe('markup')
        expect(out.hintAgreed).toBe(false)
    })

    it('a hint alone seeds NOTHING — with no confirming endpoint the answer stays unknown', () => {
        const out = resolvePlatform({
            markup: { platform: 'unknown', signal: 'no platform marker found' },
            capability: {
                platform: 'unknown',
                signal: 'no cart API answered',
                attempts: [{ platform: 'shopify', status: 404, ok: false }],
            },
            hint: 'shopify',
        })
        expect(out.platform).toBe('unknown')
        expect(out.hintAgreed).toBe(false)
    })

    it('an unrecognised hint THROWS rather than being quietly dropped', () => {
        // Dropped silently, the caller reads the resulting detection failure as
        // a fact about the store.
        expect(() => normalizePlatformHint('salesforce')).toThrow(
            /unknown --platform-hint/,
        )
        expect(normalizePlatformHint(' Shopify ')).toBe('shopify')
        expect(normalizePlatformHint(undefined)).toBeNull()
        expect(normalizePlatformHint('')).toBeNull()
    })
})

describe('the second look is taken on evidence, not on disappointment', () => {
    const unknown = { platform: 'unknown', blocked: false }

    it('a non-2xx navigation means we may not have been on the store', () => {
        expect(
            shouldRelookAtDocument({
                navigationStatus: 403,
                resolved: unknown,
            }),
        ).toBe(true)
        expect(
            shouldRelookAtDocument({
                navigationStatus: 503,
                resolved: unknown,
            }),
        ).toBe(true)
    })

    it('all endpoints refused means the same thing', () => {
        expect(
            shouldRelookAtDocument({
                navigationStatus: 200,
                resolved: { platform: 'unknown', blocked: true },
            }),
        ).toBe(true)
    })

    it('a store that simply is not ours does NOT pay for a second page load', () => {
        // 48 of the 167 stores measured on 2026-08-14 carry no marker and no
        // cart API at all. Reloading each of them every run buys nothing.
        expect(
            shouldRelookAtDocument({
                navigationStatus: 200,
                resolved: unknown,
            }),
        ).toBe(false)
    })

    it('a platform we DID name is never re-looked at', () => {
        expect(
            shouldRelookAtDocument({
                navigationStatus: 403,
                resolved: { platform: 'shopify', blocked: false },
            }),
        ).toBe(false)
    })

    it('an unknown navigation status is treated as "we do not know what we saw"', () => {
        expect(
            shouldRelookAtDocument({
                navigationStatus: null,
                resolved: unknown,
            }),
        ).toBe(true)
    })
})

describe('the report says which document the detection ran against', () => {
    it('carries the url, title, size and readyState', () => {
        document.title = 'Just a moment...'
        const out = describeDocumentInPage()
        expect(out.title).toBe('Just a moment...')
        expect(out.url).toBe(location.href)
        expect(out.htmlBytes).toBeGreaterThan(0)
        expect(typeof out.readyState).toBe('string')
    })
})
