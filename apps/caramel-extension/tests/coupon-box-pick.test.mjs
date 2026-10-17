import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { COUPON_BOX_PICK_DEADLINE_MS } from '../background.js'
import { initCaramelBase } from '../caramel-base.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoveredRecord,
    caramelFinderSeesKeptPick,
    caramelRemarkFoundBox,
    PICK_WAIT_MS,
} from '../coupon-box-discovery.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import { caramelConfiglessRecord } from '../store-detect.js'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'
// The background's side of the per-tab handoffs (see the helper).
const handoffs = tabHandoffBackground()

// The server's pick: when the finder's rules see a total but no promo box, the
// extension may ask the server which element is the box. These pin that:
//   · nothing is asked, and the outline builder is not even loaded, unless
//     both flags are on;
//   · one ask per store per tab session, whatever the answer;
//   · the pick is checked on the page before anything is touched, and nothing
//     but a revealing toggle is ever clicked on the server's word;
//   · a usable pick runs through the normal apply flow, held to the money
//     rule; anything else ends exactly as a rule miss does.

let finalModals
let appliedWith
let flagOn
let llmOn
let pickCalls
let answer // the server's answer: an object, or a function of the request
// The outline builder is loaded from the extension's own URL, which the stub
// maps onto the source file. outlineLoads counts every time it is asked for.
// (Under jsdom import.meta.url is an http URL, which import() refuses.)
const OUTLINE_FILE = pathToFileURL(
    resolve(import.meta.dirname, '../coupon-box-outline.js'),
).href
let outlineUrl
let outlineLoads

const COUPONS = [
    {
        code: 'SAVE20',
        id: 'c1',
        discount_type: 'PERCENTAGE',
        discount_amount: 20,
    },
]

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
        // A real macrotask turn, not an instant no-op: the real apply flow
        // (the "real apply flow" tests) polls with sleep, and a no-op sleep
        // makes that poll a microtask spin that starves the next test.
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
    for (const area of ['sync', 'local', 'session']) {
        stub.storage[area].get = (_keys, cb) => {
            if (typeof cb === 'function') cb({})
        }
        stub.storage[area].set = (_items, cb) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    stub.runtime.getURL = path => {
        if (path !== 'assets/coupon-box-outline.js')
            return 'chrome-extension://caramel/' + path
        outlineLoads++
        return outlineUrl
    }
    stub.runtime.sendMessage = (message, cb) => {
        if (handoffs.answers(message, cb)) return
        const a = message?.action
        if (a === 'fetchCoupons') cb({ coupons: COUPONS })
        else if (a === 'couponBoxDiscoveryEnabled') cb({ enabled: flagOn })
        else if (a === 'couponBoxLlmEnabled') cb({ enabled: llmOn })
        else if (a === 'couponBoxPick') {
            pickCalls.push(message)
            cb(typeof answer === 'function' ? answer(message) : answer)
        } else cb({})
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
}

// jsdom has no layout: hidden = display:none on the element or an ancestor,
// everything else a 120x30 box.
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
// A box no rule recognises: the field and its button carry no coupon words.
const BARE_BOX =
    '<div class="f"><input id="x" name="field_7" type="text">' +
    '<button id="go" type="button">Go</button></div>'
// A box the rules do recognise, folded behind a toggle they do not. "Extras"
// is not an allowlisted word, so the toggle's line carries no name: TOGGLE.
const FOLDED =
    '<button id="tg" type="button">Extras</button>' +
    '<div id="panel" style="display:none"><label for="dc">Discount code</label>' +
    '<input id="dc" name="discount_code" type="text">' +
    '<button id="ap" type="button">Apply</button></div>'

const TOGGLE = /\] button$/

// The index the outline gave the element on the line matching `re`.
function idx(outline, re) {
    const line = outline.split('\n').find(l => re.test(l))
    return Number(/\[(\d+)\]/.exec(line)[1])
}

const box = (input, button, toggle = null) => ({
    outcome: 'box',
    input,
    button,
    toggle,
    confidence: 90,
    why: 'labelled field',
    cached: false,
})

const run = () => startApplyingCoupons(caramelConfiglessRecord('shop.test'))
const gaveCodesToCopy = () =>
    expect(finalModals.at(-1)[2]).toMatch(/couldn't find the promo box/)

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
})

beforeEach(() => {
    sessionStorage.clear()
    handoffs.reset()
    document.body.innerHTML = ''
    window.history.replaceState({}, '', '/cart')
    finalModals = []
    appliedWith = []
    pickCalls = []
    flagOn = true
    llmOn = true
    answer = { outcome: 'no_box', confidence: 80, why: 'none', cached: false }
    outlineUrl = OUTLINE_FILE
    outlineLoads = 0
    _caramelResetDiscoveryFlag()
})

