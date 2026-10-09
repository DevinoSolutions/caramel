import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoverCouponBox,
    caramelDiscoveredRecord,
    caramelFinderSeesBox,
    caramelFindOrderTotal,
} from '../coupon-box-discovery.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import {
    _caramelResetCachedCodes,
    caramelConfiglessRecord,
    getDomainRecord,
    tryInitialize,
} from '../store-detect.js'

// The promo-box finder: when no config describes a store's promo box, it reads
// the page the way a shopper does. These pin three things:
//   · what it picks, and what it must never pick (a newsletter box, a ZIP
//     field, the site search, a gift-card box beside the promo box);
//   · that it does nothing at all while the server flag is off, so turning the
//     feature on is the only way the shopper's experience changes;
//   · that a box it finds is driven through the normal apply flow, marked so
//     the flow can find it, and only when a total can be read.

let finalModals
let promptedWith
let appliedWith
let flagOn

const COUPONS = [
    {
        code: 'SAVE20',
        id: 'c1',
        discount_type: 'PERCENTAGE',
        discount_amount: 20,
    },
]

vi.mock('../coupon-apply.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        applyCoupon: async (code, rec) => {
            appliedWith.push({ code, rec })
            return { success: false, applied: false }
        },
        // Not a platform cart: the discount-link path stays out of the way.
        probeCartJson: async () => null,
    }
})
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showFinalModal: (...args) => finalModals.push(args),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    insertCaramelPrompt: rec => promptedWith.push(rec),
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: () => {},
        // The finder's open-up wait: no need to spend real time here.
        sleep: async () => {},
    }
})

function installChromeStub() {
    const cache = new WeakMap()
    function wrap(target) {
        if (cache.has(target)) return cache.get(target)
        const proxy = new Proxy(target, {
            get(obj, prop) {
                if (prop === 'then' || typeof prop === 'symbol')
                    return undefined
                if (!(prop in obj)) obj[prop] = wrap(function () {})
                return obj[prop]
            },
            apply: () => undefined,
        })
        cache.set(target, proxy)
        return proxy
    }
    const stub = wrap(function chromeStubRoot() {})
    for (const area of ['sync', 'local', 'session']) {
        stub.storage[area].get = (_keys, cb) => {
            if (typeof cb === 'function') cb({})
        }
        stub.storage[area].set = (_items, cb) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    stub.runtime.sendMessage = (message, cb) => {
        if (message?.action === 'fetchCoupons') cb({ coupons: COUPONS })
        else if (message?.action === 'couponBoxDiscoveryEnabled')
            cb({ enabled: flagOn })
        else cb({})
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
}

/** jsdom has no layout. Teach it just enough: hidden = display:none or the
 *  hidden attribute on the element or an ancestor; everything else is a
 *  120x30 box at the origin; innerText is the text content. */
function stubLayout() {
    const hidden = el => {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement)
            if (n.hidden || n.style?.display === 'none') return true
        return false
    }
    Element.prototype.checkVisibility = function () {
        return !hidden(this)
    }
    Element.prototype.getBoundingClientRect = function () {
        const w = hidden(this) ? 0 : 120
        const h = hidden(this) ? 0 : 30
        return { left: 0, top: 0, right: w, bottom: h, width: w, height: h }
    }
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() {
            return hidden(this) ? '' : this.textContent
        },
    })
}

const TOTAL = '<div class="row"><span>Total</span><span>$100.00</span></div>'
const PROMO_BOX =
    '<div class="promo"><label for="dc">Discount code</label>' +
    '<input id="dc" name="discount_code" type="text" placeholder="Enter code">' +
    '<button id="ap" type="button">Apply</button></div>'

function setPath(pathname) {
    window.history.replaceState({}, '', pathname)
}

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
})

beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
    setPath('/cart')
    finalModals = []
    promptedWith = []
    appliedWith = []
    flagOn = true
    _caramelResetDiscoveryFlag()
    _caramelResetCachedCodes()
    getDomainRecord.cache = []
})

