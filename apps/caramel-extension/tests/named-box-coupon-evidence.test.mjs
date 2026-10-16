import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    _caramelResetDiscoveryFlag,
    caramelFinderSees,
} from '../coupon-box-discovery.js'
import { LEARNED_KEY } from '../coupon-box-learned.js'
import { caramelPageOutline } from '../coupon-box-outline.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import { caramelConfiglessRecord, getDomainRecord } from '../store-detect.js'

// A box someone else named: the server's pick (by its place in the outline),
// a box the server learned from other installs (by selectors), and a box this
// install remembers (by selectors). The page is the last line of defence for
// all three, so each must pass the coupon-word checks a box the rules find
// passes, and the click guards:
//   · its field carries a coupon word (its name, label, placeholder,
//     aria-label or the short region around it), and never takes points;
//   · its apply button says apply (Apply, Redeem, Submit, OK, or an arrow
//     with an apply label), or there is none and the box applies on Enter;
//   · its toggle names a code, and is never a checkbox, radio or switch;
//   · nothing that adds to the cart, buys, adds a gift extra, protection or a
//     donation, updates the cart, subscribes, signs in, or spends points is
//     ever clicked, by a pick or by the rules.
// llm_only throughout, so the rules never stand in for a refused part.

const LEARNED_FILE = pathToFileURL(
    resolve(import.meta.dirname, '../coupon-box-learned.js'),
).href
const OUTLINE_FILE = pathToFileURL(
    resolve(import.meta.dirname, '../coupon-box-outline.js'),
).href

let finalModals
let appliedWith
let mode
let answer
let pickCalls
let reported
let local

vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: async (code, rec) => {
        appliedWith.push({ code, rec })
        return { success: false, applied: false }
    },
    probeCartJson: async () => null,
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showFinalModal: (...args) => finalModals.push(args),
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
        sleep: () => new Promise(resolve => setTimeout(resolve, 0)),
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
    for (const area of ['sync', 'session']) {
        stub.storage[area].get = (_keys, cb) => cb?.({})
        stub.storage[area].set = (_items, cb) => cb?.()
    }
    stub.storage.local.get = (keys, cb) =>
        cb(
            Object.fromEntries(
                [].concat(keys).map(k => [k, structuredClone(local[k])]),
            ),
        )
    stub.storage.local.set = (items, cb) => {
        Object.assign(local, structuredClone(items))
        cb?.()
    }
    stub.runtime.lastError = undefined
    stub.runtime.getURL = path =>
        path === 'assets/coupon-box-learned.js'
            ? LEARNED_FILE
            : path === 'assets/coupon-box-outline.js'
              ? OUTLINE_FILE
              : 'chrome-extension://caramel/' + path
    stub.runtime.sendMessage = (message, cb) => {
        const a = message?.action
        if (a === 'fetchCoupons')
            cb({ coupons: [{ code: 'SAVE20', id: 'c1' }] })
        else if (a === 'couponBoxDiscoveryEnabled') cb({ enabled: true })
        else if (a === 'couponBoxLlmEnabled') cb({ enabled: true, mode })
        else if (a === 'couponBoxPick') {
            pickCalls.push(message)
            cb(typeof answer === 'function' ? answer(message) : answer)
        } else if (a === 'couponBoxLearned') {
            reported.push(message)
            cb({ ok: true })
        } else cb?.({})
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
}

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
const PROMO_INPUT = '<input id="x" name="promo_code" type="text">'
const APPLY = '<button id="b" type="button">Apply</button>'
const $ = id => document.getElementById(id)

// The three ways a box is named, each naming the elements with these ids
// (null: not named). `enterOnly` only when no button is named.
const SOURCES = {
    'the server pick': ({ input, button, toggle }) => {
        answer = () => {
            const { elements } = caramelPageOutline(document.body)
            // A folded field is not in the outline: the pick names its toggle.
            const at = id => {
                const n = id ? elements.indexOf($(id)) : -1
                return n < 0 ? null : n
            }
            return {
                outcome: 'box',
                input: at(input),
                button: at(button),
                toggle: at(toggle),
                confidence: 90,
                why: 'test',
                cached: false,
            }
        }
    },
    'a box the server learned': ({ input, button, toggle }) => {
        answer = {
            outcome: 'box',
            source: 'learned',
            input: null,
            button: null,
            toggle: null,
            box: {
                input: input && `#${input}`,
                apply: button && `#${button}`,
                toggle: toggle && `#${toggle}`,
                enterOnly: !button,
            },
        }
    },
    'a box this install remembers': ({ input, button, toggle }) => {
        local[LEARNED_KEY] = {
            [location.hostname]: {
                v: 1,
                input: input && `#${input}`,
                apply: button && `#${button}`,
                toggle: toggle && `#${toggle}`,
                enterOnly: !button,
                source: 'llm',
                confirmedAt: 1,
                failures: 0,
            },
        }
    },
}

const run = () =>
    startApplyingCoupons(caramelConfiglessRecord(location.hostname))
const drivenInput = () =>
    document.querySelector(appliedWith[0]?.rec.couponInput)?.id ?? null