describe('nothing is asked unless both flags are on', () => {
    it('pick flag off: no request, no outline built, the codes are handed over as before', async () => {
        llmOn = false
        document.body.innerHTML = BARE_BOX + TOTAL

        await run()

        expect(pickCalls).toHaveLength(0)
        expect(outlineLoads).toBe(0)
        expect(appliedWith).toHaveLength(0)
        gaveCodesToCopy()
    })

    it('finder flag off: the pick is never reached either', async () => {
        flagOn = false
        document.body.innerHTML = BARE_BOX + TOTAL

        await run()

        expect(pickCalls).toHaveLength(0)
        expect(outlineLoads).toBe(0)
    })

    it('no readable total: nothing could be measured, so nothing is asked', async () => {
        document.body.innerHTML = BARE_BOX

        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(pickCalls).toHaveLength(0)
    })

    it('the rules found the box: nothing is asked', async () => {
        document.body.innerHTML =
            '<div><label for="dc">Discount code</label><input id="dc" name="discount_code" type="text">' +
            '<button type="button">Apply</button></div>' +
            TOTAL

        await run()

        expect(pickCalls).toHaveLength(0)
        expect(appliedWith.length).toBeGreaterThan(0)
    })
})

describe('a usable pick runs through the normal apply flow', () => {
    it('drives the input and button the server named', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        answer = req =>
            box(idx(req.outline, /textbox/), idx(req.outline, /button "Go"/))

        await run()

        expect(pickCalls).toHaveLength(1)
        expect(pickCalls[0].domain).toBe('shop.test')
        expect(pickCalls[0].outline).toContain('textbox')
        expect(appliedWith.length).toBeGreaterThan(0)
        const { rec } = appliedWith[0]
        // Held to the money rule, against the total the rules read.
        expect(rec.caramelFound).toBe(true)
        expect(document.querySelector(rec.couponInput)?.id).toBe('x')
        expect(document.querySelector(rec.couponSubmit)?.id).toBe('go')
        expect(
            document.querySelector(rec.priceContainer)?.textContent,
        ).toContain('$100.00')
    })

    it('a toggle alone is clicked once, and the rules then find the box it revealed', async () => {
        document.body.innerHTML =
            FOLDED +
            '<button id="po" type="button">Place order</button>' +
            TOTAL
        let toggleClicks = 0
        let orderClicks = 0
        document.getElementById('tg').addEventListener('click', () => {
            toggleClicks++
            document.getElementById('panel').style.display = ''
        })
        document.getElementById('po').addEventListener('click', () => {
            orderClicks++
        })
        answer = req => box(null, null, idx(req.outline, TOGGLE))

        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(toggleClicks).toBe(1)
        expect(orderClicks).toBe(0)
        expect(document.querySelector(rec.couponInput)?.id).toBe('dc')
        expect(document.querySelector(rec.couponSubmit)?.id).toBe('ap')
        expect(document.querySelector(rec.showInput)?.id).toBe('tg')
    })

    it('a toggle that reveals nothing the rules accept gives no record', async () => {
        document.body.innerHTML =
            '<button id="tg" type="button">Extras</button>' + BARE_BOX + TOTAL
        let toggleClicks = 0
        document
            .getElementById('tg')
            .addEventListener('click', () => toggleClicks++)
        answer = req => box(null, null, idx(req.outline, TOGGLE))

        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(toggleClicks).toBe(1)
    })
})

describe('a pick is checked on the page before anything is touched', () => {
    for (const label of ['Place order', 'Sign in', 'Remove', 'Continue'])
        it(`never uses "${label}" as the apply button`, async () => {
            document.body.innerHTML =
                '<div><input id="x" name="field_7" type="text">' +
                `<button id="b" type="button">${label}</button></div>` +
                TOTAL
            let clicks = 0
            document
                .getElementById('b')
                .addEventListener('click', () => clicks++)
            answer = req =>
                box(
                    idx(req.outline, /textbox/),
                    idx(req.outline, new RegExp(`button "${label}"`)),
                )

            await run()

            expect(clicks).toBe(0)
            expect(appliedWith).toHaveLength(0)
            gaveCodesToCopy()
        })

    it('never clicks a toggle that would place the order', async () => {
        document.body.innerHTML =
            '<button id="po" type="button">Place order</button>' + TOTAL
        let clicks = 0
        document.getElementById('po').addEventListener('click', () => clicks++)
        answer = req => box(null, null, idx(req.outline, /Place order/))

        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(clicks).toBe(0)
    })

    it('a field the apply flow cannot type a code into is not the box', async () => {
        document.body.innerHTML =
            '<div><input id="e" type="email" name="field_7">' +
            '<button id="go" type="button">Go</button></div>' +
            TOTAL
        answer = req =>
            box(idx(req.outline, /textbox/), idx(req.outline, /button "Go"/))

        await run()

        expect(appliedWith).toHaveLength(0)
        gaveCodesToCopy()
    })

    it('an element the page removed while the server answered is not used', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        answer = req => {
            const pick = box(
                idx(req.outline, /textbox/),
                idx(req.outline, /button "Go"/),
            )
            document.getElementById('x').remove()
            return pick
        }

        await run()

        expect(appliedWith).toHaveLength(0)
        gaveCodesToCopy()
    })

    it('an index the outline never had is not used', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        answer = box(999, 1000)

        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
    })
})