describe('what the finder picks', () => {
    it('a labelled promo field and the Apply button beside it, and the total row', () => {
        document.body.innerHTML = PROMO_BOX + TOTAL

        const found = caramelDiscoverCouponBox()

        expect(found.input?.id).toBe('dc')
        expect(found.button?.id).toBe('ap')
        expect(found.reasons.input.some(r => r.startsWith('attr:'))).toBe(true)
        expect(caramelFindOrderTotal()?.textContent).toContain('$100.00')
    })

    it('the total row, never the subtotal or the savings line', () => {
        document.body.innerHTML =
            '<div><span>Subtotal</span><span>$120.00</span></div>' +
            '<div><span>Total savings</span><span>$20.00</span></div>' +
            '<div id="t"><span>Order total</span><span>$100.00</span></div>'

        expect(caramelFindOrderTotal()?.id).toBe('t')
    })

    it('the subtotal when the page has no total row at all', () => {
        document.body.innerHTML =
            '<div id="s"><span>Subtotal</span><span>$120.00</span></div>'

        expect(caramelFindOrderTotal()?.id).toBe('s')
    })

    it('the promo box, not the gift-card box beside it, each with its own Apply', () => {
        document.body.innerHTML =
            '<div><input id="gc" name="gift_card" type="text" placeholder="Gift card number"><button id="gca">Apply</button></div>' +
            '<div><input id="pc" name="promo_code" type="text" placeholder="Promo code"><button id="pca">Apply</button></div>' +
            TOTAL

        const found = caramelDiscoverCouponBox()

        expect(found.input?.id).toBe('pc')
        expect(found.button?.id).toBe('pca')
    })
})

describe('what the finder must never pick', () => {
    it('a newsletter sign-up promising offers', () => {
        document.body.innerHTML =
            '<form><p>Sign up for exclusive offers and promotions</p>' +
            '<input type="text" name="newsletter_email" placeholder="Your email">' +
            '<button>Subscribe</button></form>' +
            TOTAL

        expect(caramelDiscoverCouponBox().input).toBeNull()
        expect(caramelFinderSeesBox()).toBe(false)
    })

    it('a ZIP code field with an Apply button', () => {
        document.body.innerHTML =
            '<div><label for="z">ZIP code</label><input id="z" name="zip" type="text">' +
            '<button>Apply</button></div>' +
            TOTAL

        expect(caramelDiscoverCouponBox().input).toBeNull()
    })

    it('the site search, even when it says code', () => {
        document.body.innerHTML =
            '<form role="search" action="/search"><input type="text" name="q" placeholder="Search by code or product">' +
            '<button>Go</button></form>' +
            TOTAL

        expect(caramelDiscoverCouponBox().input).toBeNull()
    })

    it('a translated add-to-cart button beside the box is never its apply button', () => {
        document.body.innerHTML =
            '<div><input id="pc" name="gutscheincode" type="text">' +
            '<button id="atc">In den Warenkorb</button></div>' +
            TOTAL

        expect(caramelDiscoverCouponBox().button).toBeNull()
    })

    it('an add-to-cart button beside the box is never its apply button', () => {
        document.body.innerHTML =
            '<div><input id="pc" name="discount_code" type="text">' +
            '<button id="atc">Add to cart</button></div>' +
            TOTAL

        expect(caramelDiscoverCouponBox().button).toBeNull()
    })

    it('an order button beside the box is never its apply button', () => {
        document.body.innerHTML =
            '<div><input id="pc" name="promo_code" type="text">' +
            '<button id="po">Place order</button></div>' +
            TOTAL

        const found = caramelDiscoverCouponBox()

        expect(found.input?.id).toBe('pc')
        expect(found.button).toBeNull()
    })
})

