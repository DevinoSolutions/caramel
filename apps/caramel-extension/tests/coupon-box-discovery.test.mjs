import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoverCouponBox,
    caramelDiscoveredRecord,
    caramelFinderMayAsk,
    caramelFinderSeesBox,
    caramelFinderTotalNow,
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
import { EXT_ROOT } from './_entry-modules.mjs'
import { finderOnlyGetURL } from './_finder-asset.mjs'

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
let flagReadThrows
let logCalls
// The couponBoxLlm flag: may the finder ask the server for a box it missed.
let llmOn

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
        log: (...args) => logCalls.push(args),
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
    stub.runtime.getURL = finderOnlyGetURL
    stub.runtime.sendMessage = (message, cb) => {
        if (flagReadThrows && message?.action === 'couponBoxDiscoveryEnabled')
            throw new Error('Extension context invalidated')
        if (message?.action === 'fetchCoupons') cb({ coupons: COUPONS })
        else if (message?.action === 'couponBoxDiscoveryEnabled')
            cb({ enabled: flagOn })
        else if (message?.action === 'couponBoxLlmEnabled')
            cb({ enabled: llmOn })
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
    flagReadThrows = false
    logCalls = []
    llmOn = false
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

// A control that adds to the cart, buys, adds a gift extra, protection or a
// donation, updates the cart, subscribes or signs the shopper in is never the
// box's apply button or its reveal, whatever else it says. The server's pick
// is held to the same words (coupon-box-pick.test.mjs).
describe('the finder never takes a control that is not a code', () => {
    for (const label of [
        'Apply and update cart',
        'Update cart',
        'Update quantity',
        'Round up and apply',
        'Add gift wrap',
        'Add a gift message',
        'Add protection',
        'Add warranty',
        'Add shipping insurance',
        'Add a $1 donation',
        'Subscribe',
        'Sign up and apply',
        'Sign in',
        'Log in',
        'Buy now',
        'Save for later',
    ])
        it(`"${label}" beside a promo field is never its apply button`, () => {
            document.body.innerHTML =
                '<div><input id="pc" name="discount_code" type="text">' +
                `<button id="b" type="button">${label}</button></div>` +
                TOTAL

            expect(caramelDiscoverCouponBox().button).toBeNull()
        })

    const folded = reveal =>
        `<button id="tg" type="button" aria-expanded="false">${reveal}</button>` +
        '<div id="panel" style="display:none"><label for="dc">Discount code</label>' +
        '<input id="dc" name="discount_code" type="text">' +
        '<button id="ap" type="button">Apply</button></div>' +
        TOTAL
    const watchReveal = () => {
        let clicks = 0
        document.getElementById('tg').addEventListener('click', () => {
            clicks++
            document.getElementById('panel').style.display = ''
        })
        return () => clicks
    }

    for (const reveal of [
        'Add a gift card',
        'Add gift wrap',
        'Add a gift message',
        'Sign in for a discount code',
        'Subscribe for a promo code',
    ])
        it(`"${reveal}" is never clicked as the reveal`, async () => {
            document.body.innerHTML = folded(reveal)
            const clicks = watchReveal()

            expect(caramelFinderSeesBox()).toBe(false)
            expect(
                await caramelDiscoveredRecord({ domain: 'shop.test' }),
            ).toBeNull()
            expect(clicks()).toBe(0)
        })

    it('a reveal that names a code is still clicked, and its box used (the control case)', async () => {
        document.body.innerHTML = folded('Have a promo code?')
        const clicks = watchReveal()

        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(clicks()).toBe(1)
        expect(document.querySelector(rec.couponInput)?.id).toBe('dc')
    })
})

describe("an apply button with no apply word is taken only in the box's own panel", () => {
    // Seven button shapes a store puts beside a promo field, two of them
    // labelled for a screen reader ("Submit", "Go"), the rest an icon or an
    // arrow and nothing else.
    const SHAPES = {
        'svg, no name': '<button id="shape" type="button"><svg></svg></button>',
        'svg, aria "Submit"':
            '<button id="shape" type="button" aria-label="Submit"><svg></svg></button>',
        'arrow, aria "Go"':
            '<button id="shape" type="button" aria-label="Go">→</button>',
        'bare arrow': '<button id="shape" type="button">›</button>',
        'icon span, submit':
            '<button id="shape" type="submit"><span class="icon icon-arrow"></span></button>',
        'input submit "›"': '<input id="shape" type="submit" value="›">',
        'svg, class cart-remove':
            '<button id="shape" type="button" class="cart-remove"><svg></svg></button>',
    }
    const FIELD =
        '<label for="dc">Discount code</label>' +
        '<input id="dc" name="discount_code" type="text">'
    const LINE = name =>
        `<div class="line"><p>${name}, organic cotton, relaxed fit, machine ` +
        'washable, ships in recycled packaging within two business days. Free ' +
        'returns for thirty days.</p>' +
        '<select name="updates[]"><option>1</option><option>2</option></select>' +
        '<span>$49.00</span>'
    // The box's own panel, its own small form, and a whole-cart form in which
    // the button sits in a line item, away from the box.
    const CONTAINERS = {
        'small panel': shape =>
            `<div class="promo">${FIELD}${shape}</div>${TOTAL}`,
        'small form': shape =>
            `<form class="promo">${FIELD}${shape}</form>${TOTAL}`,
        'whole-cart form': shape =>
            '<form id="cart" action="/cart" method="post"><div class="items">' +
            `${LINE('Field jacket')}<div class="actions">${shape}</div></div>` +
            `${LINE('Wool sweater')}</div>${LINE('Canvas tote')}</div></div>` +
            `<div class="summary"><div class="promo">${FIELD}</div>${TOTAL}</div></form>`,
    }
    // The two with an apply word in their aria-label are labelled, and a
    // labelled apply is taken wherever it sits, as before. The rest are taken
    // only in the box's own panel or small form, and a remove icon nowhere.
    const TAKEN = {
        'small panel': [true, true, true, true, true, true, false],
        'small form': [true, true, true, true, true, true, false],
        'whole-cart form': [false, true, true, false, false, false, false],
    }

    for (const [where, build] of Object.entries(CONTAINERS))
        Object.keys(SHAPES).forEach((shape, i) =>
            it(`${shape}, in a ${where}: ${TAKEN[where][i] ? 'taken' : 'never taken'}`, () => {
                document.body.innerHTML = build(SHAPES[shape])

                const found = caramelDiscoverCouponBox()

                expect(found.input?.id).toBe('dc')
                expect(found.button?.id === 'shape').toBe(TAKEN[where][i])
            }),
        )

    for (const attrs of [
        'class="qty-plus"',
        'id="removeItem"',
        'name="checkout"',
        'data-action="delete"',
        'data-testid="cart-item-trash"',
        'class="btn" data-role="quantity-down"',
        'class="signup-icon"',
        'data-action="subscribe"',
        'class="icon wishlist"',
        'data-testid="logIn"',
    ])
        it(`an icon whose own attributes say so (${attrs}) is never the apply, even in the box's panel`, () => {
            document.body.innerHTML = CONTAINERS['small panel'](
                `<button type="button" ${attrs}><svg></svg></button>`,
            )

            expect(caramelDiscoverCouponBox().button).toBeNull()
        })

    it("an icon in the box's panel is taken over a remove icon in the same panel", () => {
        document.body.innerHTML =
            `<div class="promo">${FIELD}` +
            '<button id="rm" type="button" class="cart-remove"><svg></svg></button>' +
            '<button id="shape" type="submit" class="promo-submit"><svg></svg></button>' +
            `</div>${TOTAL}`

        expect(caramelDiscoverCouponBox().button?.id).toBe('shape')
    })
})

describe('a product named like a loyalty program is not a rewards section', () => {
    // A cart <form> or <section> wraps the line items and the promo box, so
    // its first heading is a product title. A product called "Military Green
    // Parka" must not make the promo box's Apply read as a military discount.
    const PRODUCTS = [
        'Military Green Parka',
        'Student Backpack',
        '6 Point Socket Set',
        'Teacher Appreciation Mug',
        'Rewards Card Wallet',
    ]
    const item = title =>
        `<div class="cart-item"><h3>${title}</h3><p>Qty 1</p><span>$100.00</span></div>`
    const linkedItem = title =>
        `<li class="line"><a href="/products/p"><img alt=""></a>` +
        `<h3 class="t"><a href="/products/p">${title}</a></h3>` +
        `<span class="p">$100.00</span></li>`
    for (const title of PRODUCTS)
        for (const [shape, html] of [
            [
                'a cart form',
                `<form action="/cart" method="post">${item(title)}${PROMO_BOX}</form>`,
            ],
            [
                'a cart section',
                `<section class="cart"><ul>${linkedItem(title)}</ul>${PROMO_BOX}</section>`,
            ],
            [
                'a cart section with its own heading',
                `<section class="cart"><h2>Your cart</h2>${item(title)}${PROMO_BOX}</section>`,
            ],
            [
                'a cart section whose line item shows only a quantity',
                `<section class="cart"><div class="row"><h3>${title}</h3>` +
                    `<select name="qty"><option>1</option></select></div>${PROMO_BOX}</section>`,
            ],
        ])
            it(`"${title}" in ${shape}: the box and its Apply are found`, () => {
                document.body.innerHTML = html + TOTAL

                expect(caramelDiscoverCouponBox().button?.id).toBe('ap')
                expect(caramelFinderSeesBox()).toBe(true)
            })

    // The same box under a section that IS a rewards or points block, named
    // by its own heading, legend or aria name, is still refused.
    for (const [label, html] of [
        [
            'a section headed "Rewards"',
            `<section><h3>Rewards</h3>${PROMO_BOX}</section>`,
        ],
        [
            'a section headed "Use points" in a wrapper',
            `<section><div class="hd"><h2>Use points</h2></div>${PROMO_BOX}</section>`,
        ],
        [
            'a section headed "Rewards" over a balance line',
            `<section><div class="hd"><h3>Rewards</h3><p>You have 500 points</p></div>${PROMO_BOX}</section>`,
        ],
        [
            'a fieldset for members',
            `<form><fieldset><legend>Member prices</legend>${PROMO_BOX}</fieldset></form>`,
        ],
        [
            'a form named "Rewards"',
            `<form aria-label="Rewards">${PROMO_BOX}</form>`,
        ],
        [
            'a "Your rewards" section inside a cart form of products',
            `<form>${item('Military Green Parka')}<section><h3>Your rewards</h3>${PROMO_BOX}</section></form>`,
        ],
    ])
        it(`${label}: its plain Apply is never taken`, () => {
            document.body.innerHTML = html + TOTAL

            expect(caramelDiscoverCouponBox().button).toBeNull()
            expect(caramelFinderSeesBox()).toBe(false)
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

    it('opens a folded box whose toggle is an icon named only by aria-label', async () => {
        // castlery.com.au: the row reads "Add Coupon Code" and the only control
        // is a "+" icon button carrying aria-label="Add coupon code".
        document.body.innerHTML =
            '<div class="row"><span>Add Coupon Code</span>' +
            '<button id="tg" type="button" aria-label="Add coupon code"><svg></svg></button></div>' +
            '<div id="panel" style="display:none">' +
            '<input id="pc" name="promo_code" type="text"><button id="pa">Apply</button></div>' +
            TOTAL
        document.getElementById('tg').addEventListener('click', () => {
            document.getElementById('panel').style.display = ''
        })

        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(document.querySelector(rec.couponInput)?.id).toBe('pc')
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

    it('keeps an id a person wrote, numbers and all', async () => {
        const BOX =
            '<div class="promo"><input id="coupon1234" type="text"><button id="ap" type="button">Apply</button></div>'
        document.body.innerHTML = BOX + TOTAL
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })
        document.querySelector('.promo').outerHTML = BOX

        expect(rec?.caramelInputSig).toBe('i:coupon1234')
        expect(caramelRemarkFoundBox(false, rec)).toBe(true)
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

    it('opens a fold that speaks of entering a code, whatever else it mentions', async () => {
        for (const words of [
            'Save with a promo code?',
            'Have a gift card or promo code?',
            'Enter a promotional code or offer code',
            'Got a coupon?',
        ]) {
            document.body.innerHTML =
                `<div class="promo"><input type="checkbox" id="cb"><label id="lb" for="cb">${words}</label>` +
                '<div id="content" style="display:none"><input id="dc" name="discount_code" type="text">' +
                '<button id="ap" type="button">Apply</button></div></div>' +
                TOTAL
            document.getElementById('cb').addEventListener('change', e => {
                document.getElementById('content').style.display = e.target
                    .checked
                    ? ''
                    : 'none'
            })

            const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

            expect(document.querySelector(rec?.couponInput)?.id, words).toBe(
                'dc',
            )
        }
    })

    it('never clicks a radio, which a second click cannot put back', async () => {
        // A payment-method pick that happens to mention a promo code.
        document.body.innerHTML =
            '<div class="pay"><input type="radio" id="r0" name="pay" checked><label for="r0">Card</label>' +
            '<input type="radio" id="r1" name="pay"><label for="r1">Redeem promo code</label>' +
            '<div style="display:none"><input id="dc" name="discount_code" type="text">' +
            '<button id="ap" type="button">Apply</button></div></div>' +
            TOTAL

        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).toBeNull()
        expect(document.getElementById('r0').checked).toBe(true)
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

    it('flag unreadable: the finder stays off and the failure is logged, not swallowed', async () => {
        flagReadThrows = true
        document.body.innerHTML = PROMO_BOX + TOTAL

        await tryInitialize()

        expect(promptedWith).toHaveLength(0)
        const logged = logCalls.find(c => c[0] === 'FINDER_FLAG_UNREADABLE')
        expect(logged?.[1].error).toMatch(/Extension context invalidated/)
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

// A cart whose promo box the rules cannot see. Without the server pick there
// is nothing to offer; with it, the prompt is the only way the pick is ever
// reached, because the pick runs after the shopper's tap.
describe('the server pick needs a prompt to be reached', () => {
    const NO_BOX = '<div class="lines"><span>One item</span></div>'

    it('pick flag off: a cart the rules see no box on gets no prompt, exactly as before', async () => {
        document.body.innerHTML = NO_BOX + TOTAL

        await tryInitialize()

        expect(promptedWith).toHaveLength(0)
    })

    it('pick flag on: the same cart gets the prompt', async () => {
        llmOn = true
        document.body.innerHTML = NO_BOX + TOTAL

        await tryInitialize()

        expect(promptedWith).toHaveLength(1)
    })

    it('pick flag on, finder flag off: no prompt', async () => {
        llmOn = true
        flagOn = false
        document.body.innerHTML = NO_BOX + TOTAL

        await tryInitialize()

        expect(promptedWith).toHaveLength(0)
    })

    it('pick flag on: never on a page that is not a cart', async () => {
        llmOn = true
        setPath('/')
        document.body.innerHTML = NO_BOX + TOTAL

        await tryInitialize()

        expect(promptedWith).toHaveLength(0)
    })

    it('pick flag on: no readable total, nothing could be measured, no prompt', async () => {
        llmOn = true
        document.body.innerHTML = NO_BOX

        await tryInitialize()

        expect(promptedWith).toHaveLength(0)
    })

    it('pick flag on: a store already asked this tab session is not offered again', async () => {
        llmOn = true
        sessionStorage.setItem('caramel_box_pick:' + location.hostname, '1')
        document.body.innerHTML = NO_BOX + TOTAL

        await tryInitialize()

        expect(promptedWith).toHaveLength(0)
    })

    it('pick flag on: never on a page shown after the order is placed', async () => {
        llmOn = true
        for (const path of [
            '/checkout/order-received/123/',
            '/checkout/onepage/success/',
            '/checkouts/c/abc123/thank-you',
            '/order-confirmation',
        ]) {
            setPath(path)
            document.body.innerHTML = NO_BOX + TOTAL
            promptedWith = []

            await tryInitialize()

            expect(promptedWith, path).toHaveLength(0)
        }
    })

    it('pick flag on: an empty cart ($0.00) gets no prompt', async () => {
        llmOn = true
        document.body.innerHTML =
            NO_BOX +
            '<div class="row"><span>Total</span><span>$0.00</span></div>'

        await tryInitialize()

        expect(promptedWith).toHaveLength(0)
    })

    it('pick flag on: a total row the shopper cannot see gets no prompt', async () => {
        llmOn = true
        // A closed mini-cart drawer still holding its total.
        document.body.innerHTML =
            NO_BOX + '<div id="drawer" style="display:none">' + TOTAL + '</div>'
        // A browser's innerText of an element it does not render is its
        // textContent; this file's layout stub answers '' instead, which would
        // hide the row from every reader and prove nothing.
        for (const el of document.querySelectorAll('#drawer, #drawer *'))
            Object.defineProperty(el, 'innerText', {
                get() {
                    return this.textContent
                },
            })

        await tryInitialize()

        expect(promptedWith).toHaveLength(0)
    })

    it('after the tap asked the server, the same store is not offered again', async () => {
        llmOn = true
        document.body.innerHTML = NO_BOX + TOTAL
        await tryInitialize()
        expect(promptedWith).toHaveLength(1)

        // The tap: the pick is asked (and misses here), the codes are handed
        // over to copy.
        await startApplyingCoupons(promptedWith[0])
        expect(finalModals.at(-1)[2]).toMatch(/couldn't find the promo box/)

        promptedWith = []
        await tryInitialize()
        expect(promptedWith).toHaveLength(0)
    })

    it('the asked-memory reads a store the way the pick wrote it', async () => {
        llmOn = true
        document.body.innerHTML = NO_BOX + TOTAL
        await startApplyingCoupons(caramelConfiglessRecord('Shop.Test'))

        // A catalogue domain in another case, or with stray whitespace.
        expect(await caramelFinderMayAsk(' SHOP.test ')).toBe(false)
        expect(await caramelFinderMayAsk('other.test')).toBe(true)
    })
})

// The subtotal reader on a cart with no total row nets the subtotal of a coupon
// line the code added. Driven directly here, so the store's answer reader (which
// also refuses a code beside a fresh rejection) cannot stand in for it.
describe('a subtotal is netted only of a line the code added', () => {
    const SUMMARY =
        '<div class="sum"><div class="row" id="sub"><span>Subtotal</span> <span>$99.99</span></div></div>'
    // A summary drawn as one flat grid: every label and value is a sibling.
    const GRID =
        '<div class="sum"><span>Subtotal</span> <span id="sub">$99.99</span> <span>Shipping</span> <span>$4.00</span>' +
        ' <span>Tax</span> <span>$1.00</span> <span>Total</span> <span>$104.99</span></div>'
    function after(line, summary = SUMMARY, code = '') {
        document.body.innerHTML = summary
        const rec = { priceContainer: '#sub', caramelTotalKind: 'subtotal' }
        caramelFinderTotalNow(rec, document, true, code)
        document.querySelector('.sum').insertAdjacentHTML('beforeend', line)
        return caramelFinderTotalNow(rec)
    }

    it('nets a coupon line drawn as a label and a value cell', () => {
        expect(
            after(
                '<div class="cl"><span>Coupon</span><span>- $20.00</span></div>',
            ),
        ).toBe(79.99)
    })

    it('reads no deduction from a refused row whose amount sits in its own cell', () => {
        expect(
            after(
                '<div class="cl"><span>Promo code</span><span>- $5.00</span>' +
                    '<small>Minimum order $50.00</small></div>',
            ),
        ).toBe(99.99)
    })

    it.each([['SPRING-$10'], ['PROMO-$10'], ['COUPON-$10']])(
        'reads no amount out of the code name %s',
        name => {
            expect(
                after(
                    `<div class="cl"><span>Coupon code</span> <span>${name}</span></div>` +
                        '<div class="cl"><span>Discount</span> <span>-$2.00</span></div>',
                ),
            ).toBe(97.99)
        },
    )

    // In a summary drawn as one flat grid the coupon line's "row" is the whole
    // summary, and a refusal there ("Minimum order total | $50.00") is drawn
    // exactly like a summary line: the line is refused, never guessed at.
    it('refuses rather than guesses at a coupon line in a flat grid', () => {
        expect(after(' <span>Coupon</span> <span>-$5.00</span>', GRID)).toBe(
            99.99,
        )
    })

    it.each([
        ['<span>Not applied</span> <span>$50.00</span>'],
        ['<span>Pending</span>'],
        ['<span>off your next order</span>'],
    ])(
        'reads no deduction from a coupon row whose value cell is followed by %s',
        note => {
            expect(
                after(
                    `<div class="cl"><span>Promo</span> <span>-$5.00</span> ${note}</div>`,
                ),
            ).toBe(99.99)
        },
    )

    it.each([
        ['<button>Remove coupon</button>'],
        ['<a href="#">Remove code</a>'],
        ['<a href="#">Edit</a>'],
    ])('nets a coupon line followed by a %s control', control => {
        expect(
            after(
                `<div class="cl"><span>Coupon</span> <span>-$5.00</span> ${control}</div>`,
            ),
        ).toBe(94.99)
    })

    // A flat grid's refusal is drawn exactly like a summary line, and a note
    // may sit before the label: neither may be read as a saving.
    it.each([
        [
            ' <span>Promo</span> <span>-$5.00</span> <span>Minimum order</span> <span>$50.00</span>',
        ],
        [' <span>Not applied</span> <span>Promo</span> <span>-$5.00</span>'],
        [' <span>Promo</span> <span>-$5.00</span> <span>Pending</span>'],
        [
            ' <span>Promo</span> <span>-$5.00</span> <span>off your next order</span>',
        ],
    ])('reads no deduction from a refused line in a flat grid: %s', line => {
        expect(after(line, GRID)).toBe(99.99)
    })

    it('nets a coupon line whose capitalised label is glued to its amount', () => {
        expect(
            after(
                '<div class="cl"><span>COUPON</span><span>-$5.00</span></div>',
            ),
        ).toBe(94.99)
    })

    it('nets a coupon line followed by a two-word Edit link', () => {
        expect(
            after(
                '<div class="cl"><b>Coupon</b> -$5.00 Edit coupon code</div>',
            ),
        ).toBe(94.99)
    })

    // Review 5: four lines read as savings that did not happen. A line holds
    // ONE amount; a struck-out old amount, a threshold after it, a qualifier
    // in brackets or an "up to" is not a deduction we can claim.
    it.each([
        ['<div class="cl"><b>Coupon</b> <s>-$10.00</s> -$5.00</div>'],
        [
            '<div class="cl"><span>Promo</span><span>-$5.00</span><span>Orders over</span><span>$150.00</span></div>',
        ],
        [
            '<div class="cl"><span>Promo</span><span>-$5.00</span><span>Free delivery over</span><span>$150.00</span></div>',
        ],
        [
            '<table><tr><td>Coupon</td><td>-$5.00</td><td>Orders over $150.00</td></tr></table>',
        ],
        ['<div class="cl"><b>Promo</b> -$5.00 (on your next order)</div>'],
        ['<div class="cl"><b>Promo</b> -$5.00 (on orders over $150.00)</div>'],
        ['<div class="cl"><b>Promo</b> -$5.00 (not yet active)</div>'],
        ['<div class="cl"><b>Promo</b> -$5.00 (Pro price)</div>'],
        ['<div class="cl"><b>Discount</b> up to -$10.00</div>'],
    ])('reads no deduction from %s', line => {
        expect(after(line)).toBe(99.99)
    })

    // Review 6: a refusal word list always misses the next phrasing, and an
    // amount in a format the money reader misses slips past a one-amount
    // count. A coupon line nets only in ONE shape: its label, at most a code
    // name, one amount marked as a deduction, then only a currency code or a
    // Remove/Edit control.
    it.each([
        '<span>Orders over</span><span>150.00</span>',
        '<span>Orders over</span><span>150</span>',
        '<span>Orders over</span><span>Rp150.000</span>',
        '<span>Orders over</span><span>150 usd</span>',
    ])('reads no deduction from a line followed by %s', tail => {
        expect(
            after(
                `<div class="cl"><span>Promo</span><span>-$5.00</span>${tail}</div>`,
            ),
        ).toBe(99.99)
    })

    it.each([
        '<b>Coupon</b> (not yet active) -$5.00',
        '<span>Coupon (not yet active)</span> <span>-$5.00</span>',
        '<b>Promo</b> -$5.00 (inactive)',
        '<b>Promo</b> -$5.00 (next-order)',
        '<b>Promo</b> -$5.00 (in-store)',
        '<b>Discount</b> (max) -$10.00',
        '<b>Discount</b> upto -$10.00',
        '<b>Coupon</b> for your next order -$5.00',
    ])('reads no deduction from the qualified line %s', line => {
        expect(after(`<div class="cl">${line}</div>`)).toBe(99.99)
    })

    it('nets a real line whose value cell is followed by a framework comment', () => {
        expect(
            after(
                '<div class="cl"><span>Handling</span><span>$2.00</span><span>Promo</span><span>-$5.00</span><!--v-if--><!-- /ko --></div>',
            ),
        ).toBe(94.99)
    })

    it.each([
        [
            '<b>Coupon (SAVE20) applied</b> -$5.00 <a href="#">Remove</a>',
            'SAVE20',
        ],
        ['<b>Promo code:</b> (WELCOME) -$5.00', 'welcome'],
        ['<b>Coupon (SAVE10)</b>-$5.00', 'SAVE10'],
        [
            '<span>Coupon: freeship</span> <span>-$5.00 [Remove]</span>',
            'freeship',
        ],
        ['<span>Discount</span><span>- $ 5.00</span>', ''],
        ['<span>Coupon</span><span>($5.00)</span>', ''],
    ])('nets the real coupon line %s', (line, code) => {
        expect(after(`<div class="cl">${line}</div>`, SUMMARY, code)).toBe(
            94.99,
        )
    })

    it('still names the code in brackets: Coupon (SAVE20) -$5.00 nets', () => {
        expect(
            after(
                '<div class="cl"><b>Coupon (SAVE20)</b> -$5.00</div>',
                SUMMARY,
                'SAVE20',
            ),
        ).toBe(94.99)
    })

    it('drops the last code baseline when the next baseline read fails', () => {
        document.body.innerHTML = SUMMARY
        const rec = { priceContainer: '#sub', caramelTotalKind: 'subtotal' }
        caramelFinderTotalNow(rec, document, true, 'OLD10')
        expect(rec.caramelSubtotalBase?.code).toBe('OLD10')
        document.body.innerHTML = ''
        expect(caramelFinderTotalNow(rec, document, true, 'NEW20')).toBeNaN()
        expect(rec.caramelSubtotalBase).toBeNull()
    })

    // Without the typed code no code name is accepted, so a call site that
    // stops passing it silently loses every named coupon line.
    it('passes the typed code from both apply paths to the baseline read', () => {
        const apply = readFileSync(join(EXT_ROOT, 'coupon-apply.js'), 'utf8')
        const capture = readFileSync(join(EXT_ROOT, 'code-capture.js'), 'utf8')
        expect(apply).toContain(
            'caramelFinderTotalNow(rec, document, true, code)',
        )
        expect(apply).toContain('caramelSnapshotCart(rec, code)')
        expect(capture).toContain('caramelSnapshotCart(rec, code)')
        expect(apply).not.toContain('caramelSnapshotCart(rec)')
        expect(capture).not.toContain('caramelSnapshotCart(rec)')
    })

    // Review 7: the only name a line may carry is the code that was typed.
    // An all-caps status looks like a code; a note after the amount in any
    // script, or a glyph, is words; a three-letter word is not a currency.
    it.each([
        ['<b>Coupon</b> (INACTIVE) -$5.00', 'SAVE20'],
        ['<b>Coupon</b> (REMOVED) -$5.00', 'SAVE20'],
        ['<b>Coupon</b> NOT-APPLIED -$5.00', 'SAVE20'],
        ['<b>Coupon (OTHER10)</b> -$5.00', 'SAVE20'],
        ['<b>Coupon (SAVE20)</b> -$5.00', ''],
        ['<span>Coupon</span><span>-$5.00</span><span>未適用</span>', 'SAVE20'],
        [
            '<span>Coupon</span><span>-$5.00</span><span>не применён</span>',
            'SAVE20',
        ],
        ['<span>Coupon</span><span>-$5.00</span><span>⚠</span>', 'SAVE20'],
        ['<b>Coupon</b> -NEW20.00', 'SAVE20'],
    ])('reads no deduction from %s', (line, code) => {
        expect(after(`<div class="cl">${line}</div>`, SUMMARY, code)).toBe(
            99.99,
        )
    })

    it.each([
        ['<b>Cart coupon</b>- $5.00'],
        ['<b>Order discount</b>-$5.00'],
        ['<b>Basket promo</b>- $5.00'],
        ['<b>Coupon applied:</b>-$5.00'],
        ['<b>Coupon</b> ‏-$5.00'],
    ])('nets the real coupon line %s', line => {
        expect(after(`<div class="cl">${line}</div>`)).toBe(94.99)
    })

    it('nets a coupon line that ends in a currency code', () => {
        expect(
            after(
                '<div class="cl"><span>Coupon</span> <span>-$5.00 CHF</span></div>',
            ),
        ).toBe(94.99)
    })
})

describe('the finder reads a page in bounded time, whatever text it holds', () => {
    // Every rule is a regular expression over words the store wrote. One with
    // an open-ended run is tried again from every character of a long word,
    // and a page that carries 40 KiB of one (a serialized blob, a long
    // number, a run of brackets) held the content script for seconds on each
    // read. Each case is one such page; each was over a second before.
    const LONG = 40 * 1024
    const timed = fn => {
        const t0 = performance.now()
        const out = fn()
        return { out, ms: performance.now() - t0 }
    }
    // Generous against a slow machine; the unbounded rules took seconds.
    const BUDGET_MS = 400

    it('a long word beside the Apply button: the box and its Apply, at once', () => {
        document.body.innerHTML =
            '<div class="promo"><label for="dc">Discount code</label>' +
            '<input id="dc" name="discount_code" type="text">' +
            '<button id="ap" type="button">Apply</button>' +
            `<span>${'orandcodes'.repeat(LONG / 10)}</span></div>` +
            TOTAL

        const { out, ms } = timed(() => caramelDiscoverCouponBox())

        expect(out.button?.id).toBe('ap')
        expect(ms).toBeLessThan(BUDGET_MS)
    })

    it('a long number beside a "Total" word: the real total, at once', () => {
        document.body.innerHTML = `<p>Total ${'1'.repeat(LONG)}x</p>` + TOTAL

        const { out, ms } = timed(() => caramelFindOrderTotal())

        expect(out?.textContent).toContain('$100.00')
        expect(ms).toBeLessThan(BUDGET_MS)
    })

    it('a run of unclosed brackets beside a "Total" word: the real total, at once', () => {
        document.body.innerHTML = `<p>Total ${'('.repeat(LONG)}</p>` + TOTAL

        const { out, ms } = timed(() => caramelFindOrderTotal())

        expect(out?.textContent).toContain('$100.00')
        expect(ms).toBeLessThan(BUDGET_MS)
    })

    it('a box whose only name is a long id: found and remembered, at once', async () => {
        const id = 'a'.repeat(LONG)
        document.body.innerHTML =
            `<div class="promo"><label for="${id}">Discount code</label>` +
            `<input id="${id}" type="text">` +
            '<button id="ap" type="button">Apply</button></div>' +
            TOTAL

        const t0 = performance.now()
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })
        const ms = performance.now() - t0

        // Letters only: not an id a framework generates, so it names the box.
        expect(rec.caramelInputSig).toBe('i:' + id)
        expect(ms).toBeLessThan(BUDGET_MS)
    })
})