describe('one ask per store per tab session', () => {
    it('a "no box" answer is remembered, on this page and the next', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL

        await caramelDiscoveredRecord({ domain: 'shop.test' })
        await caramelDiscoveredRecord({ domain: 'shop.test' })
        // A new page in the same tab: only the session remembers.
        _caramelResetDiscoveryFlag()
        await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(pickCalls).toHaveLength(1)
    })

    it('a box answer is not asked for again either: later pages use the kept pick', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        answer = req =>
            box(idx(req.outline, /textbox/), idx(req.outline, /button "Go"/))

        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).not.toBeNull()
        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).not.toBeNull()
        expect(pickCalls).toHaveLength(1)
    })
})

describe('a refusal or a failure ends exactly as a rule miss does', () => {
    const cases = {
        'over budget (429)': { error: 'HTTP 429' },
        'too large (413)': { error: 'HTTP 413' },
        'no answer from the model': {
            outcome: 'no_pick',
            reason: 'model_error',
        },
        'a network failure': { error: 'TypeError: Failed to fetch' },
        'no response at all': undefined,
    }
    for (const [name, value] of Object.entries(cases))
        it(`${name}: no retry, no record, the codes handed over`, async () => {
            document.body.innerHTML = BARE_BOX + TOTAL
            answer = value

            await run()

            expect(pickCalls).toHaveLength(1)
            expect(appliedWith).toHaveLength(0)
            gaveCodesToCopy()
        })
})

describe('the outline builder is loaded only to ask', () => {
    it('loaded once, from the extension, when the pick is asked', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL

        await run()

        expect(outlineLoads).toBe(1)
        expect(pickCalls).toHaveLength(1)
    })

    it('a builder that will not load ends as a miss: nothing asked, codes handed over', async () => {
        outlineUrl = pathToFileURL(
            resolve(import.meta.dirname, 'no-such-outline.js'),
        ).href
        document.body.innerHTML = BARE_BOX + TOTAL

        await run()

        expect(outlineLoads).toBe(1)
        expect(pickCalls).toHaveLength(0)
        expect(appliedWith).toHaveLength(0)
        gaveCodesToCopy()
    })

    it('the page waits longer than the background may spend on the ask', () => {
        expect(PICK_WAIT_MS).toBeGreaterThanOrEqual(
            COUPON_BOX_PICK_DEADLINE_MS + 5000,
        )
    })
})

