import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { _caramelResetDiscoveryFlag } from '../coupon-box-discovery.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import {
    _caramelResetCachedCodes,
    caramelConfiglessRecord,
    caramelStoreListKnown,
    getDomainRecord,
    startCheckoutDetection,
    tryInitialize,
} from '../store-detect.js'

// A store with NO config row, driven through the real detection, the real
// runner and the real apply flow (store-detect.js, coupon-runner.js,
// coupon-apply.js, coupon-box-discovery.js). Only the UI layer and the
// background are stubbed, to record what the shopper sees and what leaves the
// page.
//
//   1. Flags off (production today): nothing of the finder runs beyond the
//      one question "is it on?". No prompt where there was none before, no
//      outline built, no pick asked, nothing marked on the page.
//   2. Flags on: the money rule. Whatever box was used (one the rules found,
//      one the server named, or a wrong one) a saving is reported and banked
//      only when the order total really went down. A wrong pick ends in the
//      codes handed over to copy: never a saving, never a click on a control
//      that leaves the page, never an overlay left up.
//   3. The features around it that are scoped to configured stores by design
//      stay that way on a finder store.

const OUTLINE_FILE = pathToFileURL(
    resolve(import.meta.dirname, '../coupon-box-outline.js'),
).href

const COUPONS = [
    {
        code: 'SAVE20',
        id: 'c1',
        discount_type: 'PERCENTAGE',
        discount_amount: 20,
    },
    { code: 'TENOFF', id: 'c2', discount_type: 'CASH', discount_amount: 10 },
]

let flags
let answer // the server's pick: an object, or a function of the request
let platformCart // what /cart.js answers (null: not a platform cart)
let storeList // what the supported-stores request answers
// A row for some other store: the list was read and this host is not on it.
const OTHER_STORE = { domain: 'some-other-store.example', couponInput: '#c' }
let t // the recording

