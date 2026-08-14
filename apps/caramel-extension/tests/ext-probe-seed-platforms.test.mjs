// The seeder speaks three platforms, and the store-safety cap holds in all of
// them.
//
// The probe's first question on any store is "is there a cart?", and until
// 2026-08-14 only Shopify could answer it: every WooCommerce and BigCommerce
// store fell out at `INCONCLUSIVE_SEED`, so the repair loop behind ext-QA never
// got a verdict to act on. Widening that path is only safe if two things stay
// true — the platform is named from the store's OWN markup rather than from a
// per-store list, and a platform that cannot be seeded abandons honestly
// instead of inventing a cart.
//
// Everything here runs against a stubbed `globalThis.fetch`. No store is
// touched, which is the same discipline as ext-probe-safety.test.mjs.
import { afterEach, describe, expect, it } from 'vitest'
import {
    detectPlatformInPage,
    MAX_REJECTED_ADDS,
    readCartStateInPage,
    SEEDABLE_PLATFORMS,
    seedBigCommerceCartInPage,
    seedersByPlatform,
    seedShopifyCartInPage,
    seedWooCommerceCartInPage,
} from '../../../tools/ext-probe/seed.mjs'

const originalFetch = globalThis.fetch
afterEach(() => {
    globalThis.fetch = originalFetch
    document.body.innerHTML = ''
    document.body.className = ''
    delete window.Shopify
    delete window.BCData
    delete window.wc_add_to_cart_params
})

describe('the platform is named from the store, never from a list of stores', () => {
    it('reads Shopify from the global its own bundle sets', () => {
        window.Shopify = { shop: 'x.myshopify.com' }
        expect(detectPlatformInPage()).toEqual({
            platform: 'shopify',
            signal: 'window.Shopify.shop',
        })
    })

    it('reads WooCommerce from the params WooCommerce core localises', () => {
        window.wc_add_to_cart_params = { ajax_url: '/?wc-ajax=%%endpoint%%' }
        expect(detectPlatformInPage().platform).toBe('woocommerce')
    })

    it('reads BigCommerce from the Stencil bootstrap object', () => {
        window.BCData = { csrf_token: 'x' }
        expect(detectPlatformInPage().platform).toBe('bigcommerce')
    })

    it('falls back to markup when no global is set', () => {
        document.body.innerHTML =
            '<script src="https://x.com/wp-content/plugins/woocommerce/assets/js/a.js"></script>'
        expect(detectPlatformInPage().platform).toBe('woocommerce')
    })

    it('says "unknown" rather than guessing, and names why', () => {
        const out = detectPlatformInPage()
        expect(out.platform).toBe('unknown')
        expect(SEEDABLE_PLATFORMS).not.toContain(out.platform)
        expect(out.signal).toBe('no platform marker found')
    })

    it('a global outranks a stray CDN reference to another platform', () => {
        // A Woo store embedding a Shopify buy-button script must still be
        // seeded the Woo way; strongest-signal-first is what decides that.
        window.wc_add_to_cart_params = {}
        document.body.innerHTML =
            '<script src="https://cdn.shopify.com/buy-button.js"></script>'
        expect(detectPlatformInPage().platform).toBe('woocommerce')
    })

    it('every seedable platform has a seeder, and nothing else does', () => {
        const seeders = seedersByPlatform()
        expect(Object.keys(seeders).toSorted()).toEqual(
            SEEDABLE_PLATFORMS.toSorted(),
        )
        expect(seeders.unknown).toBeUndefined()
        expect(seeders.shopify).toBe(seedShopifyCartInPage)
        expect(seeders.woocommerce).toBe(seedWooCommerceCartInPage)
        expect(seeders.bigcommerce).toBe(seedBigCommerceCartInPage)
    })
})

// ── WooCommerce ──────────────────────────────────────────────────────────────
// Shape measured on alphaterritory.com, 2026-08-14: the Store API list is all
// `variable` products, `add-item` answers 401 without a Nonce header, and the
// nonce arrives on the cart GET the seeder already makes for its baseline.
function stubWooStore({
    products,
    addStatus = 201,
    nonce = 'abc123',
    cartStatus = 200,
} = {}) {
    const counts = { adds: 0, cartReads: 0 }
    let items = 0
    globalThis.fetch = async (url, init) => {
        const u = String(url)
        if (u.startsWith('/wp-json/wc/store/v1/products'))
            return { ok: true, status: 200, json: async () => products }
        if (u === '/wp-json/wc/store/v1/cart') {
            counts.cartReads++
            return {
                ok: cartStatus === 200,
                status: cartStatus,
                headers: { get: name => (name === 'nonce' ? nonce : null) },
                json: async () => ({ items_count: items }),
            }
        }
        if (u === '/wp-json/wc/store/v1/cart/add-item') {
            counts.adds++
            counts.lastNonce = init?.headers?.Nonce
            counts.lastBody = JSON.parse(init.body)
            const ok = addStatus >= 200 && addStatus < 300
            if (ok) items++
            return { ok, status: addStatus, json: async () => ({}) }
        }
        throw new Error(`unexpected request: ${u}`)
    }
    return counts
}