// The dev browser test on tractive.com (2026-10-14): the server answered
// {"outcome":"box","input":21,"button":null,"toggle":null,"confidence":90,
// "why":"Only discount field present, no apply button"}, the checkout's
// "Discount Code (Optional)" field that applies on Enter. The client threw it
// away (FINDER_PICK_UNUSABLE) and the shopper saw "We couldn't find the promo
// box on this page".
describe('a box the server says has no apply button (it applies on Enter)', () => {
    // No button anywhere near the field, so the rules cannot supply one.
    const INPUT_ONLY =
        '<div class="f"><input id="x" name="field_7" type="text"></div>'

    it('an input with no button is a usable record: the input stands in as its own submit', async () => {
        document.body.innerHTML = INPUT_ONLY + TOTAL
        answer = req => box(idx(req.outline, /textbox/), null)

        await run()

        expect(pickCalls).toHaveLength(1)
        expect(appliedWith.length).toBeGreaterThan(0)
        const { rec } = appliedWith[0]
        // Held to the money rule like any picked box.
        expect(rec.caramelFound).toBe(true)
        const input = document.querySelector(rec.couponInput)
        expect(input?.id).toBe('x')
        // applyCoupon's `applyBtn === input` branch: type the code, press Enter.
        expect(document.querySelector(rec.couponSubmit)).toBe(input)
        // Nothing is marked as a button: there is none to click.
        expect(document.querySelector('[data-caramel-found="submit"]')).toBe(
            null,
        )
        expect(
            document.querySelector(rec.priceContainer)?.textContent,
        ).toContain('$100.00')
    })

    it('the record is built through the same path the rules use, so the box is found again after a re-draw', async () => {
        // The tractive.com shape: a labelled field the rules score as the
        // box, but with no apply button, so they will not settle on it.
        const labelled = id =>
            '<div class="f"><label for="' +
            id +
            '">Discount Code (Optional)</label>' +
            '<input id="' +
            id +
            '" name="discount_code" type="text"></div>'
        document.body.innerHTML = labelled('dc') + TOTAL
        answer = req => box(idx(req.outline, /textbox/), null)
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })
        expect(rec).not.toBeNull()

        // The store replaces the whole section to show its answer.
        document.querySelector('.f').outerHTML = labelled('y')

        expect(caramelRemarkFoundBox(false, rec)).toBe(true)
        expect(document.querySelector(rec.couponInput)?.id).toBe('y')
        expect(document.querySelector(rec.couponSubmit)?.id).toBe('y')
    })

    // After a redraw the box is found again by ONE name only (its name, else
    // its id, else its aria-label, placeholder or label text: inputSig), so the
    // question is what else on the cart can carry that same name.
    describe('after a redraw the box is found again only as itself', () => {
        const promo = id =>
            '<div class="f"><label for="' +
            id +
            '">Discount Code (Optional)</label>' +
            '<input id="' +
            id +
            '" name="discount_code" type="text"></div>'
        const decoys =
            '<form role="search" action="/search"><input id="s" type="search" name="discount_code"></form>' +
            '<input id="m" type="email" name="discount_code">' +
            '<div><label for="g">Gift card</label>' +
            '<input id="g" name="discount_code" type="text"></div>'
        const pickAndRedraw = async html => {
            document.body.innerHTML = promo('dc') + TOTAL
            answer = req => box(idx(req.outline, /textbox/), null)
            const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })
            expect(rec).not.toBeNull()
            document.body.innerHTML = html + TOTAL
            return rec
        }
        const markedId = () =>
            document.querySelector('[data-caramel-found="input"]')?.id ?? null

        it('the promo box and a search box, an email field and a gift-card field: the promo box', async () => {
            const rec = await pickAndRedraw(decoys + promo('y'))

            expect(caramelRemarkFoundBox(false, rec)).toBe(true)
            expect(markedId()).toBe('y')
        })

        it('a decoy that sorts first never beats the promo box', async () => {
            const rec = await pickAndRedraw(promo('y') + decoys)

            expect(caramelRemarkFoundBox(false, rec)).toBe(true)
            expect(markedId()).toBe('y')
        })

        it('the promo box gone and only the others left: none', async () => {
            const rec = await pickAndRedraw(decoys)

            expect(caramelRemarkFoundBox(false, rec)).toBe(false)
            expect(markedId()).toBeNull()
        })

        it('two promo boxes that cannot be told apart: none', async () => {
            const rec = await pickAndRedraw(promo('y') + promo('z'))

            expect(caramelRemarkFoundBox(false, rec)).toBe(false)
            expect(markedId()).toBeNull()
        })
    })

    it('a pick with no input is still rejected, whatever else it names', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        answer = req => box(null, idx(req.outline, /button "Go"/))

        await run()

        expect(pickCalls).toHaveLength(1)
        expect(appliedWith).toHaveLength(0)
        gaveCodesToCopy()
    })

    it('a pick naming nothing at all is rejected too', async () => {
        document.body.innerHTML = INPUT_ONLY + TOTAL
        answer = box(null, null, null)

        await run()

        expect(appliedWith).toHaveLength(0)
        gaveCodesToCopy()
    })

    it('a field the apply flow cannot type into is not an input-only box', async () => {
        document.body.innerHTML =
            '<div class="f"><input id="e" type="email" name="field_7"></div>' +
            TOTAL
        answer = req => box(idx(req.outline, /textbox/), null)

        await run()

        expect(appliedWith).toHaveLength(0)
        gaveCodesToCopy()
    })

    it('a button the server named but the page refuses never becomes an Enter press', async () => {
        document.body.innerHTML =
            '<div class="f"><input id="x" name="field_7" type="text"></div>' +
            '<a id="b" href="/cart/checkout" class="btn">Apply</a>' +
            TOTAL
        answer = req =>
            box(idx(req.outline, /textbox/), idx(req.outline, /link "Apply"/))

        await run()

        expect(appliedWith).toHaveLength(0)
        gaveCodesToCopy()
    })
})

