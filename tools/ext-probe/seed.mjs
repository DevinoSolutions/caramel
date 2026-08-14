// The functions the probe runs INSIDE the store page.
//
// Every one of them is deliberately self-contained — no imports, no
// module-scope references, no closures. Playwright serialises a function by its
// source text, so anything captured from this module's scope would be
// `undefined` by the time it runs in the page. The same property is what makes
// them testable: with `globalThis.fetch` stubbed they run unchanged in Node,
// which is how the seed cap below is pinned in CI without touching a real
// store.
//
// The seeder is per-PLATFORM, never per-store. A store-shaped special case
// would be a config we could never verify — the platform's own documented
// cart mechanism is a contract thousands of stores share, so a fix here is a
// fix everywhere. A platform we cannot seed reports that honestly and the
// probe abandons: a faked cart would turn every downstream verdict into
// fiction.

/**
 * How many consecutive rejected adds any seeder tolerates before it gives up.
 * Exported so a caller can read the number, NOT so the page function can — see
 * the self-containment note above.
 */
export const MAX_REJECTED_ADDS = 5

/** Products fetched per seed attempt. */
export const DEFAULT_PRODUCT_LIMIT = 30

/**
 * The platforms whose cart mechanism this file implements. `detectPlatformInPage`
 * returns one of these or `'unknown'`; `unknown` is an honest abandon, never a
 * reason to guess.
 */
export const SEEDABLE_PLATFORMS = Object.freeze([
    'shopify',
    'woocommerce',
    'bigcommerce',
])

/**
 * Which seeder speaks for which platform. The probe dispatches through this
 * map so adding a platform is one entry plus one function — and so a platform
 * with no seeder cannot silently fall through to a Shopify-shaped attempt.
 *
 * @returns {Record<string, (options: object) => Promise<object>>}
 */
export function seedersByPlatform() {
    return {
        shopify: seedShopifyCartInPage,
        woocommerce: seedWooCommerceCartInPage,
        bigcommerce: seedBigCommerceCartInPage,
    }
}

/**
 * Name the e-commerce platform from markup the platform itself emits — never
 * from the hostname. A per-store list would rot the day a store replatformed,
 * and would be wrong for the 2,700th store the moment it was written.
 *
 * Strongest signals first: a global the platform's own bundle sets outranks a
 * CDN URL, which outranks a body class a theme could have copied.
 *
 * @returns {{platform: string, signal: string}}
 */
export function detectPlatformInPage() {
    const has = sel => {
        try {
            return !!document.querySelector(sel)
        } catch {
            // An invalid selector here would be a bug in THIS list, not a
            // property of the store; treat it as "no signal" and let the
            // remaining probes speak.
            return false
        }
    }
    const bodyClass = (document.body && document.body.className) || ''
    const probes = [
        // Shopify
        [
            'shopify',
            'window.Shopify.shop',
            () =>
                !!(
                    window.Shopify &&
                    (window.Shopify.shop || window.Shopify.routes)
                ),
        ],
        // WooCommerce — these globals are localised by WooCommerce core itself.
        [
            'woocommerce',
            'window.wc_add_to_cart_params',
            () =>
                !!(
                    window.wc_add_to_cart_params ||
                    window.woocommerce_params ||
                    window.wc_cart_fragments_params
                ),
        ],
        // BigCommerce — Stencil bootstraps this on every storefront page.
        ['bigcommerce', 'window.BCData', () => !!window.BCData],
        [
            'shopify',
            'cdn.shopify.com asset',
            () =>
                has(
                    'script[src*="cdn.shopify.com"], link[href*="cdn.shopify.com"]',
                ),
        ],
        [
            'woocommerce',
            'woocommerce plugin asset',
            () =>
                has(
                    'script[src*="/plugins/woocommerce/"], link[href*="/plugins/woocommerce/"]',
                ),
        ],
        [
            'bigcommerce',
            'bigcommerce cdn asset',
            () =>
                has(
                    'script[src*="bigcommerce.com"], link[href*="bigcommerce.com"]',
                ),
        ],
        [
            'woocommerce',
            'body.woocommerce class',
            () => /(^|\s)woocommerce(-page)?(\s|$)/.test(String(bodyClass)),
        ],
        [
            'bigcommerce',
            'cart.php form action',
            () => has('form[action*="/cart.php"]'),
        ],
    ]
    for (const [platform, signal, test] of probes) {
        let hit = false
        try {
            hit = test()
        } catch (e) {
            return {
                platform: 'unknown',
                signal: `detection threw on ${signal}: ${String(e).slice(0, 60)}`,
            }
        }
        if (hit) return { platform, signal }
    }
    return { platform: 'unknown', signal: 'no platform marker found' }
}