const drivenSubmit = () =>
    document.querySelector(appliedWith[0]?.rec.couponSubmit)?.id ?? null
const gaveCodesToCopy = () =>
    expect(finalModals.at(-1)[2]).toMatch(/couldn't find the promo box/)
// Every click on the page, by element id.
const watchClicks = () => {
    const seen = []
    document.addEventListener('click', e => seen.push(e.target.id), true)
    return seen
}

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
})

beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
    window.history.replaceState({}, '', '/cart')
    finalModals = []
    appliedWith = []
    pickCalls = []
    reported = []
    local = {}
    mode = 'llm_only'
    answer = { outcome: 'no_box', confidence: 80, why: 'none', cached: false }
    getDomainRecord.cache = []
    _caramelResetDiscoveryFlag()
})

for (const [source, name] of Object.entries(SOURCES))
    describe(`${source} must look like a coupon box`, () => {
        it('a promo field and its Apply button: used (the control case)', async () => {
            document.body.innerHTML =
                '<div>' + PROMO_INPUT + APPLY + '</div>' + TOTAL
            name({ input: 'x', button: 'b' })

            await run()

            expect(drivenInput()).toBe('x')
            expect(drivenSubmit()).toBe('b')
        })

        it('an arrow button with an apply label: used', async () => {
            document.body.innerHTML =
                '<div>' +
                PROMO_INPUT +
                '<button id="b" type="button" aria-label="Apply code">→</button></div>' +
                TOTAL
            name({ input: 'x', button: 'b' })

            await run()

            expect(drivenSubmit()).toBe('b')
        })

        it('a field with no coupon word is never typed into', async () => {
            document.body.innerHTML =
                '<div><input id="x" name="order_note" type="text" placeholder="Note for the seller">' +
                APPLY +
                '</div>' +
                TOTAL
            name({ input: 'x', button: 'b' })
            const clicks = watchClicks()

            await run()

            expect(appliedWith).toHaveLength(0)
            expect(clicks).toEqual([])
            gaveCodesToCopy()
        })

        it('a field with no coupon word is never an Enter-only box either', async () => {
            document.body.innerHTML =
                '<div><input id="x" name="field_7" type="text"></div>' + TOTAL
            name({ input: 'x', button: null })

            await run()

            expect(appliedWith).toHaveLength(0)
        })

        it('a field that takes points is never typed into', async () => {
            document.body.innerHTML =
                '<div><label for="x">Points to redeem</label>' +
                '<input id="x" name="points" type="text">' +
                APPLY +
                '</div>' +
                TOTAL
            name({ input: 'x', button: 'b' })

            await run()

            expect(appliedWith).toHaveLength(0)
        })

        it('a search box that mentions a coupon is never typed into', async () => {
            document.body.innerHTML =
                '<form role="search" action="/search"><input id="x" name="q" type="text" placeholder="Search coupons">' +
                APPLY +
                '</form>' +
                TOTAL
            name({ input: 'x', button: 'b' })

            await run()

            expect(appliedWith).toHaveLength(0)
        })

        it('a button that does not say apply is never clicked, nor swapped for Enter', async () => {
            document.body.innerHTML =
                '<div>' +
                PROMO_INPUT +
                '<button id="b" type="button">Details</button></div>' +
                TOTAL
            name({ input: 'x', button: 'b' })
            const clicks = watchClicks()

            await run()

            expect(appliedWith).toHaveLength(0)
            expect(clicks).toEqual([])
        })

        for (const label of [
            'Add to cart',
            'Add gift wrap',
            'Add a gift message',
            'Add protection',
            'Add warranty',
            'Add shipping insurance',
            'Add a $1 donation',
            'Round up and apply',
            'Update cart',
            'Apply and update cart',
            'Update quantity',
            'Submit newsletter',
            'Subscribe',
            'Sign in',
            'Sign up and apply',
            'Log in',
            'Buy now',
            'Save for later',
            'Redeem points',
            'Use my rewards',
            'Apply loyalty discount',
            'Use membership',
        ])
            it(`"${label}" is never clicked as the apply button`, async () => {
                document.body.innerHTML =
                    '<div>' +
                    PROMO_INPUT +
                    `<button id="b" type="button">${label}</button></div>` +
                    TOTAL
                name({ input: 'x', button: 'b' })
                const clicks = watchClicks()

                await run()

                expect(appliedWith).toHaveLength(0)
                expect(clicks).toEqual([])
            })

        // The box sits folded in a panel; the toggle named for it opens it.
        const folded = toggle =>
            toggle +
            '<div id="panel" style="display:none">' +
            PROMO_INPUT +
            APPLY +
            '</div>' +
            TOTAL
        const opens = () =>
            $('tg').addEventListener('click', () => {
                $('panel').style.display = ''
            })

        for (const [what, html] of [
            [
                'a toggle that names a code',
                '<button id="tg" type="button">Have a promo code?</button>',
            ],
            [
                'a "gift card or discount code" toggle',
                '<button id="tg" type="button">Gift card or discount code</button>',
            ],
        ])
            it(`${what}: clicked, and the box it opens is used`, async () => {
                // The pick cannot name a field the outline does not show, so
                // the rules read the box the toggle opened.
                mode = 'llm_first'
                document.body.innerHTML = folded(html)
                opens()
                name({ input: 'x', button: 'b', toggle: 'tg' })
                const clicks = watchClicks()

                await run()

                expect(clicks).toEqual(['tg'])
                expect(drivenInput()).toBe('x')
            })

        for (const [what, html] of [
            ['no code', '<button id="tg" type="button">Extras</button>'],
            ['"show more"', '<button id="tg" type="button">Show more</button>'],
            [
                'a gift card',
                '<button id="tg" type="button">Add a gift card</button>',
            ],
            [
                'a gift message',
                '<button id="tg" type="button">Add a gift message</button>',
            ],
            [
                'rewards',
                '<button id="tg" type="button">Redeem rewards</button>',
            ],
            [
                'consent to mail',
                '<button id="tg" type="button">Email me a promo code</button>',
            ],
            [
                'a checkbox',
                '<label>Have a promo code? <input id="tg" type="checkbox"></label>',
            ],
            [
                'a label for a checkbox',
                '<input id="cb" type="checkbox"><label id="tg" for="cb">Have a promo code?</label>',
            ],
            [
                'a switch',
                '<button id="tg" type="button" role="switch" aria-checked="false">Promo code</button>',
            ],
            [
                'a radio',
                '<div id="tg" role="radio" aria-checked="false">Use a promo code</div>',
            ],
        ])
            it(`a toggle that is ${what} is never clicked`, async () => {
                document.body.innerHTML = folded(html)
                opens()
                name({ input: 'x', button: 'b', toggle: 'tg' })
                const clicks = watchClicks()

                await run()

                expect(clicks).toEqual([])
                expect(appliedWith).toHaveLength(0)
            })
    })