describe('the total reader reads one row, or nothing', () => {
    it('a column heading named Total is not the total row', () => {
        document.body.innerHTML =
            '<table><thead><tr><th>Item</th><th>Total</th></tr></thead>' +
            '<tbody><tr><td>Mug</td><td><s>$200.00</s> $100.00</td></tr></tbody></table>'

        expect(caramelFindOrderTotal()).toBeNull()
    })

    it('a summary list: the total value, not the block with the shipping promise in it', () => {
        document.body.innerHTML =
            '<dl><dt>Subtotal</dt><dd>$100.00</dd>' +
            '<dt>Shipping</dt><dd>Free shipping over $150</dd>' +
            '<dt>Total</dt><dd id="t">$110.00</dd></dl>'

        expect(caramelFindOrderTotal()?.id).toBe('t')
    })

    it('a row holding two amounts is not read', () => {
        document.body.innerHTML =
            '<div><span>Total</span><span><s>$120.00</s> $100.00</span></div>'

        expect(caramelFindOrderTotal()).toBeNull()
    })

    it('a header row outside <thead> is not the total row', () => {
        document.body.innerHTML =
            '<div id="t"><span>Order total</span><span>$110.00</span></div>' +
            '<table><tr><th>Item</th><th>Total</th></tr>' +
            '<tr><td>Mug</td><td>$30.00</td></tr></table>'

        expect(caramelFindOrderTotal()?.id).toBe('t')
    })

    it('"calculated at the next step" is not a total, whatever sits near it', () => {
        document.body.innerHTML =
            '<div><div><span>Total:</span> <span>Calculated at next step</span></div>' +
            '<p>Free shipping on orders over $150</p></div>'

        expect(caramelFindOrderTotal()).toBeNull()
    })

    it('a total with its tax in parentheses is read', () => {
        document.body.innerHTML =
            '<div id="t"><span>Gesamt</span><span>95,00 € (inkl. 15,17 € MwSt.)</span></div>'

        expect(caramelFindOrderTotal()?.id).toBe('t')
    })

    it('a whole table body of line totals is not the order total', () => {
        document.body.innerHTML =
            '<table><tbody><tr><td>Total</td></tr>' +
            '<tr><td>$30.00</td></tr></tbody></table>'

        expect(caramelFindOrderTotal()?.tagName).not.toBe('TBODY')
    })

    it('a total weight is not a total', () => {
        document.body.innerHTML =
            '<div><span>Total weight</span><span>2.50 kg</span></div>'

        expect(caramelFindOrderTotal()).toBeNull()
    })
})

describe('the reveal toggle is never a checkout submit', () => {
    const FORM_TOGGLE =
        '<form><button id="tg" aria-expanded="false">Have a promo code?</button>' +
        '<div id="panel" style="display:none">' +
        '<input id="pc" name="promo_code" type="text"><button type="button" id="pa">Apply</button></div>' +
        '<button type="submit">Pay now</button></form>' +
        TOTAL

    it('is not offered to the shopper and is never clicked', async () => {
        document.body.innerHTML = FORM_TOGGLE
        let clicks = 0
        document.getElementById('tg').addEventListener('click', e => {
            clicks++
            e.preventDefault()
        })

        expect(caramelFinderSeesBox()).toBe(false)
        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).toBeNull()
        expect(clicks).toBe(0)
    })

    it('a submit-type toggle in a plain cart form is not clicked either (it would post the cart)', async () => {
        document.body.innerHTML =
            '<form action="/cart" method="post"><button id="tg" aria-expanded="false">Have a discount code?</button>' +
            '<div id="panel" style="display:none">' +
            '<input id="pc" name="discount" type="text"><button type="button" id="pa">Apply</button></div>' +
            '<button type="submit" name="checkout">Check out</button></form>' +
            TOTAL
        let submits = 0
        document.querySelector('form').addEventListener('submit', e => {
            submits++
            e.preventDefault()
        })

        expect(caramelFinderSeesBox()).toBe(false)
        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).toBeNull()
        expect(submits).toBe(0)
    })

    it('a type="button" toggle in the same form is still used', async () => {
        document.body.innerHTML = FORM_TOGGLE
        const tg = document.getElementById('tg')
        tg.type = 'button'
        tg.addEventListener('click', () => {
            document.getElementById('panel').style.display = ''
        })

        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(document.querySelector(rec.couponInput)?.id).toBe('pc')
    })
})