/**
 * Seed a Shopify cart the way the platform itself would: read the public
 * product feed, then add the first available variant that the store accepts.
 *
 * `productsJsonOk` is the literal Shopify leg and is reported alongside the
 * platform-neutral `productFeedOk` so runs recorded before the seeder widened
 * stay comparable field-for-field.
 *
 * @param {{maxRejectedAdds?: number, productLimit?: number}} options
 * @returns {Promise<{ok: boolean, detail: string, rejectedAdds: number, adds: number, productFeedOk: boolean, productsJsonOk: boolean}>}
 */
export async function seedShopifyCartInPage(options) {
    const maxRejectedAdds = (options && options.maxRejectedAdds) || 5
    const productLimit = (options && options.productLimit) || 30
    const out = {
        ok: false,
        detail: '',
        rejectedAdds: 0,
        adds: 0,
        productFeedOk: false,
        productsJsonOk: false,
    }
    try {
        const res = await fetch(`/products.json?limit=${productLimit}`)
        out.productsJsonOk = !!res.ok
        out.productFeedOk = !!res.ok
        if (!res.ok) {
            out.detail = `products.json ${res.status}`
            return out
        }
        const { products } = await res.json()
        // Capped: this loop once fired 154 POSTs into brooklinen, got 286
        // rate-limit 429s, and the store's OWN scripts choking on the 429
        // HTML pages was then mis-filed as an extension defect. A store
        // that rejects 5 adds in a row isn't going to accept the 6th.
        let failed = 0
        for (const p of products || []) {
            for (const v of p.variants || []) {
                if (!v.available) continue
                out.adds++
                const add = await fetch('/cart/add.js', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: v.id, quantity: 1 }),
                })
                if (add.ok) {
                    out.ok = true
                    out.detail = `added ${p.title} / ${v.id}`
                    return out
                }
                out.rejectedAdds = ++failed
                if (failed >= maxRejectedAdds) {
                    out.detail = `no add accepted after ${failed} tries (last ${add.status}) — stopping before we rate-limit the store`
                    return out
                }
            }
        }
        out.detail = 'no available variant'
        return out
    } catch (e) {
        out.detail = `seed failed: ${String(e).slice(0, 80)}`
        return out
    }
}

/**
 * Seed a WooCommerce cart through the Store API, the same interface the Blocks
 * cart in WooCommerce core uses: `/wc/store/v1/products` to list what is
 * purchasable, `/wc/store/v1/cart/add-item` to add it.
 *
 * Two things about that endpoint were measured, not assumed (alphaterritory.com,
 * 2026-08-14). It answers `401 woocommerce_rest_missing_nonce` without a
 * `Nonce` header, and the nonce is handed out in the `Nonce` RESPONSE header of
 * the cart GET this function already makes for its baseline count — so the
 * nonce costs no extra request. And it takes a variable product as the PARENT
 * id plus a `variation` list, which is what makes this path general: most Woo
 * catalogues are variable products, and the classic `?add-to-cart=` form handler
 * needs the theme's own `attribute_*` field names reconstructed to reach them.
 *
 * Success is confirmed by re-reading the cart rather than trusting the add's
 * status — the same independent-witness rule the rest of the probe lives by.
 *
 * @param {{maxRejectedAdds?: number, productLimit?: number}} options
 * @returns {Promise<{ok: boolean, detail: string, rejectedAdds: number, adds: number, productFeedOk: boolean, candidates: number}>}
 */