// Through the real apply flow (the file mocks applyCoupon for the others).
describe('an input-only pick, driven by the real apply flow', () => {
    let realApplyCoupon
    beforeAll(async () => {
        ;({ applyCoupon: realApplyCoupon } =
            await vi.importActual('../coupon-apply.js'))
    })

    // Every Enter, submit and click the page sees, in the capture phase.
    const watch = () => {
        const seen = []
        for (const type of ['keydown', 'keypress', 'keyup'])
            document.addEventListener(
                type,
                e => e.key === 'Enter' && seen.push(`${type}:${e.target.id}`),
                true,
            )
        document.addEventListener('submit', () => seen.push('submit'), true)
        document.addEventListener(
            'click',
            e => seen.push(`click:${e.target.id}`),
            true,
        )
        return seen
    }

    it('{outcome:box, input:N, button:null} ends with the code typed and Enter pressed on that input', async () => {
        document.body.innerHTML =
            '<div class="f"><input id="x" name="field_7" type="text"></div>' +
            TOTAL
        answer = req => box(idx(req.outline, /textbox/), null)
        const seen = watch()
        let typed = null
        document.getElementById('x').addEventListener('keydown', e => {
            if (e.key !== 'Enter') return
            typed = e.target.value
            document.querySelector('.row').lastChild.textContent = '$90.00'
        })

        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })
        expect(rec).not.toBeNull()
        const res = await realApplyCoupon('SAVE20', rec)

        expect(pickCalls).toHaveLength(1)
        expect(seen).toEqual(['keydown:x'])
        expect(typed).toBe('SAVE20')
        expect(res.success).toBe(true)
        expect(res.newTotal).toBe(90)
    })

    // The pick is not what keeps an order safe: the apply flow refuses to
    // press Enter in a field whose form could place one (the same guard a
    // config row gets), before the code is even typed.
    const unsafeForms = {
        'a form with a card number field':
            '<form><input id="x" name="field_7" type="text">' +
            '<input name="cardnumber" type="text"></form>',
        'a form with a place-order control':
            '<form><input id="x" name="field_7" type="text">' +
            '<button id="po" type="submit">Place order</button></form>',
    }
    for (const [name, html] of Object.entries(unsafeForms))
        it(`never presses Enter in ${name}`, async () => {
            document.body.innerHTML = html + TOTAL
            answer = req => box(idx(req.outline, /textbox/), null)
            const seen = watch()

            const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })
            // The pick itself is accepted: it is the apply that refuses.
            expect(rec).not.toBeNull()
            const res = await realApplyCoupon('SAVE20', rec)

            expect(seen).toEqual([])
            expect(res.success).toBe(false)
            expect(document.getElementById('x').value).toBe('')
        })
})

describe('an apply button never leaves the page', () => {
    it('a link to another page, named as the button, is never clicked', async () => {
        document.body.innerHTML =
            '<div><input id="x" name="field_7" type="text">' +
            '<a id="b" href="/cart/checkout" class="btn">Apply</a></div>' +
            TOTAL
        let clicks = 0
        document.getElementById('b').addEventListener('click', e => {
            e.preventDefault()
            clicks++
        })
        answer = req =>
            box(idx(req.outline, /textbox/), idx(req.outline, /link "Apply"/))

        await run()

        expect(pickCalls).toHaveLength(1)
        expect(clicks).toBe(0)
        expect(appliedWith).toHaveLength(0)
        gaveCodesToCopy()
    })

    it('a box a server toggle revealed never takes a link to another page as its button', async () => {
        document.body.innerHTML =
            '<button id="tg" type="button">Extras</button>' +
            '<div id="panel" style="display:none"><label for="dc">Discount code</label>' +
            '<input id="dc" name="discount_code" type="text">' +
            '<a id="ap" href="/cart/checkout" class="btn">Apply</a></div>' +
            TOTAL
        let linkClicks = 0
        document.getElementById('tg').addEventListener('click', () => {
            document.getElementById('panel').style.display = ''
        })
        document.getElementById('ap').addEventListener('click', e => {
            e.preventDefault()
            linkClicks++
        })
        answer = req => box(null, null, idx(req.outline, TOGGLE))

        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(linkClicks).toBe(0)
        expect(rec?.couponSubmit ?? null).toBeNull()
    })
})

describe('the total is read again once the server has answered', () => {
    it('a cart re-drawn during the ask: the record holds the new total', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        answer = req => {
            const pick = box(
                idx(req.outline, /textbox/),
                idx(req.outline, /button "Go"/),
            )
            document.querySelector('.row').outerHTML =
                '<div class="row"><span>Total</span><span>$90.00</span></div>'
            return pick
        }

        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        const total = document.querySelector(rec.priceContainer)
        expect(total?.isConnected).toBe(true)
        expect(total.textContent).toContain('$90.00')
    })

    it('a total gone by the time the answer came: nothing can be measured, a miss', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        answer = req => {
            const pick = box(
                idx(req.outline, /textbox/),
                idx(req.outline, /button "Go"/),
            )
            document.querySelector('.row').remove()
            return pick
        }

        await run()

        expect(pickCalls).toHaveLength(1)
        expect(appliedWith).toHaveLength(0)
        gaveCodesToCopy()
    })
})

