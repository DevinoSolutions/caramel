// ES module since the WXT P1 port (2026-08-12) — module scope replaces the
// old IIFE, and the named exports replace the deleted CJS `module.exports`
// branch. The `window.CaramelCartSignals` publication is KEPT, inside
// initCartSignals() at the bottom (recipe rule 1b — the content entrypoint
// calls it from main()): coupon-fetch.js's classifyCartCategory() reads it
// off `window` at call time (and degrades to null when absent), and the
// e2e/guard harnesses probe the same window seam — consumers migrate to
// direct imports deliberately, later, not as a side effect of this port.
function text(el) {
    if (!el) return ''
    return (el.textContent || '').replace(/\s+/g, ' ').trim()
}

function metaContent(name) {
    const byName = document.querySelector(`meta[name="${name}" i]`)
    if (byName) return (byName.getAttribute('content') || '').trim()
    const byProp = document.querySelector(`meta[property="${name}" i]`)
    return byProp ? (byProp.getAttribute('content') || '').trim() : ''
}

function baseDomain() {
    const parts = location.hostname.split('.').filter(Boolean)
    if (parts.length <= 2) return parts.join('.')
    return parts.slice(-2).join('.')
}

function titleTag() {
    return text(document.querySelector('title')).slice(0, 200)
}

const CART_ITEM_SELECTORS = [
    '[class*="line-item"]',
    '[class*="cart-item"]',
    '[class*="cart__item"]',
    '[class*="CartItem"]',
    '[class*="bag-item"]',
    '[class*="bagItem"]',
    '[class*="basket-item"]',
    '[class*="order-item"]',
    '[class*="product-line"]',
    '[class*="productLine"]',
    '[data-line-item]',
    '[data-cart-item]',
    '[itemtype*="Product"]',
]

const ITEM_TITLE_SELECTORS = [
    '[class*="title"]',
    '[class*="name"]',
    '[itemprop="name"]',
    '[data-product-title]',
    'a[href*="/product"]',
    'a[href*="/products/"]',
    'a[href*="/p/"]',
    'h1, h2, h3, h4',
]

export function extractCartItems(limit = 6) {
    const seen = new Set()
    const out = []
    for (const sel of CART_ITEM_SELECTORS) {
        const rows = document.querySelectorAll(sel)
        for (const row of rows) {
            if (out.length >= limit) break
            let title = ''
            for (const tsel of ITEM_TITLE_SELECTORS) {
                const t = row.querySelector(tsel)
                if (t) {
                    title = text(t)
                    if (title.length > 3) break
                }
            }
            if (!title) title = text(row).slice(0, 140)
            if (title && !seen.has(title) && title.length >= 3) {
                seen.add(title)
                out.push(title.slice(0, 140))
            }
        }
        if (out.length >= limit) break
    }
    return out
}

export function extractJsonLdProductNames(limit = 6) {
    const out = []
    const scripts = document.querySelectorAll(
        'script[type="application/ld+json"]',
    )
    for (const s of scripts) {
        let data
        try {
            data = JSON.parse(s.textContent || '')
        } catch {
            continue
        }
        const queue = Array.isArray(data) ? [...data] : [data]
        while (queue.length) {
            const node = queue.shift()
            if (!node || typeof node !== 'object') continue
            const t = node['@type']
            const isProduct =
                t === 'Product' || (Array.isArray(t) && t.includes('Product'))
            if (isProduct && node.name && typeof node.name === 'string') {
                out.push(node.name.slice(0, 140))
                if (out.length >= limit) return out
            }
            if (node.hasOfferCatalog) queue.push(node.hasOfferCatalog)
            if (Array.isArray(node.itemListElement))
                queue.push(...node.itemListElement)
        }
    }
    return out
}

async function tryShopifyCart() {
    if (
        !/Shopify/i.test(document.documentElement.innerHTML) &&
        !document.querySelector('script[src*="shopify"]')
    )
        return null
    try {
        const r = await fetch('/cart.js', { credentials: 'include' })
        if (!r.ok) return null
        const j = await r.json()
        if (!Array.isArray(j.items)) return null
        return j.items
            .slice(0, 6)
            .map(i => String(i.product_title || i.title || '').slice(0, 140))
            .filter(Boolean)
    } catch {
        return null
    }
}

export async function collectCartSignals() {
    const shopifyItems = await tryShopifyCart()
    const domItems =
        shopifyItems && shopifyItems.length ? shopifyItems : extractCartItems()
    const jsonLdItems = extractJsonLdProductNames()

    const payload = {
        domain: baseDomain(),
        url_path: location.pathname.slice(0, 120),
        title: titleTag(),
        meta_description: (
            metaContent('description') || metaContent('og:description')
        ).slice(0, 300),
        og_site_name: metaContent('og:site_name').slice(0, 80),
        og_type: metaContent('og:type').slice(0, 40),
        cart_items: (domItems.length ? domItems : jsonLdItems).slice(0, 6),
        platform_hints: {
            shopify: !!(
                window.Shopify ||
                document.querySelector('script[src*="shopify"]')
            ),
            woocommerce: !!document.querySelector('[class*="woocommerce"]'),
            bigcommerce: !!(
                window.BCData || document.querySelector('[class*="bc-cart"]')
            ),
            magento: !!(
                document.querySelector('[data-mage-init]') ||
                /Magento/i.test(document.documentElement.innerHTML)
            ),
        },
    }
    return payload
}

// Init-wrap (recipe rule 1b): WXT imports entrypoints in Node at build time,
// so the publication may not run as a module-eval side effect — the content
// entrypoint calls this inside main(), first in the old manifest order.
export function initCartSignals() {
    window.CaramelCartSignals = {
        collectCartSignals,
        extractCartItems,
        extractJsonLdProductNames,
    }
}
