import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { COUPON_BOX_PICK_DEADLINE_MS } from '../background.js'
import { initCaramelBase } from '../caramel-base.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoveredRecord,
    PICK_WAIT_MS,
} from '../coupon-box-discovery.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import { caramelConfiglessRecord } from '../store-detect.js'

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
    stub.runtime.getURL = path => {
        if (path !== 'assets/coupon-box-outline.js')
            return 'chrome-extension://caramel/' + path
        outlineLoads++
        return outlineUrl
    }
    stub.runtime.sendMessage = (message, cb) => {
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

    it('a box answer is not asked for again either', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        answer = req =>
            box(idx(req.outline, /textbox/), idx(req.outline, /button "Go"/))

        expect(
            await caramelDiscoveredRecord({ domain: 'shop.test' }),
        ).not.toBeNull()
        expect(await caramelDiscoveredRecord({ domain: 'shop.test' })).toBe(
            null,
        )
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