// The rules find the box themselves: the same never-click words hold for
// the button and the reveal they pick.
describe('the rules never click a control that is not a code', () => {
    beforeEach(() => {
        mode = 'rules_first'
    })

    it('a promo field whose only button is "Update cart": no apply button, no run', async () => {
        document.body.innerHTML =
            '<div><label for="dc">Discount code</label>' +
            '<input id="dc" name="discount_code" type="text">' +
            '<button id="up" type="button">Update cart</button></div>' +
            TOTAL
        const clicks = watchClicks()

        await run()

        expect(appliedWith).toHaveLength(0)
        expect(clicks).toEqual([])
    })

    it('a folded field behind "Add a gift card": the reveal is never clicked', async () => {
        document.body.innerHTML =
            '<button id="tg" type="button" aria-expanded="false">Add a gift card</button>' +
            '<div id="panel" style="display:none"><label for="dc">Discount code</label>' +
            '<input id="dc" name="discount_code" type="text">' +
            APPLY +
            '</div>' +
            TOTAL
        const clicks = watchClicks()

        await run()

        expect(clicks).toEqual([])
        expect(appliedWith).toHaveLength(0)
    })
})

// A served or stored selector is data: one outside the learned-box grammar
// (coupon-box-learned.js caramelSelectorAllowed) is never even queried.
describe('a learned selector outside the grammar is never read', () => {
    const BOX =
        '<div class="c"><div class="d">' +
        PROMO_INPUT +
        APPLY +
        '</div></div>' +
        TOTAL
    for (const [what, css] of [
        // Each of these finds the promo field, were it ever run.
        ['a :has()', 'div:has(> button) > input'],
        ['five parts', 'html > body > div.c > div.d > input'],
        ['an attribute outside the list', 'input[class="x"]'],
    ])
        for (const [source, name] of Object.entries(SOURCES).slice(1))
            it(`${source}: ${what}`, async () => {
                document.body.innerHTML = BOX
                name({ input: 'x', button: 'b' })
                const box = local[LEARNED_KEY]?.[location.hostname]
                if (box) box.input = css
                else answer.box.input = css
                const spy = vi.spyOn(document, 'querySelectorAll')

                await run()

                expect(spy.mock.calls.map(c => c[0])).not.toContain(css)
                spy.mockRestore()
                expect(appliedWith).toHaveLength(0)
            })
})

// Before any run, the prompt asks whether a remembered box could be used
// here (caramelFinderSees). The same coupon-word check answers it: a box
// whose field says nothing about a code is not offered.
describe('the prompt never offers a remembered box that is not a coupon box', () => {
    const remember = () =>
        SOURCES['a box this install remembers']({
            input: 'x',
            button: 'b',
        })
    it('a promo field and its Apply button: offered (the control case)', async () => {
        document.body.innerHTML =
            '<div>' + PROMO_INPUT + APPLY + '</div>' + TOTAL
        remember()

        expect(await caramelFinderSees(location.hostname, false)).toBe(true)
    })

    it('a note field and an Apply button: not offered', async () => {
        document.body.innerHTML =
            '<div><input id="x" name="order_note" type="text">' +
            APPLY +
            '</div>' +
            TOTAL
        remember()

        expect(await caramelFinderSees(location.hostname, false)).toBe(false)
    })
})