// Every finder entry point another module calls, counted. The real
// implementation still runs underneath.
const finderCalls = {}
vi.mock('../coupon-box-discovery.js', async importOriginal => {
    const actual = await importOriginal()
    const out = {}
    for (const [name, value] of Object.entries(actual)) {
        if (typeof value !== 'function' || name.startsWith('_')) {
            out[name] = value
            continue
        }
        out[name] = (...args) => {
            finderCalls[name] = (finderCalls[name] || 0) + 1
            return value(...args)
        }
    }
    return out
})
vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    probeCartJson: async () => platformCart,
}))
vi.mock('../code-capture.js', async importOriginal => ({
    ...(await importOriginal()),
    armCodeCapture: rec => t.captureArmed.push(rec?.domain ?? null),
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    insertCaramelPrompt: r => {
        t.prompts.push(r.domain)
    },
    showFinalModal: (amount, code, message, _x, list) => {
        t.overlay = false
        t.modals.push({
            amount,
            code,
            message,
            list: (list || []).map(c => c.code),
        })
    },
    showTestingModal: async () => {
        t.overlay = true
    },
    updateTestingModal: async () => {},
    hideTestingModal: () => {
        t.overlay = false
    },
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: entry => {
            t.savings.push({ code: entry.code, amount: entry.amount })
        },
        sleep: () => new Promise(r => setTimeout(r, 0)),
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
        stub.storage[area].remove = (_keys, cb) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    stub.runtime.getURL = path => {
        t.urls.push(path)
        return path === 'assets/coupon-box-outline.js'
            ? OUTLINE_FILE
            : 'chrome-extension://caramel/' + path
    }
    stub.runtime.sendMessage = (message, cb) => {
        const { action } = message || {}
        t.messages.push(message)
        let reply = {}
        if (action === 'fetchSupportedStores') reply = storeList
        else if (action === 'fetchCoupons') reply = { coupons: COUPONS }
        else if (action === 'couponBoxDiscoveryEnabled')
            reply = { enabled: flags.discovery }
        else if (action === 'couponBoxLlmEnabled')
            reply = { enabled: flags.llm }
        else if (action === 'couponBoxPick')
            reply = typeof answer === 'function' ? answer(message) : answer
        if (typeof cb === 'function') cb(reply)
        return undefined
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

const TOTAL =
    '<div class="row"><span>Total</span><span id="tot">$100.00</span></div>'
// A box the rules recognise on their own.
const RULES_BOX =
    '<div class="promo"><label for="dc">Discount code</label>' +
    '<input id="dc" name="discount_code" type="text">' +
    '<button id="ap" type="button">Apply</button></div>'
// A box no rule recognises: only the server could name it.
const BARE_BOX =
    '<div class="f"><input id="x" name="field_7" type="text">' +
    '<button id="go" type="button">Go</button></div>'

const pick = (input, button, toggle = null) => ({
    outcome: 'box',
    input,
    button,
    toggle,
    confidence: 90,
    why: 'test',
    cached: false,
})
// The index the outline gave the element on the line matching `re`.
const idx = (outline, re) => {
    const line = outline.split('\n').find(l => re.test(l))
    return line ? Number(/\[(\d+)\]/.exec(line)[1]) : null
}

// The store's answer to a code typed into `inputId` and submitted with
// `buttonId`: 'drop' takes $20 off for SAVE20, 'says-yes' prints an accepted
// message but the total never moves, 'refuse' prints a rejection.
function wireStore(inputId, buttonId, behaviour) {
    const btn = document.getElementById(buttonId)
    btn?.addEventListener('click', () => {
        const code = document.getElementById(inputId).value
        t.page.push(`submit:${buttonId}:${code}`)
        setTimeout(() => {
            const msg = document.createElement('div')
            msg.className = 'note'
            if (behaviour === 'drop' && code === 'SAVE20') {
                document.getElementById('tot').textContent = '$80.00'
                msg.textContent = 'Discount applied'
            } else if (behaviour === 'says-yes') {
                msg.textContent = `Coupon ${code} applied!`
            } else {
                msg.textContent = `Sorry, ${code} is not a valid code.`
            }
            btn.parentElement.appendChild(msg)
        }, 5)
    })
}

function freshPage(html, path = '/cart') {
    t = {
        messages: [],
        prompts: [],
        modals: [],
        savings: [],
        page: [],
        urls: [],
        captureArmed: [],
        overlay: false,
    }
    for (const k of Object.keys(finderCalls)) delete finderCalls[k]
    getDomainRecord.cache = null
    getDomainRecord.answered = false
    _caramelResetCachedCodes()
    _caramelResetDiscoveryFlag()
    sessionStorage.clear()
    window.__caramel_checkout_observer?.disconnect?.()
    window.__caramel_checkout_observer = null
    window.history.replaceState({}, '', path)
    document.body.innerHTML = html
    document.addEventListener('click', e => {
        if (e.target.closest?.('a[href]')) t.page.push('LEFT-THE-PAGE')
    })
}

const asked = action => t.messages.filter(m => m?.action === action)
const reported = outcome =>
    asked('reportOutcome').filter(m => m.outcome === outcome)
// The runner is reached from the prompt, so the store list has been read by
// then (or failed to be).
const run = async () => {
    await getDomainRecord(location.hostname)
    return startApplyingCoupons(caramelConfiglessRecord(location.hostname))
}
const lastModal = () => t.modals.at(-1)
const handedOver = () => {
    expect(lastModal().amount).toBe(0)
    expect(lastModal().list).toEqual(['SAVE20', 'TENOFF'])
}

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
})

beforeEach(() => {
    flags = { discovery: false, llm: false }
    answer = { outcome: 'no_box', confidence: 80, why: 'none', cached: false }
    platformCart = null
    storeList = { supported: [OTHER_STORE] }
})

describe('flags off (production today): a store with no config is exactly as before the finder', () => {
    for (const [name, html] of Object.entries({
        'a box the rules would recognise': RULES_BOX + TOTAL,
        'a box only the server could name': BARE_BOX + TOTAL,
        'no box at all': TOTAL,
    }))
        it(`${name}: no prompt, no outline, no pick, nothing marked`, async () => {
            freshPage(html)
            await tryInitialize()

            expect(t.prompts).toEqual([])
            expect(asked('couponBoxPick')).toEqual([])
            expect(asked('couponBoxLlmEnabled')).toEqual([])
            expect(t.urls).not.toContain('assets/coupon-box-outline.js')
            expect(document.querySelector('[data-caramel-found]')).toBeNull()
            // The only finder code that ran is the question "is it on?".
            expect(Object.keys(finderCalls)).toEqual([
                'caramelCouponBoxDiscoveryOn',
            ])
        })

    it('a readable platform cart still gets its prompt and the discount-link path, finder untouched', async () => {
        freshPage(RULES_BOX + TOTAL)
        platformCart = {
            token: 't',
            item_count: 1,
            total_price: 10000,
            items: [],
        }
        await tryInitialize()
        expect(t.prompts).toEqual([location.hostname])
        expect(Object.keys(finderCalls)).toEqual([])
    })

    it('the apply flow on a config-less record ends with the codes to copy, as before', async () => {
        freshPage(RULES_BOX + TOTAL)
        await run()
        expect(Object.keys(finderCalls)).toEqual([
            'caramelCouponBoxDiscoveryOn',
        ])
        expect(t.page).toEqual([])
        expect(t.savings).toEqual([])
        expect(lastModal().message).toMatch(/couldn't find the promo box/)
        handedOver()
    })

    it('on a page that is not a cart the finder is not even asked whether it is on', async () => {
        freshPage(RULES_BOX + TOTAL, '/products/shoe')
        await tryInitialize()
        expect(t.prompts).toEqual([])
        expect(Object.keys(finderCalls)).toEqual([])
    })
})

describe('flags on, no config: the money rule holds whatever box was used', () => {
    beforeEach(() => {
        flags = { discovery: true, llm: true }
    })

    it('a box the rules found, the total really drops: one $20 saving, reported once', async () => {
        freshPage(RULES_BOX + TOTAL)
        wireStore('dc', 'ap', 'drop')
        await run()
        expect(t.page[0]).toBe('submit:ap:SAVE20')
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
        expect(lastModal()).toMatchObject({ amount: 20, code: 'SAVE20' })
        expect(reported('worked')).toHaveLength(1)
        expect(asked('couponBoxPick')).toEqual([])
        expect(t.overlay).toBe(false)
    })

    it('a box the server named, the total really drops: the same $20 saving', async () => {
        freshPage(BARE_BOX + TOTAL)
        wireStore('x', 'go', 'drop')
        answer = req =>
            pick(idx(req.outline, /textbox/), idx(req.outline, /button "Go"/))
        await run()
        expect(asked('couponBoxPick')).toHaveLength(1)
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
        expect(lastModal()).toMatchObject({ amount: 20, code: 'SAVE20' })
        expect(reported('worked')).toHaveLength(1)
    })

    for (const [via, html, box, button, setAnswer] of [
        ['the rules found', RULES_BOX + TOTAL, 'dc', 'ap', () => {}],
        [
            'the server named',
            BARE_BOX + TOTAL,
            'x',
            'go',
            () => {
                answer = req =>
                    pick(
                        idx(req.outline, /textbox/),
                        idx(req.outline, /button "Go"/),
                    )
            },
        ],
    ]) {
        it(
            `a box ${via}: the store SAYS "applied" but the total does not move, so no saving`,
            { timeout: 45_000 },
            async () => {
                freshPage(html)
                wireStore(box, button, 'says-yes')
                setAnswer()
                await run()
                expect(t.page.length).toBeGreaterThan(0)
                expect(t.savings).toEqual([])
                expect(reported('worked')).toEqual([])
                expect(lastModal().amount).toBe(0)
                expect(lastModal().code).toBe(null)
                expect(t.overlay).toBe(false)
            },
        )

        it(`a box ${via}: every code refused, so no saving and the codes to copy`, async () => {
            freshPage(html)
            wireStore(box, button, 'refuse')
            setAnswer()
            await run()
            expect(t.savings).toEqual([])
            expect(reported('worked')).toEqual([])
            expect(lastModal().amount).toBe(0)
            expect(lastModal().list).toEqual(['SAVE20', 'TENOFF'])
            expect(t.overlay).toBe(false)
        })
    }

    // Wrong picks: each ends in the codes to copy, with nothing clicked that
    // could leave the cart and nothing typed where it should not be.
    const WRONG = {
        'the wrong field (a newsletter email box)': {
            html:
                '<div><input id="em" type="email" name="newsletter"><button id="sub" type="button">Go</button></div>' +
                TOTAL,
            answer: req =>
                pick(
                    idx(req.outline, /email|textbox/),
                    idx(req.outline, /button "Go"/),
                ),
            untouched: 'em',
        },
        'a disabled field': {
            html:
                '<div><input id="x" name="field_7" type="text" disabled><button id="go" type="button">Go</button></div>' +
                TOTAL,
            answer: req =>
                pick(
                    idx(req.outline, /textbox/),
                    idx(req.outline, /button "Go"/),
                ),
            untouched: 'x',
        },
        'a button that leaves the page': {
            html:
                '<div><input id="x" name="field_7" type="text"><a id="go" href="/checkout/next">Apply</a></div>' +
                TOTAL,
            answer: req =>
                pick(
                    idx(req.outline, /textbox/),
                    idx(req.outline, /link "Apply"/),
                ),
            untouched: 'x',
        },
        'a page with no box (the server says no_box)': {
            html: TOTAL,
            answer: {
                outcome: 'no_box',
                confidence: 90,
                why: 'none',
                cached: false,
            },
        },
        'a pick the server could not make (error)': {
            html: BARE_BOX + TOTAL,
            answer: { error: 'HTTP 503' },
            untouched: 'x',
        },
        'an answer naming elements that do not exist': {
            html: BARE_BOX + TOTAL,
            answer: pick(9999, 9998, 9997),
            untouched: 'x',
        },
    }
    for (const [name, c] of Object.entries(WRONG))
        it(`${name}: the codes to copy, no saving, nothing left up, never left the page`, async () => {
            freshPage(c.html)
            answer = c.answer
            await run()
            expect(t.savings).toEqual([])
            expect(reported('worked')).toEqual([])
            expect(t.page).not.toContain('LEFT-THE-PAGE')
            expect(t.page.filter(e => e.startsWith('submit:'))).toEqual([])
            if (c.untouched)
                expect(document.getElementById(c.untouched).value).toBe('')
            expect(lastModal().message).toMatch(/couldn't find the promo box/)
            handedOver()
            expect(t.overlay).toBe(false)
            expect(location.pathname).toBe('/cart')
        })
})

describe('features scoped to configured stores stay scoped on a finder store', () => {
    it('shopper code capture is not armed on a store with no config (it needs the config selectors)', async () => {
        flags = { discovery: true, llm: true }
        freshPage(RULES_BOX + TOTAL)
        await startCheckoutDetection()
        // The finder saw the box and the prompt appeared...
        expect(t.prompts).toEqual([location.hostname])
        // ...and capture, the only feeder of the code-sharing funnel, stayed
        // off: nothing is offered for sharing and no funnel step is sent.
        expect(t.captureArmed).toEqual([])
        expect(asked('codeShareFunnel')).toEqual([])
        expect(asked('submitShopperCode')).toEqual([])
    })

    it('the popup page never runs the finder, even with both flags on', async () => {
        // The popup bundles coupon-runner for its listeners, so the finder
        // module ships in it; the "Did it work?" vote and the coupon list
        // (couponVote.ts, CouponsView.tsx) call none of it. What keeps the
        // runner's re-detection from reaching the finder there is that the
        // popup's own page is not a cart and has no config.
        flags = { discovery: true, llm: true }
        freshPage(RULES_BOX + TOTAL, '/popup.html')
        await startCheckoutDetection()
        expect(t.prompts).toEqual([])
        expect(Object.keys(finderCalls)).toEqual([])
        expect(asked('couponBoxPick')).toEqual([])
    })

    it('the porkbun alert shim is injected on porkbun.com checkout pages only', () => {
        const src = readFileSync(
            resolve(
                import.meta.dirname,
                '../entrypoints/porkbun-alert.content.ts',
            ),
            'utf8',
        )
        const matches = /matches:\s*(\[[^\]]*\])/.exec(src)[1]
        expect(JSON.parse(matches.replaceAll("'", '"'))).toEqual([
            'https://porkbun.com/checkout/*',
        ])
    })
})

describe('the store list could not be read: nothing is auto-detected, because this may be a configured store', () => {
    beforeEach(() => {
        flags = { discovery: true, llm: true }
        storeList = { error: 'HTTP 503' }
    })

    it('a cart with a box the rules would recognise: no prompt, the finder is not even asked', async () => {
        freshPage(RULES_BOX + TOTAL)
        await tryInitialize()
        expect(asked('fetchSupportedStores').length).toBeGreaterThan(0)
        expect(t.prompts).toEqual([])
        expect(asked('couponBoxPick')).toEqual([])
        // Not even asked whether it is on. (Only detection's entry points
        // are counted: an earlier test's apply loop may still be winding
        // down in the background.)
        for (const entry of [
            'caramelCouponBoxDiscoveryOn',
            'caramelFinderSeesBox',
            'caramelFinderMayAsk',
            'caramelDiscoveredRecord',
        ])
            expect(finderCalls[entry]).toBeUndefined()
    })

    it('a cart only the server could read: no prompt, no pick', async () => {
        freshPage(BARE_BOX + TOTAL)
        answer = req =>
            pick(idx(req.outline, /textbox/), idx(req.outline, /button "Go"/))
        await tryInitialize()
        expect(t.prompts).toEqual([])
        expect(asked('couponBoxPick')).toEqual([])
        expect(t.urls).not.toContain('assets/coupon-box-outline.js')
    })

    it('the apply flow reached anyway: no finder, no pick, the codes to copy', async () => {
        freshPage(RULES_BOX + TOTAL)
        wireStore('dc', 'ap', 'drop')
        expect(await getDomainRecord(location.hostname)).toBeUndefined()
        await run()
        expect(finderCalls.caramelDiscoveredRecord).toBeUndefined()
        expect(asked('couponBoxPick')).toEqual([])
        expect(t.page).toEqual([])
        expect(t.savings).toEqual([])
        handedOver()
    })

    it('the same cart once the list is read: the prompt is back (the list is the only difference)', async () => {
        storeList = { supported: [OTHER_STORE] }
        freshPage(RULES_BOX + TOTAL)
        await tryInitialize()
        expect(t.prompts).toEqual([location.hostname])
    })

    // A 200 that carries no list says nothing about which stores have a
    // config, so it counts as a list that could not be read.
    for (const [label, answer] of [
        ['an empty list', { supported: [] }],
        ['a list that is not an array', { supported: 'garbage' }],
        ['an object instead of a list', { supported: { domain: 'x.com' } }],
        ['no list at all', {}],
    ])
        it(`${label}: no prompt, the finder is not asked`, async () => {
            storeList = answer
            freshPage(RULES_BOX + TOTAL)
            await tryInitialize()
            expect(asked('fetchSupportedStores').length).toBeGreaterThan(0)
            expect(caramelStoreListKnown()).toBe(false)
            expect(t.prompts).toEqual([])
            expect(asked('couponBoxPick')).toEqual([])
            expect(finderCalls.caramelFinderSeesBox).toBeUndefined()
            expect(finderCalls.caramelFinderMayAsk).toBeUndefined()
        })
})

describe('a loyalty or offers control is never clicked by the finder or the pick', () => {
    // "Apply discount" under "You have 500 points", "Redeem points", "Use my
    // rewards": a click spends the shopper's points or picks an offer for
    // them, and they never asked. No code is involved, so nothing the finder
    // is for. Only CLICKED controls are judged: a box labelled "Promo or
    // rewards code" is still a coupon box and its "Apply" is still clicked.
    beforeEach(() => {
        flags = { discovery: true, llm: true }
    })
    const POINTS =
        '<div class="loyalty"><p>You have 500 points</p>' +
        '<button id="spend" type="button">Apply discount</button></div>'
    const watch = id =>
        document
            .getElementById(id)
            .addEventListener('click', () => t.page.push('SPENT:' + id))
    const spent = () => t.page.filter(e => e.startsWith('SPENT:'))

    it('a points "Apply discount" and no coupon box: nothing clicked, the codes to copy', async () => {
        freshPage(POINTS + TOTAL)
        watch('spend')
        await tryInitialize()
        await run()
        expect(spent()).toEqual([])
        expect(t.savings).toEqual([])
        expect(reported('worked')).toEqual([])
        handedOver()
    })

    it('the rules never offer such a control as a reveal on their own', async () => {
        freshPage(POINTS + TOTAL)
        await tryInitialize()
        // Nothing on this page is a coupon box: the prompt may still show
        // (the server may be asked), but the rules saw no box behind it.
        expect(document.querySelector('[data-caramel-found]')).toBeNull()
    })

    for (const [label, html] of [
        ['"Apply discount" under a points balance', POINTS],
        [
            '"Use my rewards"',
            '<div><button id="spend" type="button">Use my rewards</button></div>',
        ],
        [
            '"See offers"',
            '<div><button id="spend" type="button" aria-expanded="false">See offers</button></div>',
        ],
        [
            '"Promotions"',
            '<div><div id="spend" role="button" aria-expanded="false">Promotions</div></div>',
        ],
    ])
        it(`the server names ${label} as the reveal: never clicked`, async () => {
            freshPage(html + TOTAL)
            watch('spend')
            answer = req =>
                pick(
                    null,
                    null,
                    idx(
                        req.outline,
                        /Apply discount|Use my rewards|See offers|Promotions/,
                    ),
                )
            await run()
            expect(asked('couponBoxPick')).toHaveLength(1)
            expect(spent()).toEqual([])
            expect(t.savings).toEqual([])
            handedOver()
        })

    for (const label of ['Redeem points', 'Use my rewards', 'Redeem'])
        it(`the server names "${label}" beside a bare field as the apply button: never clicked, nothing typed`, async () => {
            freshPage(
                `<div class="f"><input id="x" name="field_7" type="text"><button id="spend" type="button">${label}</button></div>` +
                    TOTAL,
            )
            watch('spend')
            answer = req =>
                pick(
                    idx(req.outline, /textbox/),
                    // The only button on the page (the outline may shorten
                    // its name: "Redeem points" is outlined as "Redeem").
                    idx(req.outline, /button "/),
                )
            await run()
            expect(asked('couponBoxPick')).toHaveLength(1)
            expect(spent()).toEqual([])
            expect(document.getElementById('x').value).toBe('')
            expect(t.savings).toEqual([])
            handedOver()
        })

    it('the server names a "Points to redeem" field that applies on Enter: nothing typed, Enter never pressed', async () => {
        freshPage(
            '<div class="pts"><label for="pt">Points to redeem</label>' +
                '<input id="pt" name="points_amount" type="text"></div>' +
                TOTAL,
        )
        const keys = []
        document
            .getElementById('pt')
            .addEventListener('keydown', e => keys.push(e.key))
        answer = req => pick(idx(req.outline, /textbox/), null)
        await run()
        expect(asked('couponBoxPick')).toHaveLength(1)
        expect(keys).toEqual([])
        expect(document.getElementById('pt').value).toBe('')
        expect(t.savings).toEqual([])
        handedOver()
    })

    it('a points "Apply discount" beside a real promo box in the same panel: the code goes in the promo box, the points are left alone', async () => {
        freshPage(
            '<div class="sidebar"><div class="promo"><label for="dc">Discount code</label>' +
                '<input id="dc" name="discount_code" type="text">' +
                '<button id="ap" type="button">Apply</button></div>' +
                POINTS +
                '</div>' +
                TOTAL,
        )
        watch('spend')
        wireStore('dc', 'ap', 'drop')
        await run()
        expect(spent()).toEqual([])
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
    })

    it('a box labelled "Promo or rewards code" is still a coupon box, and its plain "Apply" is still clicked', async () => {
        freshPage(
            '<div class="promo"><label for="pr">Promo or rewards code</label>' +
                '<input id="pr" name="promo_rewards_code" type="text">' +
                '<button id="pa" type="button">Apply</button></div>' +
                TOTAL,
        )
        wireStore('pr', 'pa', 'drop')
        await run()
        expect(t.page[0]).toBe('submit:pa:SAVE20')
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
        expect(reported('worked')).toHaveLength(1)
    })
})
