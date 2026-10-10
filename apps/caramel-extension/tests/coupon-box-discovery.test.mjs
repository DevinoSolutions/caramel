import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoverCouponBox,
    caramelDiscoveredRecord,
    caramelFinderSeesBox,
    caramelFindOrderTotal,
    caramelRemarkFoundBox,
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

    it('the total row whose label the store hides (a responsive cart table)', () => {
        // WooCommerce draws these labels from the cell's data-title; the
        // <th> itself is display:none, so the row shows "$150.00" alone.
        document.body.innerHTML =
            '<table><tbody>' +
            '<tr id="s"><th style="display:none">Subtotal</th><td data-title="Subtotal">$150.00</td></tr>' +
            '<tr><th style="display:none">Coupon: potus25</th><td data-title="Coupon: potus25">-$6.00</td></tr>' +
            '<tr id="t"><th style="display:none">Total</th><td data-title="Total">$144.00</td></tr>' +
            '</tbody></table>'
        // Rendered text leaves a hidden child's words out, as a browser does.
        const proto = HTMLElement.prototype
        const prior = Object.getOwnPropertyDescriptor(proto, 'innerText')
        const shown = n =>
            n.nodeType === 3
                ? n.textContent
                : n.style?.display === 'none'
                  ? ''
                  : [...n.childNodes].map(shown).join(' ')
        Object.defineProperty(proto, 'innerText', {
            configurable: true,
            get() {
                return shown(this)
            },
        })
        try {
            expect(caramelFindOrderTotal()?.id).toBe('t')
        } finally {
            Object.defineProperty(proto, 'innerText', prior)
        }
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

    it('asking whether the finder sees a box never moves the total marker', () => {
        document.body.innerHTML =
            PROMO_BOX +
            TOTAL +
            '<div id="marked" data-caramel-found="total">$5.00</div>'

        expect(caramelFinderSeesBox()).toBe(true)
        expect(document.querySelector('[data-caramel-found="total"]')?.id).toBe(
            'marked',
        )
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

    it("watches for the store's answer just outside the box's own row too", async () => {
        document.body.innerHTML =
            '<aside><div class="sec"><div class="row">' +
            '<input id="dc" name="discount_code" type="text"><button id="ap" type="button">Apply</button>' +
            '</div></div><p id="msg"></p></aside>' +
            TOTAL

        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(
            document
                .querySelector(rec.caramelAnswer)
                ?.contains(document.getElementById('msg')),
        ).toBe(true)
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
        ])
            expect(rec[k]).toBeNull()
        // Its toggle is only ever the one the finder itself marks.
        expect(rec.showInput).toBe('[data-caramel-found="toggle"]')
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
        // Kept, so the box can be opened again if the store folds it again.
        expect(document.querySelector(rec.showInput)?.id).toBe('tg')
    })
})

