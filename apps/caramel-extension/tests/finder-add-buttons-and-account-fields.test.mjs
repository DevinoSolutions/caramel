import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoverCouponBox,
    caramelDiscoveredRecord,
} from '../coupon-box-discovery.js'
import {
    NO_CONFIG,
    PROMO_BOX,
    TOTAL,
    handoffs,
    installChromeStub,
    placeAt,
    setPath,
    stubLayout,
} from './_found-box-harness.mjs'

// What the finder picks as the apply button, and as the box, on carts that
// carry other controls near the promo field:
//   · a bare "Add" on a cross-sell row is never the box's apply button — a
//     click on it puts a product in the cart;
//   · a field that names a member or a loyalty account is never the box,
//     however much the heading above it says "discount";
//   · a Japanese cart's box is found.

let logCalls

vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: async () => ({ success: false, applied: false }),
    probeCartJson: async () => null,
}))
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
        log: (...args) => logCalls.push(args),
        sleep: async () => {},
    }
})

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
})

beforeEach(() => {
    sessionStorage.clear()
    handoffs.reset()
    document.body.innerHTML = ''
    setPath('/cart')
    logCalls = []
    _caramelResetDiscoveryFlag()
})

// A promo field with no apply button of its own (the store applies on Enter
// or on blur), and a cross-sell row right under it: "Cozy socks $9.99 [Add]".
// The upsell button carries no cart attribute and no "to cart" phrasing —
// most themes render exactly `<button>Add</button>` here.
const BOX_WITHOUT_APPLY =
    '<div class="promo"><label for="dc">Discount code</label>' +
    '<input id="dc" name="discount_code" type="text" placeholder="Enter code"></div>'
const UPSELL =
    '<div class="upsell"><p>You may also like</p>' +
    '<div class="item"><span>Cozy socks</span><span>$9.99</span>' +
    '<button id="add-socks" class="product-add" type="button">Add</button></div></div>'

describe('the apply button beside a promo box', () => {
    it('a bare Add button on a cross-sell beside a promo box is never its apply button', () => {
        document.body.innerHTML =
            '<aside class="cart-side">' +
            BOX_WITHOUT_APPLY +
            UPSELL +
            '</aside>' +
            TOTAL
        // The upsell row sits 180px under the field: not adjacent, not far.
        placeAt(document.getElementById('add-socks'), { left: 0, top: 180 })

        const found = caramelDiscoverCouponBox()

        expect(found.input?.id).toBe('dc')
        // A box with no apply button is a box the finder leaves alone, not
        // one it drives through the nearest "Add".
        expect(found.button).toBeNull()
    })

    it('a bare Add right beside the field is not its apply button either', () => {
        document.body.innerHTML =
            '<div class="promo"><label for="dc">Discount code</label>' +
            '<input id="dc" name="discount_code" type="text">' +
            '<button id="add-socks" type="button">Add</button></div>' +
            TOTAL

        expect(caramelDiscoverCouponBox().button).toBeNull()
    })

    it('such a box gives no record to drive, so the cart stays as the shopper left it', async () => {
        document.body.innerHTML =
            '<aside class="cart-side">' +
            BOX_WITHOUT_APPLY +
            UPSELL +
            '</aside>' +
            TOTAL
        placeAt(document.getElementById('add-socks'), { left: 0, top: 180 })
        let added = 0
        document
            .getElementById('add-socks')
            .addEventListener('click', () => added++)

        const rec = await caramelDiscoveredRecord(NO_CONFIG)

        expect(
            rec?.couponSubmit
                ? document.querySelector(rec.couponSubmit)?.id
                : null,
        ).not.toBe('add-socks')
        expect(added).toBe(0)
    })

    it('an Add button that says it adds to the cart is refused', () => {
        document.body.innerHTML =
            '<aside>' +
            BOX_WITHOUT_APPLY +
            '<div class="upsell"><span>Cozy socks</span>' +
            '<button id="atc" type="button">Add to cart</button></div></aside>' +
            TOTAL

        expect(caramelDiscoverCouponBox().button).toBeNull()
    })

    it('an Add that names a code ("Add promo code") is still the apply button', () => {
        document.body.innerHTML =
            '<div class="promo"><label for="dc">Discount code</label>' +
            '<input id="dc" name="discount_code" type="text">' +
            '<button id="ap" type="button">Add promo code</button></div>' +
            TOTAL

        expect(caramelDiscoverCouponBox().button?.id).toBe('ap')
    })

    it("the box's own Apply still wins over a nearby Add", () => {
        document.body.innerHTML =
            '<aside>' + PROMO_BOX + UPSELL + '</aside>' + TOTAL
        placeAt(document.getElementById('add-socks'), { left: 0, top: 180 })

        expect(caramelDiscoverCouponBox().button?.id).toBe('ap')
    })
})

describe('what the finder must never type a code into', () => {
    it('a member-number field under a member-discount heading, with its own Apply', () => {
        document.body.innerHTML =
            '<div class="member"><h3>Member discount</h3>' +
            '<label for="mn">Member number</label>' +
            '<input id="mn" name="member_number" type="text" placeholder="Member number">' +
            '<button id="ma" type="button">Apply</button></div>' +
            TOTAL

        // A member ID is not a coupon code: typing a code into it and pressing
        // Apply asks the store to look up a member that does not exist.
        expect(caramelDiscoverCouponBox().input).toBeNull()
    })

    it('a membership-number field under a membership-discount heading, with its own Apply', () => {
        document.body.innerHTML =
            '<div><h3>Membership discount</h3>' +
            '<input id="mn" name="membership_number" type="text" placeholder="Membership number">' +
            '<button type="button">Apply</button></div>' +
            TOTAL

        expect(caramelDiscoverCouponBox().input).toBeNull()
    })

    it('a field whose own words name a coupon keeps its place ("Promo or rewards code")', () => {
        document.body.innerHTML =
            '<div><label for="rc">Promo or rewards code</label>' +
            '<input id="rc" name="rewards_code" type="text">' +
            '<button id="ap" type="button">Apply</button></div>' +
            TOTAL

        expect(caramelDiscoverCouponBox().input?.id).toBe('rc')
    })

    it('a member-discount code field is still the box', () => {
        document.body.innerHTML =
            '<div><label for="md">Member discount code</label>' +
            '<input id="md" name="member_discount_code" type="text">' +
            '<button id="ap" type="button">Apply</button></div>' +
            TOTAL

        expect(caramelDiscoverCouponBox().input?.id).toBe('md')
    })
})

describe('promo boxes in other scripts', () => {
    it('a Japanese promo box is found', () => {
        document.body.innerHTML =
            '<div class="promo"><label for="cp">クーポンコード</label>' +
            '<input id="cp" name="cp" type="text" placeholder="クーポンコードを入力">' +
            '<button id="ok" type="button">適用</button></div>' +
            '<div class="row"><span>合計</span><span>¥10,000</span></div>'

        const found = caramelDiscoverCouponBox()

        expect(found.input?.id).toBe('cp')
        expect(found.button?.id).toBe('ok')
    })

    it('a Japanese cart gives a record with its total row', async () => {
        document.body.innerHTML =
            '<div class="promo"><label for="cp">クーポンコード</label>' +
            '<input id="cp" name="cp" type="text">' +
            '<button id="ok" type="button">適用</button></div>' +
            '<div class="row"><span>合計</span><span id="tot">¥10,000</span></div>'

        const rec = await caramelDiscoveredRecord(NO_CONFIG)

        expect(rec?.caramelFound).toBe(true)
        expect(
            document.querySelector(rec.priceContainer)?.textContent,
        ).toContain('¥10,000')
    })
})
