import { describe, expect, it } from 'vitest'
import {
    collectCartSignals,
    extractCartItems,
    extractJsonLdProductNames,
} from '../cart-signals.js'

// WXT-migration P1 pilot (2026-08-12): the FIRST suite that imports an
// extension source file as an ES module instead of eval-ing it through
// tests/_load.mjs. Its shape is the model every ported suite follows: plain
// imports, jsdom globals, no chrome stub unless the module touches chrome
// (cart-signals doesn't). It also pins the port's one contract with the old
// world: the window.CaramelCartSignals publication that coupon-fetch.js and
// the e2e probes read at runtime must survive the module conversion.

describe('cart-signals as an ES module (P1 pilot)', () => {
    it('publishes window.CaramelCartSignals exactly as the script version did', () => {
        expect(window.CaramelCartSignals).toBeDefined()
        expect(window.CaramelCartSignals.collectCartSignals).toBe(
            collectCartSignals,
        )
        expect(window.CaramelCartSignals.extractCartItems).toBe(
            extractCartItems,
        )
        expect(window.CaramelCartSignals.extractJsonLdProductNames).toBe(
            extractJsonLdProductNames,
        )
    })

    it('extracts cart item titles from line-item markup', () => {
        document.body.innerHTML = `
            <div class="cart-item"><span class="title">Blue Suede Shoes</span></div>
            <div class="cart-item"><span class="title">Velvet Jacket</span></div>`

        expect(extractCartItems()).toEqual([
            'Blue Suede Shoes',
            'Velvet Jacket',
        ])
    })

    it('reads product names out of JSON-LD, including nested itemListElement', () => {
        document.body.innerHTML = `
            <script type="application/ld+json">
                {"@type":"ItemList","itemListElement":[{"@type":"Product","name":"Cast Iron Pan"}]}
            </script>`

        expect(extractJsonLdProductNames()).toEqual(['Cast Iron Pan'])
    })

    it('collects the full signal payload off a plain DOM (no Shopify)', async () => {
        document.body.innerHTML =
            '<div class="cart-item"><span class="name">Wool Socks</span></div>'
        document.title = 'Cart – Example Store'

        const payload = await collectCartSignals()

        expect(payload.cart_items).toEqual(['Wool Socks'])
        expect(payload.title).toBe('Cart – Example Store')
        expect(payload.platform_hints.shopify).toBe(false)
    })
})