describe('finding the same box again after the store re-draws it', () => {
    const GIFT =
        '<div class="gift"><label for="gc">Redeem gift card</label>' +
        '<input id="gc" name="gift_card_redeem" type="text">' +
        '<button id="ga" type="button">Redeem</button></div>'

    it('never takes a gift-card box while ours is disabled for the request', async () => {
        document.body.innerHTML = PROMO_BOX + GIFT + TOTAL
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })
        // The store re-draws the promo box disabled while it answers.
        document.querySelector('.promo').outerHTML = PROMO_BOX.replace(
            'type="text"',
            'type="text" disabled',
        )

        expect(caramelRemarkFoundBox(false, rec)).toBe(false)
        expect(document.querySelector(rec.couponInput)).toBeNull()

        document.getElementById('dc').disabled = false
        expect(caramelRemarkFoundBox(false, rec)).toBe(true)
        expect(document.querySelector(rec.couponInput)?.id).toBe('dc')
    })

    it('marks the new box when the store keeps the old one hidden', async () => {
        document.body.innerHTML = PROMO_BOX + TOTAL
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })
        const old = document.querySelector('.promo')
        old.style.display = 'none'
        old.insertAdjacentHTML(
            'afterend',
            PROMO_BOX.replace(/"(dc|ap)"/g, '"$1-2"'),
        )

        expect(caramelRemarkFoundBox(false, rec)).toBe(true)
        expect(document.querySelector(rec.couponInput)?.id).toBe('dc-2')
        expect(document.querySelector(rec.couponSubmit)?.id).toBe('ap-2')
    })

    it('marks the toggle of a box the store re-drew folded', async () => {
        const FOLDED = open =>
            '<div class="cpn"><button id="tg" type="button" aria-expanded="false">Have a promo code?</button>' +
            `<div id="panel"${open ? '' : ' style="display:none"'}>` +
            '<input id="pc" name="promo_code" type="text"><button id="pa">Apply</button></div></div>'
        document.body.innerHTML = FOLDED(true) + TOTAL
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })
        // WooCommerce: every answer re-draws the cart, the promo panel folded.
        document.querySelector('.cpn').outerHTML = FOLDED(false)

        expect(caramelRemarkFoundBox(false, rec)).toBe(true)
        expect(document.querySelector(rec.couponInput)?.id).toBe('pc')
        expect(document.querySelector(rec.showInput)?.id).toBe('tg')
    })

    it('never re-finds a box nothing names: one wordless box looks like another', async () => {
        // React stores name a field by class alone. Ours is disabled while the
        // store answers; a voucher box beside it is just as wordless.
        const BOX = (cls, extra = '') =>
            `<div class="${cls}"><input class="${cls}-input" type="text"${extra}>` +
            '<button type="button">Apply</button></div>'
        document.body.innerHTML = BOX('promo') + TOTAL
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })
        expect(rec).not.toBeNull()
        document.querySelector('.promo').outerHTML = BOX('promo', ' disabled')
        document.body.insertAdjacentHTML('beforeend', BOX('voucher'))

        expect(caramelRemarkFoundBox(false, rec)).toBe(false)
        expect(
            document.querySelector('.voucher-input').dataset.caramelFound,
        ).toBe(undefined)
    })

    it('knows its own box after the store writes its answer into the label', async () => {
        document.body.innerHTML = PROMO_BOX + TOTAL
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })
        document.querySelector('.promo').outerHTML = PROMO_BOX.replace(
            'Discount code</label>',
            'Discount code <span>Invalid code</span></label>',
        ).replace('placeholder="Enter code"', 'placeholder="Try another code"')

        expect(caramelRemarkFoundBox(false, rec)).toBe(true)
        expect(document.querySelector(rec.couponInput)?.id).toBe('dc')
    })

    it('knows its own box when the framework gives the re-drawn one a new id', async () => {
        // React useId / MUI / Ember ids are minted again on every re-draw.
        const BOX = id =>
            `<div class="promo"><input id="${id}" placeholder="Discount code" type="text">` +
            '<button id="ap" type="button">Apply</button></div>'
        document.body.innerHTML = BOX(':r1:') + TOTAL
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })
        document.querySelector('.promo').outerHTML = BOX(':r2:')

        expect(caramelRemarkFoundBox(false, rec)).toBe(true)
        expect(document.querySelector(rec.couponInput)?.id).toBe(':r2:')
    })

    it('never opens the re-drawn box with a toggle that is not its own', async () => {
        document.body.innerHTML = PROMO_BOX + TOTAL
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })
        // The store hides our box; a gift-card fold sits elsewhere on the page.
        document.querySelector('.promo').style.display = 'none'
        document.body.insertAdjacentHTML(
            'afterbegin',
            '<section class="gc"><button id="gt" type="button" aria-expanded="false">Have a gift card?</button>' +
                '<div style="display:none"><input name="gift_card_number"></div></section>',
        )

        expect(caramelRemarkFoundBox(false, rec)).toBe(false)
        expect(
            document.querySelector('[data-caramel-found="toggle"]'),
        ).toBeNull()
    })
})

