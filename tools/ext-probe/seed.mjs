// The two functions the probe runs INSIDE the store page.
//
// Both are deliberately self-contained — no imports, no module-scope
// references, no closures. Playwright serialises a function by its source
// text, so anything captured from this module's scope would be `undefined` by
// the time it runs in the page. The same property is what makes them testable:
// with `globalThis.fetch` stubbed they run unchanged in Node, which is how the
// seed cap below is pinned in CI without touching a real store.

/**
 * How many consecutive rejected adds the seeder tolerates before it gives up.
 * Exported so a caller can read the number, NOT so the page function can — see
 * the self-containment note above.
 */
export const MAX_REJECTED_ADDS = 5

/** Products fetched per seed attempt. */
export const DEFAULT_PRODUCT_LIMIT = 30

/**
 * Seed a Shopify cart the way the platform itself would: read the public
 * product feed, then add the first available variant that the store accepts.
 *
 * @param {{maxRejectedAdds?: number, productLimit?: number}} options
 * @returns {Promise<{ok: boolean, detail: string, rejectedAdds: number, adds: number, productsJsonOk: boolean}>}
 */
export async function seedShopifyCartInPage(options) {
    const maxRejectedAdds = (options && options.maxRejectedAdds) || 5
    const productLimit = (options && options.productLimit) || 30
    const out = {
        ok: false,
        detail: '',
        rejectedAdds: 0,
        adds: 0,
        productsJsonOk: false,
    }
    try {
        const res = await fetch(`/products.json?limit=${productLimit}`)
        out.productsJsonOk = !!res.ok
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
 * Read the cart as the store reports it. Kept separate from the seeder so the
 * probe can call it at the one moment that matters — see probe.mjs.
 *
 * @returns {Promise<{cartJsOk: boolean, itemCount: number|null, detail: string}>}
 */
export async function readCartStateInPage() {
    try {
        const res = await fetch('/cart.js')
        if (!res.ok)
            return {
                cartJsOk: false,
                itemCount: null,
                detail: `cart.js ${res.status}`,
            }
        const cart = await res.json()
        return {
            cartJsOk: true,
            itemCount:
                typeof cart.item_count === 'number' ? cart.item_count : null,
            detail: '',
        }
    } catch (e) {
        return {
            cartJsOk: false,
            itemCount: null,
            detail: `err ${String(e).slice(0, 40)}`,
        }
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