// A cart that reloads to show the store's answer to each code: the page after
// the reload is a new page in the same tab. The server is not asked again;
// the box it named is found again by its tag and name, and only when exactly
// one element on the new page carries that name.
describe('a pick is kept, by name, for the next page in the tab', () => {
    // A new page: the page's own memory is gone, the session's is not.
    const reload = html => {
        _caramelResetDiscoveryFlag()
        document.body.innerHTML = html
    }
    const pickBareBox = () => {
        answer = req =>
            box(idx(req.outline, /textbox/), idx(req.outline, /button "Go"/))
    }

    it('the reloaded cart gets the same box and button, with no second ask', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        pickBareBox()
        await caramelDiscoveredRecord({ domain: 'shop.test' })

        reload(BARE_BOX + TOTAL)
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(pickCalls).toHaveLength(1)
        expect(document.querySelector(rec.couponInput)?.id).toBe('x')
        expect(document.querySelector(rec.couponSubmit)?.id).toBe('go')
        expect(rec.caramelFound).toBe(true)
    })

    it('a box the reload folded again is opened by the same toggle, once', async () => {
        const wire = () => {
            let clicks = 0
            document.getElementById('tg').addEventListener('click', () => {
                clicks++
                document.getElementById('panel').style.display = ''
            })
            return () => clicks
        }
        document.body.innerHTML = FOLDED + TOTAL
        wire()
        answer = req => box(null, null, idx(req.outline, TOGGLE))
        await caramelDiscoveredRecord({ domain: 'shop.test' })

        reload(FOLDED + TOTAL)
        const clicks = wire()
        const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(pickCalls).toHaveLength(1)
        expect(clicks()).toBe(1)
        expect(document.querySelector(rec.couponInput)?.id).toBe('dc')
        expect(document.querySelector(rec.showInput)?.id).toBe('tg')
    })

    it('a name two elements now carry is no answer: nothing is used and nothing asked', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        pickBareBox()
        await caramelDiscoveredRecord({ domain: 'shop.test' })

        // The same field name twice (a gift-card box built from the same
        // template): either could be the one, so neither is.
        reload(BARE_BOX + BARE_BOX.replace('id="x"', 'id="y"') + TOTAL)

        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(pickCalls).toHaveLength(1)
    })

    it('a page without the box: no record, and the server is still not asked again', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        pickBareBox()
        await caramelDiscoveredRecord({ domain: 'shop.test' })

        reload('<input name="search" type="text">' + TOTAL)

        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(pickCalls).toHaveLength(1)
    })

    it('a box with no name is used once and not kept: a wordless field cannot be told from another', async () => {
        const WORDLESS =
            '<div><input type="text"><button type="button">Go</button></div>'
        document.body.innerHTML = WORDLESS + TOTAL
        pickBareBox()
        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).not.toBeNull()

        reload(WORDLESS + TOTAL)

        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(pickCalls).toHaveLength(1)
    })

    it('an answer that gave no usable box keeps nothing', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        // Only a button: no input, no toggle.
        answer = req => box(null, idx(req.outline, /button "Go"/))
        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )

        reload(BARE_BOX + TOTAL)
        pickBareBox()

        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(pickCalls).toHaveLength(1)
    })

    it('a kept button that is now a link to another page is never used', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        pickBareBox()
        await caramelDiscoveredRecord({ domain: 'shop.test' })

        // After the reload "Go" is a link to another page.
        reload(
            '<div class="f"><input id="x" name="field_7" type="text">' +
                '<a id="go" href="/elsewhere">Go</a></div>' +
                TOTAL,
        )

        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(await caramelFinderSeesKeptPick('shop.test')).toBe(false)
    })

    it("a kept button outside the box's own form is not its button", async () => {
        document.body.innerHTML =
            '<form id="promo"><input id="x" name="field_7" type="text"></form>' +
            '<button id="go" type="button" form="promo">Go</button>' +
            TOTAL
        answer = req =>
            box(idx(req.outline, /textbox/), idx(req.outline, /button "Go"/))
        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).not.toBeNull()

        // The same button now belongs to the gift-card form.
        reload(
            '<form id="promo"><input id="x" name="field_7" type="text"></form>' +
                '<form id="gift"><input name="gift_card" type="text"></form>' +
                '<button id="go" type="button" form="gift">Go</button>' +
                TOTAL,
        )

        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(pickCalls).toHaveLength(1)
    })

    it('a field named only by its placeholder is not kept: a gift-card field says "Enter code" too', async () => {
        const BOX =
            '<div><input type="text" placeholder="Enter code">' +
            '<button id="go" type="button">Go</button></div>'
        document.body.innerHTML = BOX + TOTAL
        pickBareBox()
        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).not.toBeNull()

        // After the reload only the gift-card field wears those words.
        reload(
            '<div>Gift card <input type="text" placeholder="Enter code">' +
                '<button id="go" type="button">Go</button></div>' +
                TOTAL,
        )

        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(await caramelFinderSeesKeptPick('shop.test')).toBe(false)
        expect(pickCalls).toHaveLength(1)
    })

    it('a name this page already shares with another field is not kept', async () => {
        document.body.innerHTML =
            BARE_BOX + '<input name="field_7" type="hidden">' + TOTAL
        // Two inputs named field_7: one hidden, so the box is still usable here.
        answer = req =>
            box(idx(req.outline, /textbox/), idx(req.outline, /button "Go"/))
        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).not.toBeNull()

        reload(BARE_BOX + TOTAL)

        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
    })

    it('another page of the store does not use it: the pick belongs to the cart it was made on', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        pickBareBox()
        await caramelDiscoveredRecord({ domain: 'shop.test' })

        window.history.replaceState({}, '', '/checkout')
        reload(BARE_BOX + TOTAL)

        expect(await caramelFinderSeesKeptPick('shop.test')).toBe(false)
        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(pickCalls).toHaveLength(1)
    })

    it('a kept toggle the shopper cannot see is neither offered nor clicked', async () => {
        document.body.innerHTML = FOLDED + TOTAL
        document.getElementById('tg').addEventListener('click', () => {
            document.getElementById('panel').style.display = ''
        })
        answer = req => box(null, null, idx(req.outline, TOGGLE))
        await caramelDiscoveredRecord({ domain: 'shop.test' })

        // The same toggle, inside a closed drawer.
        reload('<div style="display:none">' + FOLDED + '</div>' + TOTAL)
        let clicks = 0
        document.getElementById('tg').addEventListener('click', () => {
            clicks++
        })

        expect(await caramelFinderSeesKeptPick('shop.test')).toBe(false)
        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(clicks).toBe(0)
    })

    it('a kept toggle that now sits inside a submit button is never clicked', async () => {
        const PANEL =
            '<div id="panel" style="display:none"><label for="dc">Discount code</label>' +
            '<input id="dc" name="discount_code" type="text">' +
            '<button id="ap" type="button">Apply</button></div>'
        document.body.innerHTML =
            '<span id="tg" role="button">Extras</span>' + PANEL + TOTAL
        document.getElementById('tg').addEventListener('click', () => {
            document.getElementById('panel').style.display = ''
        })
        answer = req => box(null, null, idx(req.outline, TOGGLE))
        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).not.toBeNull()

        // After the reload the same words sit inside the form's submit button.
        reload(
            '<form><button type="submit"><span id="tg" role="button">Extras</span></button></form>' +
                PANEL +
                TOTAL,
        )
        let submits = 0
        document.querySelector('form').addEventListener('submit', e => {
            e.preventDefault()
            submits++
        })

        expect(await caramelFinderSeesKeptPick('shop.test')).toBe(false)
        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(submits).toBe(0)
    })

    it('the reload chain is not told "yes" for a box it could not use: the box is there, its button is not', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        pickBareBox()
        await caramelDiscoveredRecord({ domain: 'shop.test' })

        reload(
            '<div class="f"><input id="x" name="field_7" type="text"></div>' +
                TOTAL,
        )

        expect(await caramelFinderSeesKeptPick('shop.test')).toBe(false)
        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
    })

    it('a store asked in this tab with nothing usable is not asked again and has nothing kept', async () => {
        await handoffs.put('box_pick', { 'shop.test': 1 })
        document.body.innerHTML = BARE_BOX + TOTAL
        pickBareBox()

        expect(await caramelFinderSeesKeptPick('shop.test')).toBe(false)
        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(pickCalls).toHaveLength(0)
    })

    it('the pick is not used once the flag is off', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        pickBareBox()
        await caramelDiscoveredRecord({ domain: 'shop.test' })

        reload(BARE_BOX + TOTAL)
        llmOn = false

        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
        expect(await caramelFinderSeesKeptPick('shop.test')).toBe(false)
    })

    // A box the server said applies on Enter has no button to find again: it
    // is kept as Enter-only, and only a pick made that way is used without one.
    describe('a kept box that applies on Enter', () => {
        const INPUT_ONLY =
            '<div class="f"><input id="x" name="field_7" type="text"></div>'
        const pickInputOnly = () => {
            answer = req => box(idx(req.outline, /textbox/), null)
        }

        it('the reloaded cart gets the same box, its own submit, with no second ask', async () => {
            document.body.innerHTML = INPUT_ONLY + TOTAL
            pickInputOnly()
            expect(
                await caramelDiscoveredRecord({ domain: 'shop.test' }),
            ).not.toBeNull()

            reload(INPUT_ONLY + TOTAL)
            const rec = await caramelDiscoveredRecord({ domain: 'shop.test' })

            expect(pickCalls).toHaveLength(1)
            expect(document.querySelector(rec.couponInput)?.id).toBe('x')
            expect(document.querySelector(rec.couponSubmit)?.id).toBe('x')
            expect(rec.caramelFound).toBe(true)
        })

        it('the reload chain sees it, and clicks nothing', async () => {
            document.body.innerHTML = INPUT_ONLY + TOTAL
            pickInputOnly()
            await caramelDiscoveredRecord({ domain: 'shop.test' })

            reload(INPUT_ONLY + TOTAL)

            expect(await caramelFinderSeesKeptPick('shop.test')).toBe(true)
        })

        it('a box kept WITH a button is never used as Enter-only once the button is gone', async () => {
            document.body.innerHTML = BARE_BOX + TOTAL
            pickBareBox()
            await caramelDiscoveredRecord({ domain: 'shop.test' })

            reload(INPUT_ONLY + TOTAL)

            expect(await caramelFinderSeesKeptPick('shop.test')).toBe(false)
            expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
                null,
            )
            expect(pickCalls).toHaveLength(1)
        })
    })

    describe('the reload chain sees the kept box without touching it', () => {
        it('sees the box on the reloaded cart', async () => {
            document.body.innerHTML = BARE_BOX + TOTAL
            pickBareBox()
            await caramelDiscoveredRecord({ domain: 'shop.test' })
            reload(BARE_BOX + TOTAL)

            expect(await caramelFinderSeesKeptPick('shop.test')).toBe(true)
        })

        it('sees a folded box by its toggle, and clicks nothing', async () => {
            document.body.innerHTML = FOLDED + TOTAL
            document.getElementById('tg').addEventListener('click', () => {
                document.getElementById('panel').style.display = ''
            })
            answer = req => box(null, null, idx(req.outline, TOGGLE))
            await caramelDiscoveredRecord({ domain: 'shop.test' })

            reload(FOLDED + TOTAL)
            let clicks = 0
            document.getElementById('tg').addEventListener('click', () => {
                clicks++
            })

            expect(await caramelFinderSeesKeptPick('shop.test')).toBe(true)
            expect(clicks).toBe(0)
        })

        it('nothing kept, another store, or no total: does not see it', async () => {
            document.body.innerHTML = BARE_BOX + TOTAL
            expect(await caramelFinderSeesKeptPick('shop.test')).toBe(false)

            pickBareBox()
            await caramelDiscoveredRecord({ domain: 'shop.test' })
            expect(await caramelFinderSeesKeptPick('other.test')).toBe(false)

            reload(BARE_BOX)
            expect(await caramelFinderSeesKeptPick('shop.test')).toBe(false)
        })
    })
})

describe('the pick memory is the extension’s, never the page’s', () => {
    // The store's page can write its own sessionStorage. Writing a pick there
    // must not choose the field the codes go into, and, while the background
    // answers, clearing it must not buy a second ask. (A background that
    // cannot answer leaves only the page's own memory: a new page may then ask
    // again.)
    const GIFT =
        '<div class="g"><input id="gc" name="gift_card" type="text">' +
        '<button id="gb" type="button">Redeem</button></div>'

    it('a pick the page wrote is not used', async () => {
        sessionStorage.setItem(
            'caramel_box_pick:shop.test',
            JSON.stringify({
                p: '/cart',
                i: 'INPUT n:gift_card',
                b: 'BUTTON i:gb',
            }),
        )
        document.body.innerHTML = GIFT + TOTAL

        expect(await caramelFinderSeesKeptPick('shop.test')).toBe(false)
        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
    })

    it('a page that clears its storage does not buy a second ask', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        await caramelDiscoveredRecord({ domain: 'shop.test' })

        sessionStorage.clear()
        _caramelResetDiscoveryFlag()
        await caramelDiscoveredRecord({ domain: 'shop.test' })

        expect(pickCalls).toHaveLength(1)
    })
})