describe('the record the apply flow runs on', () => {
    it('marks the picks and holds them to the money rule', async () => {
        document.body.innerHTML = PROMO_BOX + TOTAL

        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(rec.caramelFound).toBe(true)
        expect(document.querySelector(rec.couponInput)?.id).toBe('dc')
        expect(document.querySelector(rec.couponSubmit)?.id).toBe('ap')
        expect(
            document.querySelector(rec.priceContainer)?.textContent,
        ).toContain('$100.00')
        // The box's own small container is watched for the store's answer.
        expect(document.querySelector(rec.caramelAnswer)?.className).toBe(
            'promo',
        )
    })

    it('remembers the total row it measured, so a re-render finds only that row', async () => {
        document.body.innerHTML = PROMO_BOX + TOTAL

        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(rec.caramelTotalLabel).toBe('total')
        expect(rec.caramelTotalRows).toBe(1)
    })

    it('a total the price reader cannot parse gives no record', async () => {
        // "100.00" with no currency mark looks like an amount but reads NaN:
        // no code could ever be measured against it.
        document.body.innerHTML =
            PROMO_BOX +
            '<div class="row"><span>Total</span><span>100.00</span></div>'

        expect(caramelFindOrderTotal()).not.toBeNull()
        expect(caramelFinderSeesBox()).toBe(false)
        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).toBeNull()
    })

    it('carries none of the stale config fields it did not find', async () => {
        document.body.innerHTML = PROMO_BOX + TOTAL

        const rec = await caramelDiscoveredRecord({
            domain: 'shop.test',
            couponRemove: '.remove',
            dismissButton: '.close',
            successIndicator: '.ok',
            errorIndicator: '.err',
            showInput: '.show',
        })

        for (const k of [
            'couponRemove',
            'dismissButton',
            'successIndicator',
            'errorIndicator',
            'showInput',
        ])
            expect(rec[k]).toBeNull()
    })

    it('no readable total, no record: there would be nothing honest to measure', async () => {
        document.body.innerHTML = PROMO_BOX

        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).toBeNull()
        expect(caramelFinderSeesBox()).toBe(false)
    })

    it('opens a folded promo box through its toggle, then picks the box', async () => {
        document.body.innerHTML =
            '<button id="tg" type="button" aria-expanded="false">Have a promo code?</button>' +
            '<div id="panel" style="display:none">' +
            '<input id="pc" name="promo_code" type="text"><button id="pa">Apply</button></div>' +
            TOTAL
        document.getElementById('tg').addEventListener('click', () => {
            document.getElementById('panel').style.display = ''
        })

        expect(caramelFinderSeesBox()).toBe(true)
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(document.querySelector(rec.couponInput)?.id).toBe('pc')
        expect(document.querySelector(rec.couponSubmit)?.id).toBe('pa')
    })
})

describe('the flag decides whether the shopper sees any of this', () => {
    it('flag off: a configless cart with a plain promo box gets no prompt, exactly as before', async () => {
        flagOn = false
        document.body.innerHTML = PROMO_BOX + TOTAL

        await tryInitialize()

        expect(promptedWith).toHaveLength(0)
    })

    it('flag on: the same cart gets the prompt', async () => {
        document.body.innerHTML = PROMO_BOX + TOTAL

        await tryInitialize()

        expect(promptedWith).toHaveLength(1)
    })

    it('flag on: never on a page that is not a cart, whatever box it shows', async () => {
        setPath('/')
        document.body.innerHTML = PROMO_BOX + TOTAL

        await tryInitialize()

        expect(promptedWith).toHaveLength(0)
    })

    it('flag off: the apply flow still hands the codes over to copy and types nothing', async () => {
        flagOn = false
        document.body.innerHTML = PROMO_BOX + TOTAL

        await startApplyingCoupons(caramelConfiglessRecord('shop.test'))

        expect(appliedWith).toHaveLength(0)
        expect(finalModals.at(-1)[2]).toMatch(/couldn't find the promo box/)
        expect(document.querySelector('[data-caramel-found]')).toBeNull()
    })

    it('flag on: the apply flow drives the box the finder picked', async () => {
        document.body.innerHTML = PROMO_BOX + TOTAL

        await startApplyingCoupons(caramelConfiglessRecord('shop.test'))

        expect(appliedWith.length).toBeGreaterThan(0)
        const { rec } = appliedWith[0]
        expect(rec.caramelFound).toBe(true)
        expect(document.querySelector(rec.couponInput)?.id).toBe('dc')
    })
})