export async function seedWooCommerceCartInPage(options) {
    const maxRejectedAdds = (options && options.maxRejectedAdds) || 5
    const productLimit = (options && options.productLimit) || 30
    const out = {
        ok: false,
        detail: '',
        rejectedAdds: 0,
        adds: 0,
        productFeedOk: false,
        candidates: 0,
    }
    // Declared inside so the whole function survives serialisation into the
    // page as one self-contained unit.
    const readCart = async () => {
        const res = await fetch('/wp-json/wc/store/v1/cart', {
            headers: { accept: 'application/json' },
        })
        if (!res.ok)
            return { ok: false, count: null, nonce: null, status: res.status }
        const cart = await res.json()
        return {
            ok: true,
            count:
                typeof cart.items_count === 'number' ? cart.items_count : null,
            nonce: res.headers.get('nonce'),
            status: res.status,
        }
    }
    try {
        const feed = await fetch(
            `/wp-json/wc/store/v1/products?per_page=${productLimit}`,
            { headers: { accept: 'application/json' } },
        )
        out.productFeedOk = !!feed.ok
        if (!feed.ok) {
            out.detail = `store-api products ${feed.status}`
            return out
        }
        const products = await feed.json()
        // One entry per thing that can actually be added: a simple product is
        // itself, a variable product is its parent id once per variation.
        const candidates = []
        for (const p of Array.isArray(products) ? products : []) {
            if (!p || !p.is_purchasable || !p.is_in_stock) continue
            if (typeof p.id !== 'number') continue
            const name = String(p.name || p.id)
            const variations = Array.isArray(p.variations) ? p.variations : []
            if (!variations.length) {
                candidates.push({ id: p.id, name, variation: null })
                continue
            }
            for (const v of variations)
                candidates.push({
                    id: p.id,
                    name: `${name} / ${v.id}`,
                    variation: (v.attributes || []).map(a => ({
                        attribute: a.name,
                        value: a.value,
                    })),
                })
        }
        out.candidates = candidates.length
        if (!candidates.length) {
            out.detail = 'store-api listed no purchasable in-stock product'
            return out
        }

        const before = await readCart()
        if (!before.ok) {
            out.detail = `store-api cart ${before.status} — cannot verify an add, so none was sent`
            return out
        }
        if (!before.nonce) {
            out.detail =
                'store-api cart served no Nonce header — add-item would be rejected, so no add was sent'
            return out
        }
        const baseline = before.count || 0

        // Same cap, same reason as the Shopify path above: a store that
        // rejects 5 adds in a row is not going to accept the 6th, and the
        // damage from finding that out the hard way lands on the STORE.
        let failed = 0
        let lastStatus = null
        for (const c of candidates) {
            out.adds++
            const body = { id: c.id, quantity: 1 }
            if (c.variation) body.variation = c.variation
            const add = await fetch('/wp-json/wc/store/v1/cart/add-item', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Nonce: before.nonce,
                },
                body: JSON.stringify(body),
            })
            lastStatus = add.status
            if (add.ok) {
                const after = await readCart()
                if (after.ok && (after.count || 0) > baseline) {
                    out.ok = true
                    out.detail = `added ${c.name}`
                    return out
                }
            }
            out.rejectedAdds = ++failed
            if (failed >= maxRejectedAdds) {
                out.detail = `no add landed in the cart after ${failed} tries (last ${lastStatus}) — stopping before we rate-limit the store`
                return out
            }
        }
        out.detail = `no add landed in the cart across ${out.adds} candidate(s) (last ${lastStatus})`
        return out
    } catch (e) {
        out.detail = `seed failed: ${String(e).slice(0, 80)}`
        return out
    }
}

/**
 * Seed a BigCommerce cart through the Storefront API the theme itself calls:
 * `POST /api/storefront/carts` (or `/carts/{id}/items` when the session
 * already holds one — checked, not guessed, because posting a second cart is
 * an error rather than an add).
 *
 * BigCommerce publishes no product feed, so ids come from the storefront
 * markup, where Stencil stamps them on every product card. Products carrying
 * required options answer 422 and are counted as rejections like any other.
 *
 * @param {{maxRejectedAdds?: number, productLimit?: number}} options
 * @returns {Promise<{ok: boolean, detail: string, rejectedAdds: number, adds: number, productFeedOk: boolean, candidates: number}>}
 */