describe('a promo box folded behind a checkbox', () => {
    // A CSS-only fold: a transparent checkbox over "Have a discount code?",
    // the panel shown while it is checked. Measured live: the finder saw the
    // hidden field and no way to open it, and the shopper got no prompt.
    const FOLD =
        '<div class="collapse"><input type="checkbox" id="cb" aria-label="Toggle discount code input">' +
        '<div class="title">Have a discount code? Discounts cannot be combined with other offers.</div>' +
        '<div id="content" style="display:none"><input id="dc" name="discount_code" type="text">' +
        '<button id="ap" type="button">Apply</button></div></div>'
    const wire = () =>
        document.getElementById('cb').addEventListener('change', e => {
            document.getElementById('content').style.display = e.target.checked
                ? ''
                : 'none'
        })

    it('opens it with the checkbox that holds it', async () => {
        document.body.innerHTML = FOLD + TOTAL
        wire()

        expect(caramelFinderSeesBox()).toBe(true)
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(document.querySelector(rec.couponInput)?.id).toBe('dc')
        expect(document.querySelector(rec.showInput)?.id).toBe('cb')
    })

    it('never clicks a checkbox that is not the box’s own fold', async () => {
        // "Use gift card balance" changes what the shopper pays.
        document.body.innerHTML =
            '<div class="pay"><input type="checkbox" id="gb"><label for="gb">Use gift card balance</label></div>' +
            '<div class="promo" style="display:none"><input id="dc" name="discount_code" type="text">' +
            '<button id="ap" type="button">Apply</button></div>' +
            TOTAL

        expect(caramelFinderSeesBox()).toBe(false)
        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).toBeNull()
        expect(document.getElementById('gb').checked).toBe(false)
    })

    it('never clicks a setting that sits in the box’s own panel and says promo', async () => {
        // Marketing consent, and a card that changes what the shopper pays.
        for (const words of [
            'Email me promo codes and offers',
            'I have a discount card',
            'Use my voucher balance',
        ]) {
            document.body.innerHTML =
                `<div class="panel"><input type="checkbox" id="nl"><label for="nl">${words}</label>` +
                '<div style="display:none"><input id="dc" name="discount_code" type="text">' +
                '<button id="ap" type="button">Apply</button></div></div>' +
                TOTAL

            expect(caramelFinderSeesBox(), words).toBe(false)
            expect(
                await caramelDiscoveredRecord({ domain: 'shop.test' }),
                words,
            ).toBeNull()
            expect(document.getElementById('nl').checked, words).toBe(false)
        }
    })

    it('opens a fold whose box is only drawn once it is checked', async () => {
        document.body.innerHTML =
            '<div class="promo"><input type="checkbox" id="cb"><label id="lb" for="cb">Have a promo code?</label>' +
            '<div id="slot"></div></div>' +
            TOTAL
        document.getElementById('cb').addEventListener('change', e => {
            document.getElementById('slot').innerHTML = e.target.checked
                ? '<input id="dc" name="discount_code" type="text"><button id="ap" type="button">Apply</button>'
                : ''
        })

        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(document.querySelector(rec.couponInput)?.id).toBe('dc')
        expect(document.querySelector(rec.showInput)?.id).toBe('lb')
    })

    it('puts a checkbox back when checking it showed no box', async () => {
        // Its words named a code, but it opened nothing: whatever it changed,
        // the shopper did not ask for.
        document.body.innerHTML =
            '<div class="promo"><input type="checkbox" id="cb"><label for="cb">Have a promo code?</label>' +
            '<div style="display:none"><input id="dc" name="discount_code" type="text">' +
            '<button id="ap" type="button">Apply</button></div></div>' +
            TOTAL

        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).toBeNull()
        expect(document.getElementById('cb').checked).toBe(false)
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
