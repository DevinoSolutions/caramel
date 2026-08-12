// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://cart.example.com/" }
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDomainRecord, isCheckout } from '../store-detect.js'

// The wire-proof for the HOST cart-intent rule (cart-capability-gate.test.mjs
// pins the vocabulary itself): this realm's whole document lives at
// cart.example.com with a bare "/" path — eBay's exact cart shape — so nothing
// here can pass the PATH rule. If the host branch were unplugged, every
// assertion below would go red for the same reason eBay's cart sat silent.

let probeCalls
let probeCartJsonImpl

// The collaborators the old harness replaced on globalThis are module imports
// now, so they are replaced where isCheckout reads them. Each mock delegates to
// a mutable impl so a single test can still swap one (vi.mock is hoisted).
vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    probeCartJson: (...args) => probeCartJsonImpl(...args),
}))
vi.mock('../dom-utils.js', async importOriginal => ({
    ...(await importOriginal()),
    waitForElement: async () => {
        throw new Error('not found')
    },
}))

beforeEach(() => {
    document.body.innerHTML = ''
    probeCalls = 0
    // An empty (but present) store list is "this host has no config row" —
    // getDomainRecord's own answer, rather than a stub standing in front of it.
    getDomainRecord.cache = []
    probeCartJsonImpl = async () => {
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
        probeCartJsonImpl = async () => ({
            token: 't',
            total_price: 0,
            item_count: 0,
            currency: 'USD',
        })

        expect(await isCheckout()).toBe(false)
    })
})