const wooVariable = (n = 10) =>
    Array.from({ length: n }, (_, i) => ({
        id: 1000 + i,
        name: `Shorts ${i}`,
        type: 'variable',
        is_purchasable: true,
        is_in_stock: true,
        variations: [
            { id: 2000 + i, attributes: [{ name: 'Size', value: 'M' }] },
            { id: 3000 + i, attributes: [{ name: 'Size', value: 'L' }] },
        ],
    }))

describe('WooCommerce is seeded through the Store API', () => {
    it('adds a variable product by its PARENT id plus the chosen variation', async () => {
        // The reason this path is general at all: a Woo catalogue is mostly
        // variable products, which the classic `?add-to-cart=` handler cannot
        // reach without reconstructing the theme's own attribute field names.
        const counts = stubWooStore({ products: wooVariable() })
        const out = await seedWooCommerceCartInPage()

        expect(out.ok).toBe(true)
        expect(counts.adds).toBe(1)
        expect(counts.lastBody).toEqual({
            id: 1000,
            quantity: 1,
            variation: [{ attribute: 'Size', value: 'M' }],
        })
        expect(out.detail).toContain('added Shorts 0')
    })

    it('sends the nonce the cart GET handed out — without it the endpoint 401s', async () => {
        const counts = stubWooStore({ products: wooVariable(), nonce: 'n-42' })
        await seedWooCommerceCartInPage()
        expect(counts.lastNonce).toBe('n-42')
    })

    it('sends NO add at all when the cart served no nonce', async () => {
        const counts = stubWooStore({ products: wooVariable(), nonce: null })
        const out = await seedWooCommerceCartInPage()

        expect(counts.adds).toBe(0)
        expect(out.ok).toBe(false)
        expect(out.detail).toMatch(/no Nonce header/i)
    })

    it('sends NO add when the cart cannot be read — an unverifiable add is not attempted', async () => {
        const counts = stubWooStore({
            products: wooVariable(),
            cartStatus: 403,
        })
        const out = await seedWooCommerceCartInPage()

        expect(counts.adds).toBe(0)
        expect(out.detail).toMatch(/cannot verify an add/)
    })

    it('stops after 5 rejected adds, exactly like the Shopify path', async () => {
        const counts = stubWooStore({
            products: wooVariable(20),
            addStatus: 429,
        })
        const out = await seedWooCommerceCartInPage({
            maxRejectedAdds: MAX_REJECTED_ADDS,
        })

        expect(counts.adds).toBe(5)
        expect(out.rejectedAdds).toBe(5)
        expect(out.ok).toBe(false)
        expect(out.detail).toContain('stopping before we rate-limit the store')
    })

    it('RED-PROOF: uncapped, the same fixture fires 40 adds', async () => {
        const counts = stubWooStore({
            products: wooVariable(20),
            addStatus: 429,
        })
        await seedWooCommerceCartInPage({ maxRejectedAdds: Infinity })
        expect(counts.adds).toBe(40)
        expect(counts.adds).toBeGreaterThan(MAX_REJECTED_ADDS)
    })

    it('abandons honestly when the Store API is not there', async () => {
        globalThis.fetch = async () => ({ ok: false, status: 404 })
        const out = await seedWooCommerceCartInPage()
        expect(out.ok).toBe(false)
        expect(out.productFeedOk).toBe(false)
        expect(out.detail).toBe('store-api products 404')
    })

    it('does not try a product the store says is unpurchasable or out of stock', async () => {
        const counts = stubWooStore({
            products: [
                {
                    id: 1,
                    name: 'gone',
                    type: 'simple',
                    is_purchasable: true,
                    is_in_stock: false,
                    variations: [],
                },
                {
                    id: 2,
                    name: 'catalog only',
                    type: 'simple',
                    is_purchasable: false,
                    is_in_stock: true,
                    variations: [],
                },
            ],
        })
        const out = await seedWooCommerceCartInPage()

        expect(counts.adds).toBe(0)
        expect(out.candidates).toBe(0)
        expect(out.detail).toMatch(/no purchasable in-stock product/)
    })

    it('reads the cart back rather than trusting the add status', async () => {
        // A 201 whose item never appears is not a seeded cart. Counting it as
        // one would put every downstream verdict on a cart that is not there.
        globalThis.fetch = async (url, init) => {
            const u = String(url)
            if (u.startsWith('/wp-json/wc/store/v1/products'))
                return {
                    ok: true,
                    status: 200,
                    json: async () => wooVariable(1),
                }
            if (u === '/wp-json/wc/store/v1/cart')
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => 'n' },
                    json: async () => ({ items_count: 0 }),
                }
            if (u === '/wp-json/wc/store/v1/cart/add-item' && init)
                return { ok: true, status: 201, json: async () => ({}) }
            throw new Error(`unexpected request: ${u}`)
        }
        const out = await seedWooCommerceCartInPage()
        expect(out.ok).toBe(false)
        expect(out.rejectedAdds).toBeGreaterThan(0)
    })
})

