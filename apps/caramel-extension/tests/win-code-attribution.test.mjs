import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// The card names a code. That name has to be the one doing the work.
//
// The re-apply confirmation proves the cart's TOTAL dropped; it never proved
// the cart was honouring the code we were about to print. Live QA on
// 2026-08-06 found the gap on 2 of 3 wins: the card read "Code LAYAN" while
// 100percentpure's cart carried `ATsxsb7x` with `LAYAN:false`, and read
// "26-10OFFTTWMH0" while goodr's carried `26-10OFFLNREWZ`. Both amounts were
// correct to the cent, so no money was overclaimed — but "we only report a win
// when the winning code is still on the cart" was not true as worded.
//
// The two cases are not the same defect and must not get the same fix:
//
//   · The store REWROTE our code into a generated single-use one. That is our
//     win. Our code is the one the shopper can type again; the generated
//     string is unusable to them. Keep ours.
//   · The cart is honouring another code WE PROBED. Then the re-apply did not
//     take, that other code is doing the work, and printing ours names a code
//     the shopper will not find applied. Credit the one the cart honours.
//
// Only the NAME is ever corrected here. The amount stays measured off the
// cart, so this can never turn into a bigger number than the store agrees to.

let startApplyingCoupons

let finalModals
let applied
let cartByCode
let reported

const COUPONS = [
    {
        code: 'ALPHA',
        id: 'a1',
        discount_type: 'PERCENTAGE',
        discount_amount: 30,
    },
    {
        code: 'BETA',
        id: 'b2',
        discount_type: 'PERCENTAGE',
        discount_amount: 10,
    },
]

const REC = { domain: 'shop.example', couponInput: '#promo' }

const cart = (total, codes, apps) => ({
    token: 't',
    item_count: 2,
    currency: 'USD',
    total_price: total,
    total_discount: 10000 - total,
    discount_codes: codes,
    cart_level_discount_applications: apps ?? [],
})

beforeAll(() => {
    ;({ startApplyingCoupons } = loadExtensionSources(
        [
            'coupon-constants.generated.js',
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
        ],
        ['startApplyingCoupons'],
    ))
})

beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
    finalModals = []
    applied = []
    reported = []
    globalThis._caramelCodes = null
    globalThis.showFinalModal = (...a) => finalModals.push(a)
    globalThis.showTestingModal = async () => {}
    globalThis.updateTestingModal = async () => {}
    globalThis.hideTestingModal = () => {}
    globalThis.reportOutcome = (id, outcome) => reported.push([id, outcome])
    globalThis.caramelRecordSaving = () => {}
    globalThis.getCachedCodes = async () => COUPONS
    globalThis.fetchCoupons = async () => COUPONS
    globalThis.probeCartJson = async () => cart(10000, [])
    globalThis.applyViaDiscountLink = async code => {
        applied.push(code)
        return cartByCode(code)
    }
})

const handoff = () => JSON.parse(sessionStorage.getItem('caramel_applied'))

describe('when the store rewrites our code into its own', () => {
    beforeEach(() => {
        // 100percentpure: send LAYAN, cart comes back honouring a generated
        // code with ours marked inapplicable.
        cartByCode = code =>
            code === 'ALPHA'
                ? cart(
                      7000,
                      [
                          { code: 'ALPHA', applicable: false },
                          { code: 'ATsxsb7x', applicable: true },
                      ],
                      [{ title: 'ATsxsb7x', total_allocated_amount: 3000 }],
                  )
                : cart(
                      9000,
                      [{ code: 'BETA', applicable: true }],
                      [{ title: 'BETA', total_allocated_amount: 1000 }],
                  )
    })

    it('still names the code the shopper can actually type', () => {
        // The generated string is accurate and useless to them.
        return startApplyingCoupons(REC).then(() => {
            expect(handoff().code).toBe('ALPHA')
        })
    })

    it('reports the saving the cart actually shows', async () => {
        await startApplyingCoupons(REC)

        expect(handoff().saved).toBeCloseTo(30, 2)
    })
})

describe('when the cart is honouring a different code we probed', () => {
    beforeEach(() => {
        // The re-apply of ALPHA does not take; BETA, probed earlier, is what
        // the cart is still honouring — and it is what produced the drop.
        cartByCode = code =>
            code === 'BETA'
                ? cart(
                      9000,
                      [{ code: 'BETA', applicable: true }],
                      [{ title: 'BETA', total_allocated_amount: 1000 }],
                  )
                : cart(
                      9000,
                      [
                          { code: 'ALPHA', applicable: false },
                          { code: 'BETA', applicable: true },
                      ],
                      [{ title: 'BETA', total_allocated_amount: 1000 }],
                  )
    })

    it('credits the code doing the work, not the one we sent last', async () => {
        await startApplyingCoupons(REC)

        expect(handoff().code).toBe('BETA')
    })

    it('reports the outcome against that code, so the trust loop learns the truth', async () => {
        await startApplyingCoupons(REC)

        expect(reported).toContainEqual(['b2', 'worked'])
        expect(reported).not.toContainEqual(['a1', 'worked'])
    })

    it('does not change the amount while correcting the name', async () => {
        await startApplyingCoupons(REC)

        expect(handoff().saved).toBeCloseTo(10, 2)
    })
})
