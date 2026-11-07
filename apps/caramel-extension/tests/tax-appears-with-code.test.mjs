import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { applyCoupon } from '../coupon-apply.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoveredRecord,
    caramelFinderTotalNow,
} from '../coupon-box-discovery.js'
import {
    NO_CONFIG,
    handoffs,
    installChromeStub,
    registerFinder,
    sent,
    setPath,
    stubLayout,
} from './_found-box-harness.mjs'
import {
    JM_AFTER_FREESHIP,
    JM_BEFORE,
    JM_FREESHIP_ROW,
    JM_PROMO_FORM,
    jmSummary,
} from './_johnstonmurphy-cart.mjs'

// A code that takes money off can make the store show sales tax at the same
// moment, so the total goes UP while the code worked (T-14872). Seen live on
// johnstonmurphy.com 2026-11-06 with 1.4.37: FREESHIP26 drew "Shipping Discount
// - $9.95" and "Sales Tax $18.90", the Estimated Total went $198.95 -> $207.90,
// and the run ended "Grab a code" with FREESHIP26 still on the order.
//   · the code is judged by the line it drew (or the shipping it took off),
//     with the tax that appeared set aside;
//   · a refused code, or a page whose lines do not account for the drop to the
//     cent, is still a miss.

vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showFinalModal: () => {},
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    insertCaramelPrompt: () => {},
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: () => {},
        log: () => {},
    }
})

// The verdict waits up to 10s for a store that never answers.
const SLOW = 20000

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
    registerFinder()
})

beforeEach(() => {
    sessionStorage.clear()
    handoffs.reset()
    sent.length = 0
    document.body.innerHTML = ''
    setPath('/cart')
    _caramelResetDiscoveryFlag()
})

// The J&M cart, answering each code the way the store did: FREESHIP26 takes
// $9.95 off shipping and tax appears; any other code is refused, the cart
// left as it is (or its summary drawn as `refused`).
function jmCart({ refused = null } = {}) {
    document.body.innerHTML =
        JM_PROMO_FORM + `<div id="sum">${jmSummary(JM_BEFORE)}</div>`
    const form = document.querySelector('form.promo-code-form')
    const input = document.getElementById('couponCode')
    // The store's own script sends the code by XHR, never by a page load.
    form.addEventListener('submit', e => e.preventDefault())
    form.querySelector('button').addEventListener('click', () => {
        const code = input.value
        setTimeout(() => {
            const ok = code === 'FREESHIP26'
            if (ok || refused)
                document.getElementById('sum').innerHTML = jmSummary(
                    ok ? JM_AFTER_FREESHIP : refused,
                )
            if (ok)
                document.querySelector('.coupons-and-promos').innerHTML =
                    JM_FREESHIP_ROW
            document.getElementById('invalidCouponCode').textContent = ok
                ? ''
                : 'Coupon cannot be added to your cart'
        }, 300)
    })
}

describe('a code whose saving lands with a new tax line (johnstonmurphy.com)', () => {
    it(
        'FREESHIP26 is a $9.95 saving although the total rose with the tax',
        async () => {
            jmCart()
            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            expect(rec?.caramelFound).toBe(true)

            const res = await applyCoupon('FREESHIP26', rec)

            expect(res.success).toBe(true)
            expect(res.newTotal).toBe(189)
        },
        SLOW,
    )

    it(
        'a refused code is still a miss when the store starts showing tax',
        async () => {
            // The store works out tax on the next answer whatever the code:
            // the total rises by the tax alone, with no deduction line.
            jmCart({ refused: { tax: '$18.90', total: '$217.85' } })
            const rec = await caramelDiscoveredRecord(NO_CONFIG)

            const res = await applyCoupon('SHAMROCK', rec)

            expect(res.success).toBe(false)
        },
        SLOW,
    )

    it(
        'the next code, with the tax now shown, is judged on the total again',
        async () => {
            jmCart()
            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            expect((await applyCoupon('FREESHIP26', rec)).success).toBe(true)

            // FREESHIP26 stays on; the store refuses the next code and the
            // summary does not move.
            const res = await applyCoupon('USA', rec)

            expect(res.success).toBe(false)
        },
        SLOW,
    )
})

// The read itself, driven directly: the baseline read before a code, then the
// page as the store re-drew it.
describe('setting a new tax aside', () => {
    function readAfter(before, after) {
        document.body.innerHTML = `<div id="sum">${before}</div>`
        const rec = {
            priceContainer: '#t',
            caramelTotalKind: 'total',
        }
        caramelFinderTotalNow(rec, document, true, 'CODE')
        document.getElementById('sum').innerHTML = after
        return caramelFinderTotalNow(rec)
    }
    const summary = ({ ship = '$5.00', line = '', tax = '', total }) =>
        '<div class="r"><span>Subtotal</span> <span>$50.00</span></div>' +
        `<div class="r"><span>Shipping</span> <span>${ship}</span></div>` +
        line +
        `<div class="r"><span>Tax</span> <span>${tax || 'Calculated at checkout'}</span></div>` +
        `<div class="r"><span>Total</span> <span id="t">${total}</span></div>`

    it('nets the J&M summary to the total less the new tax', () => {
        document.body.innerHTML = `<div id="sum">${jmSummary(JM_BEFORE)}</div>`
        const rec = {
            priceContainer: '.grand-total',
            caramelTotalKind: 'total',
        }
        expect(caramelFinderTotalNow(rec, document, true, 'FREESHIP26')).toBe(
            198.95,
        )
        document.getElementById('sum').innerHTML = jmSummary(JM_AFTER_FREESHIP)
        expect(caramelFinderTotalNow(rec)).toBe(189)
        expect(rec.caramelNetted).toBe(true)
    })

    it('credits a shipping charge that went to Free beside a new tax', () => {
        expect(
            readAfter(
                summary({ total: '$55.00' }),
                summary({ ship: 'FREE', tax: '$6.00', total: '$56.00' }),
            ),
        ).toBe(50)
    })

    it('credits a shipping charge that went to $0.00 beside a new tax', () => {
        expect(
            readAfter(
                summary({ total: '$55.00' }),
                summary({ ship: '$0.00', tax: '$6.00', total: '$56.00' }),
            ),
        ).toBe(50)
    })

    it('reads the plain total when tax appears and nothing explains a drop', () => {
        expect(
            readAfter(
                summary({ total: '$55.00' }),
                summary({ tax: '$4.40', total: '$59.40' }),
            ),
        ).toBe(59.4)
    })

    it('reads the plain total when the new line does not match the drop to the cent', () => {
        // Less the tax the total fell $5.00, but the only new line says $3.00.
        expect(
            readAfter(
                summary({ total: '$55.00' }),
                summary({
                    line: '<div class="r"><span>Discount</span> <span>-$3.00</span></div>',
                    tax: '$5.40',
                    total: '$55.40',
                }),
            ),
        ).toBe(55.4)
    })

    it('reads the plain total when a deduction line was already on the page', () => {
        const line =
            '<div class="r"><span>Discount</span> <span>-$5.00</span></div>'
        // Less the tax the total fell $5.00, and the only $5.00 line is the
        // one the cart already showed.
        expect(
            readAfter(
                summary({ line, total: '$50.00' }),
                summary({ line, tax: '$5.00', total: '$50.00' }),
            ),
        ).toBe(50)
    })

    it('does not set aside a tax that was already shown and only changed', () => {
        expect(
            readAfter(
                summary({ tax: '$4.40', total: '$59.40' }),
                summary({ ship: 'FREE', tax: '$9.00', total: '$59.00' }),
            ),
        ).toBe(59)
    })
})