export async function seedBigCommerceCartInPage(options) {
    const maxRejectedAdds = (options && options.maxRejectedAdds) || 5
    const productLimit = (options && options.productLimit) || 30
    const out = {
        ok: false,
        detail: '',
        rejectedAdds: 0,
        adds: 0,
        productFeedOk: false,
        candidates: 0,
    }
    const readCarts = async () => {
        const res = await fetch('/api/storefront/carts', {
            headers: { accept: 'application/json' },
        })
        if (!res.ok) return { ok: false, carts: [], status: res.status }
        const carts = await res.json()
        return {
            ok: true,
            carts: Array.isArray(carts) ? carts : [],
            status: res.status,
        }
    }
    const countItems = carts => {
        let n = 0
        for (const cart of carts || []) {
            const line = cart.lineItems || {}
            for (const bucket of [
                line.physicalItems,
                line.digitalItems,
                line.giftCertificates,
                line.customItems,
            ])
                for (const item of bucket || [])
                    n += typeof item.quantity === 'number' ? item.quantity : 1
        }
        return n
    }
    try {
        const ids = []
        const seen = new Set()
        for (const el of document.querySelectorAll(
            '[data-product-id], [data-entity-id], input[name="product_id"]',
        )) {
            const raw =
                el.getAttribute('data-product-id') ||
                el.getAttribute('data-entity-id') ||
                el.value
            const id = Number(raw)
            if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue
            seen.add(id)
            ids.push(id)
            if (ids.length >= productLimit) break
        }
        out.productFeedOk = ids.length > 0
        out.candidates = ids.length
        if (!ids.length) {
            out.detail =
                'no product id in the storefront markup (data-product-id / data-entity-id)'
            return out
        }

        const existing = await readCarts()
        if (!existing.ok) {
            out.detail = `storefront carts ${existing.status} — cannot verify an add, so none was sent`
            return out
        }
        const baseline = countItems(existing.carts)
        const cartId = existing.carts.length ? existing.carts[0].id : null

        let failed = 0
        for (const id of ids) {
            out.adds++
            const body = JSON.stringify({
                lineItems: [{ quantity: 1, productId: id }],
            })
            const add = await fetch(
                cartId
                    ? `/api/storefront/carts/${cartId}/items`
                    : '/api/storefront/carts',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                },
            )
            if (add.ok) {
                const now = await readCarts()
                if (now.ok && countItems(now.carts) > baseline) {
                    out.ok = true
                    out.detail = `added product ${id}`
                    return out
                }
            }
            out.rejectedAdds = ++failed
            if (failed >= maxRejectedAdds) {
                out.detail = `no add landed in the cart after ${failed} tries (last ${add.status}) — stopping before we rate-limit the store`
                return out
            }
        }
        out.detail = `no add landed in the cart across ${out.adds} candidate product(s)`
        return out
    } catch (e) {
        out.detail = `seed failed: ${String(e).slice(0, 80)}`
        return out
    }
}

/**
 * Read the cart as the store reports it, through the endpoint that platform
 * publishes. Kept separate from the seeder so the probe can call it at the one
 * moment that matters — see probe.mjs.
 *
 * The platform is passed IN rather than re-detected here: one detection per
 * run means the reader and the seeder can never disagree about what the store
 * is, and the answer is recorded in the report either way.
 *
 * `cartJsOk` is the Shopify leg under its original name; `cartApiOk` is the
 * platform-neutral fact the classifier reads.
 *
 * @param {string} platform one of SEEDABLE_PLATFORMS
 * @returns {Promise<{cartApiOk: boolean, cartJsOk: boolean|null, itemCount: number|null, detail: string}>}
 */
export async function readCartStateInPage(platform) {
    const miss = (detail, isShopify) => ({
        cartApiOk: false,
        cartJsOk: isShopify ? false : null,
        itemCount: null,
        detail,
    })
    const shopify = platform === 'shopify'
    try {
        if (shopify) {
            const res = await fetch('/cart.js')
            if (!res.ok) return miss(`cart.js ${res.status}`, true)
            const cart = await res.json()
            return {
                cartApiOk: true,
                cartJsOk: true,
                itemCount:
                    typeof cart.item_count === 'number'
                        ? cart.item_count
                        : null,
                detail: '',
            }
        }
        if (platform === 'woocommerce') {
            const res = await fetch('/wp-json/wc/store/v1/cart', {
                headers: { accept: 'application/json' },
            })
            if (!res.ok) return miss(`store-api cart ${res.status}`, false)
            const cart = await res.json()
            return {
                cartApiOk: true,
                cartJsOk: null,
                itemCount:
                    typeof cart.items_count === 'number'
                        ? cart.items_count
                        : null,
                detail: '',
            }
        }
        if (platform === 'bigcommerce') {
            const res = await fetch('/api/storefront/carts', {
                headers: { accept: 'application/json' },
            })
            if (!res.ok) return miss(`storefront carts ${res.status}`, false)
            const carts = await res.json()
            let n = 0
            for (const cart of Array.isArray(carts) ? carts : []) {
                const line = cart.lineItems || {}
                for (const bucket of [
                    line.physicalItems,
                    line.digitalItems,
                    line.giftCertificates,
                    line.customItems,
                ])
                    for (const item of bucket || [])
                        n +=
                            typeof item.quantity === 'number'
                                ? item.quantity
                                : 1
            }
            return {
                cartApiOk: true,
                cartJsOk: null,
                itemCount: n,
                detail: '',
            }
        }
        return miss(`no cart endpoint known for platform ${platform}`, false)
    } catch (e) {
        return miss(`err ${String(e).slice(0, 40)}`, shopify)
    }
}

/**
 * Count the promo-shaped inputs on the page — the "matched promo box" half of
 * the detection evidence, for stores whose checkout the extension reaches
 * without a cart payload.
 */
export function countPromoInputsInPage() {
    return document.querySelectorAll(
        'input[name*="discount" i], input[name*="promo" i], input[id*="discount" i], input[id*="coupon" i]',
    ).length
}