// ── BigCommerce ──────────────────────────────────────────────────────────────
// Shape measured on a1supplements.com, 2026-08-14: product ids come off the
// storefront markup, and products carrying required options answer
// `422 This product has options, variant ID is required`.
function stubBigCommerceStore({ rejectUntil = 0, cartsStatus = 200 } = {}) {
    const counts = { adds: 0 }
    let items = 0
    globalThis.fetch = async (url, init) => {
        const u = String(url)
        if (
            u === '/api/storefront/carts' &&
            (!init || init.method !== 'POST')
        ) {
            return {
                ok: cartsStatus === 200,
                status: cartsStatus,
                json: async () =>
                    items
                        ? [
                              {
                                  id: 'cart-1',
                                  lineItems: {
                                      physicalItems: [{ quantity: items }],
                                  },
                              },
                          ]
                        : [],
            }
        }
        if (u === '/api/storefront/carts' && init?.method === 'POST') {
            counts.adds++
            counts.lastBody = JSON.parse(init.body)
            if (counts.adds <= rejectUntil)
                return { ok: false, status: 422, json: async () => ({}) }
            items++
            return { ok: true, status: 201, json: async () => ({}) }
        }
        throw new Error(`unexpected request: ${u}`)
    }
    return counts
}

function paintProductCards(ids) {
    document.body.innerHTML = ids
        .map(id => `<article data-product-id="${id}"></article>`)
        .join('')
}

describe('BigCommerce is seeded through the Storefront API', () => {
    it('takes product ids off the storefront markup and adds the first the store accepts', async () => {
        paintProductCards([2183, 1561, 6558])
        const counts = stubBigCommerceStore({ rejectUntil: 2 })
        const out = await seedBigCommerceCartInPage()

        expect(out.ok).toBe(true)
        expect(out.candidates).toBe(3)
        // The two 422s are real rejections — "this product has options" — not
        // a broken seeder, and they are reported as what they are.
        expect(out.rejectedAdds).toBe(2)
        expect(counts.lastBody).toEqual({
            lineItems: [{ quantity: 1, productId: 6558 }],
        })
    })

    it('abandons honestly when the markup carries no product id', async () => {
        const counts = stubBigCommerceStore()
        const out = await seedBigCommerceCartInPage()

        expect(counts.adds).toBe(0)
        expect(out.ok).toBe(false)
        expect(out.productFeedOk).toBe(false)
        expect(out.detail).toMatch(/no product id in the storefront markup/)
    })

    it('sends NO add when the cart endpoint cannot be read', async () => {
        paintProductCards([1])
        const counts = stubBigCommerceStore({ cartsStatus: 403 })
        const out = await seedBigCommerceCartInPage()

        expect(counts.adds).toBe(0)
        expect(out.detail).toMatch(/cannot verify an add/)
    })

    it('stops after 5 rejected adds', async () => {
        paintProductCards([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        const counts = stubBigCommerceStore({ rejectUntil: 99 })
        const out = await seedBigCommerceCartInPage()

        expect(counts.adds).toBe(MAX_REJECTED_ADDS)
        expect(out.detail).toContain('stopping before we rate-limit the store')
    })
})

describe('the cart is read through the endpoint the platform publishes', () => {
    it('WooCommerce items_count', async () => {
        globalThis.fetch = async url => {
            expect(String(url)).toBe('/wp-json/wc/store/v1/cart')
            return {
                ok: true,
                status: 200,
                json: async () => ({ items_count: 2 }),
            }
        }
        await expect(readCartStateInPage('woocommerce')).resolves.toEqual({
            cartApiOk: true,
            // Not `false`: there was no /cart.js in this run to have an opinion
            // about, and "not observed" is never written as "did not happen".
            cartJsOk: null,
            itemCount: 2,
            detail: '',
        })
    })

    it('BigCommerce line-item quantities across every bucket', async () => {
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => [
                {
                    lineItems: {
                        physicalItems: [{ quantity: 2 }],
                        digitalItems: [{ quantity: 1 }],
                        giftCertificates: [{}],
                    },
                },
            ],
        })
        const out = await readCartStateInPage('bigcommerce')
        expect(out.cartApiOk).toBe(true)
        expect(out.itemCount).toBe(4)
    })

    it('a platform with no cart endpoint is reported, never assumed empty', async () => {
        // `itemCount: 0` would be read one step later as "the cart was empty,
        // so silence is correct" — a verdict about the store, invented out of
        // the probe not knowing where to look.
        globalThis.fetch = async () => {
            throw new Error('should not be called')
        }
        const out = await readCartStateInPage('unknown')
        expect(out.cartApiOk).toBe(false)
        expect(out.itemCount).toBeNull()
        expect(out.detail).toMatch(/no cart endpoint known/)
    })
})
