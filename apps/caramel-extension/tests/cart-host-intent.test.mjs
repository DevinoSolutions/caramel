// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://cart.example.com/" }
import { beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// The wire-proof for the HOST cart-intent rule (cart-capability-gate.test.mjs
// pins the vocabulary itself): this realm's whole document lives at
// cart.example.com with a bare "/" path — eBay's exact cart shape — so nothing
// here can pass the PATH rule. If the host branch were unplugged, every
// assertion below would go red for the same reason eBay's cart sat silent.

let isCheckout
let probeCalls

beforeEach(() => {
    document.body.innerHTML = ''
    probeCalls = 0
    ;({ isCheckout } = loadExtensionSources(
        [
            'coupon-constants.generated.js',
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
        ],
        ['isCheckout'],
    ))
    globalThis.getDomainRecord = async () => null
    globalThis.waitForElement = async () => {
        throw new Error('not found')
    }
    globalThis.probeCartJson = async () => {
        probeCalls++
        return { token: 't', total_price: 4499, item_count: 2, currency: 'USD' }
    }
})

describe('a cart that lives on a cart.* host with a bare "/" path', () => {
    it('reaches the capability probe and opens the gate', async () => {
        expect(await isCheckout()).toBe(true)
        expect(probeCalls).toBe(1)
    })

    it('still respects the probe saying the cart is empty', async () => {
        globalThis.probeCartJson = async () => ({
            token: 't',
            total_price: 0,
            item_count: 0,
            currency: 'USD',
        })

        expect(await isCheckout()).toBe(false)
    })
})
