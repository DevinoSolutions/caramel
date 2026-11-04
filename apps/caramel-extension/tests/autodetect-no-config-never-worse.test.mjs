import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { _caramelResetDiscoveryFlag } from '../coupon-box-discovery.js'
import { _caramelResetFinderLoad } from '../coupon-box-finder-loader.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import {
    _caramelResetCachedCodes,
    caramelConfiglessRecord,
    caramelStoreListKnown,
    getDomainRecord,
    startCheckoutDetection,
    tryInitialize,
} from '../store-detect.js'
import {
    FINDER_ASSET,
    FINDER_FILE,
    FINDER_WITHOUT_HANDOVER,
} from './_finder-asset.mjs'

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
// How the finder file loads: 'ok', 'missing' (the URL resolves to nothing),
// 'throws' (the URL cannot even be built, as in a torn-down extension) or
// 'no-handover' (a module that cannot take the content script's helpers).
let finderLoad
const MISSING_FINDER = pathToFileURL(
    resolve(import.meta.dirname, '../no-such-finder.js'),
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

// Every finder entry point another module calls, counted: the finder's own
// and the content script's share of it (the flag read and the on-demand
// load). The real implementation still runs underneath.
// failing.name makes that one entry point throw instead.
const { finderCalls, counted, countedModule, failing } = vi.hoisted(() => {
    const finderCalls = {}
    const failing = { name: null }
    const counted = actual => {
        const out = {}
        for (const [name, value] of Object.entries(actual)) {
            if (typeof value !== 'function' || name.startsWith('_')) {
                out[name] = value
                continue
            }
            out[name] = (...args) => {
                finderCalls[name] = (finderCalls[name] || 0) + 1
                if (failing.name === name) throw new Error(`${name} failed`)
                return value(...args)
            }
        }
        return out
    }
    // The finder the loader hands out, counted the same way: the content
    // script reaches the loaded finder only through the loader.
    const countedModules = new WeakMap()
    const countedModule = m => {
        if (!m) return m
        if (!countedModules.has(m)) countedModules.set(m, counted(m))
        return countedModules.get(m)
    }
    return { finderCalls, counted, countedModule, failing }
})
vi.mock('../coupon-box-discovery.js', async importOriginal =>
    counted(await importOriginal()),
)
vi.mock('../coupon-box-finder-loader.js', async importOriginal => {
    const out = counted(await importOriginal())
    const load = out.caramelLoadFinder
    const loaded = out.caramelLoadedFinder
    out.caramelLoadFinder = (...args) => load(...args).then(countedModule)
    out.caramelLoadedFinder = (...args) => countedModule(loaded(...args))
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
        if (path === 'assets/coupon-box-outline.js') return OUTLINE_FILE
        if (path === FINDER_ASSET) {
            if (finderLoad === 'throws')
                throw new Error('Extension context invalidated.')
            if (finderLoad === 'no-handover') return FINDER_WITHOUT_HANDOVER
            return finderLoad === 'missing' ? MISSING_FINDER : FINDER_FILE
        }
        return 'chrome-extension://caramel/' + path
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
// A box whose only coupon evidence is the form it posts to. That is enough
// for a box the server names to be typed into, never for the rules to type a
// code into it on their own.
const SERVER_BOX =
    '<form class="f" action="/cart/coupon"><input id="x" name="field_7" type="text">' +
    '<button id="go" type="button">Go</button></form>'

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
    _caramelResetCachedCodes()
    _caramelResetDiscoveryFlag()
    _caramelResetFinderLoad()
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
    finderLoad = 'ok'
    failing.name = null
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
            // The only finder code that ran is the question "is it on?": the
            // finder itself was never even requested.
            expect(Object.keys(finderCalls)).toEqual([
                'caramelCouponBoxDiscoveryOn',
            ])
            expect(t.urls).not.toContain(FINDER_ASSET)
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
        expect(t.urls).not.toContain(FINDER_ASSET)
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

describe('the finder is loaded only where it is about to run, and a failed load is no box', () => {
    beforeEach(() => {
        flags = { discovery: true, llm: true }
    })

    it('flags on, a cart with no config: the finder is requested once for the whole visit', async () => {
        freshPage(RULES_BOX + TOTAL)
        wireStore('dc', 'ap', 'drop')
        await tryInitialize()
        expect(t.prompts).toEqual([location.hostname])
        await run()
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
        expect(t.urls.filter(u => u === FINDER_ASSET)).toHaveLength(1)
    })

    for (const mode of ['missing', 'throws', 'no-handover']) {
        it(`a finder that will not load (${mode}): no prompt, nothing asked of the server`, async () => {
            finderLoad = mode
            freshPage(RULES_BOX + TOTAL)
            wireStore('dc', 'ap', 'drop')
            await tryInitialize()
            expect(t.prompts).toEqual([])
            expect(asked('couponBoxPick')).toEqual([])
            expect(t.urls).not.toContain('assets/coupon-box-outline.js')
        })

        it(`a finder that will not load (${mode}): the codes are handed over, nothing typed, no saving`, async () => {
            finderLoad = mode
            freshPage(RULES_BOX + TOTAL)
            wireStore('dc', 'ap', 'drop')
            await run()
            expect(t.page).toEqual([])
            expect(t.savings).toEqual([])
            expect(reported('worked')).toEqual([])
            expect(document.querySelector('[data-caramel-found]')).toBeNull()
            expect(lastModal().message).toMatch(/couldn't find the promo box/)
            handedOver()
        })
    }

    it('a finder that throws while finding the box: the codes are handed over, nothing typed, no saving', async () => {
        freshPage(RULES_BOX + TOTAL)
        wireStore('dc', 'ap', 'drop')
        failing.name = 'caramelDiscoveredRecord'
        await run()
        expect(finderCalls.caramelDiscoveredRecord).toBe(1)
        expect(t.page).toEqual([])
        expect(t.savings).toEqual([])
        expect(reported('worked')).toEqual([])
        expect(lastModal().message).toMatch(/couldn't find the promo box/)
        handedOver()
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

    it('a box the rules see but cannot use, with the server off: nothing is typed and the codes are to copy', async () => {
        flags = { discovery: true, llm: false }
        freshPage(SERVER_BOX + TOTAL)
        wireStore('x', 'go', 'drop')
        await run()
        expect(asked('couponBoxPick')).toEqual([])
        expect(t.page).toEqual([])
        expect(document.getElementById('x').value).toBe('')
        expect(t.savings).toEqual([])
        handedOver()
    })

    it('a box the server named, the total really drops: the same $20 saving', async () => {
        freshPage(SERVER_BOX + TOTAL)
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
            SERVER_BOX + TOTAL,
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
            expect(lastModal().message).toMatch(/takes promo codes at checkout/)
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

    // A reveal that offers deals or the small print without naming a code is
    // refused even with no points in sight.
    for (const [label, html] of [
        [
            '"View offers"',
            '<div><button id="spend" type="button" aria-expanded="false">View offers</button></div>',
        ],
        [
            '"Promo details"',
            '<div><button id="spend" type="button" aria-expanded="false">Promo details</button></div>',
        ],
    ])
        it(`the server names ${label} as the reveal: never clicked`, async () => {
            freshPage(html + TOTAL)
            watch('spend')
            answer = req => pick(null, null, idx(req.outline, /button "/))
            await run()
            expect(asked('couponBoxPick')).toHaveLength(1)
            expect(spent()).toEqual([])
            expect(t.savings).toEqual([])
            handedOver()
        })

    // A reveal that says only "discount" is a code box's fold: clicked, and
    // the code goes into the box it opens. Unless it, or the words beside it,
    // or its section speak of points, rewards, a gift card or a group: then
    // neither the rules nor the server's pick click it.
    const FOLD = (label, lead = '') =>
        '<div class="fold">' +
        lead +
        '<button id="spend" type="button" aria-expanded="false">' +
        label +
        '</button><div id="panel" style="display:none">' +
        '<input id="x" name="field_7" type="text">' +
        '<button id="go" type="button">Go</button></div></div>'
    // The fold is the page's first button: the outline may drop words of its
    // name ("member", "student"), so it is not found by its name.
    const pickFold = req =>
        pick(
            idx(req.outline, /textbox/),
            idx(req.outline, /button "Go/),
            idx(req.outline, /button /),
        )
    const opens = () =>
        document.getElementById('spend').addEventListener('click', () => {
            document.getElementById('panel').style.display = ''
        })
    for (const label of [
        'Discount',
        'Add discount',
        'Have a discount?',
        'Apply a discount',
        'Apply discount',
    ])
        it(`a "${label}" fold: it is opened and the code goes in`, async () => {
            freshPage(FOLD(label) + TOTAL)
            watch('spend')
            opens()
            wireStore('x', 'go', 'drop')
            // The rules open it on their own; the server would name it too.
            answer = pickFold
            await run()
            expect(spent()).toEqual(['SPENT:spend'])
            expect(t.page).toContain('submit:go:SAVE20')
            expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
        })
    for (const [label, name, open = '', close = '', lead] of [
        ['"Discounts & rewards"', 'Discounts & rewards'],
        ['"Member discount"', 'Member discount'],
        ['"Student discount"', 'Student discount'],
        ['"Military discount"', 'Military discount'],
        [
            '"Have a discount?" beside a points balance',
            'Have a discount?',
            '',
            '',
            '<p>You have 500 points</p>',
        ],
        [
            '"Add discount" in a section headed "Gift cards"',
            'Add discount',
            '<section><h3>Gift cards</h3>',
            '</section>',
        ],
    ])
        it(`the server names ${label} as the reveal: never clicked, nothing typed`, async () => {
            freshPage(open + FOLD(name, lead) + close + TOTAL)
            watch('spend')
            opens()
            wireStore('x', 'go', 'drop')
            answer = pickFold
            await run()
            expect(asked('couponBoxPick')).toHaveLength(1)
            expect(spent()).toEqual([])
            expect(document.getElementById('x').value).toBe('')
            expect(t.savings).toEqual([])
            handedOver()
        })

    // The words the server never sees: the section a control sits in.
    for (const [label, open, close] of [
        [
            'an aside named "Rewards"',
            '<aside aria-label="Rewards">',
            '</aside>',
        ],
        [
            'a section headed "Member price"',
            '<section><h3>Member price</h3>',
            '</section>',
        ],
        [
            'a section headed "Students save 10%"',
            '<section><h3>Students save 10%</h3>',
            '</section>',
        ],
        [
            'a section headed "Military discount"',
            '<section><h2>Military discount</h2>',
            '</section>',
        ],
        [
            'a fieldset for teachers',
            '<form onsubmit="return false"><fieldset><legend>Teacher discount</legend>',
            '</fieldset></form>',
        ],
        [
            'a section named by a heading elsewhere ("Verify your status")',
            '<p id="vh">Verify your status</p><section aria-labelledby="vh">',
            '</section>',
        ],
    ])
        it(`the server names a plain "Apply" in ${label} as the apply button: never clicked, nothing typed`, async () => {
            freshPage(
                open +
                    '<div class="f"><input id="x" name="field_7" type="text">' +
                    '<button id="spend" type="button">Apply</button></div>' +
                    close +
                    TOTAL,
            )
            watch('spend')
            answer = req =>
                pick(
                    idx(req.outline, /textbox/),
                    idx(req.outline, /button "Apply/),
                )
            await run()
            expect(asked('couponBoxPick')).toHaveLength(1)
            expect(spent()).toEqual([])
            expect(document.getElementById('x').value).toBe('')
            expect(t.savings).toEqual([])
            handedOver()
        })

    it('the server names a "Show" reveal in a section headed "Your rewards": never clicked', async () => {
        freshPage(
            '<section><h3>Your rewards</h3><div><button id="spend" type="button" aria-expanded="false">Show</button></div></section>' +
                TOTAL,
        )
        watch('spend')
        answer = req => pick(null, null, idx(req.outline, /button "Show/))
        await run()
        expect(asked('couponBoxPick')).toHaveLength(1)
        expect(spent()).toEqual([])
        handedOver()
    })

    it('a promo box in a section headed "Rewards & promo codes": its "Apply" is still clicked', async () => {
        freshPage(
            '<section><h3>Rewards &amp; promo codes</h3><div class="promo">' +
                '<label for="dc">Promo code</label>' +
                '<input id="dc" name="promo_code" type="text">' +
                '<button id="ap" type="button">Apply</button></div></section>' +
                TOTAL,
        )
        wireStore('dc', 'ap', 'drop')
        await run()
        expect(t.page[0]).toBe('submit:ap:SAVE20')
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
    })

    it('a button that names a code is clicked even inside a "Rewards" section', async () => {
        freshPage(
            '<aside aria-label="Rewards"><div class="promo"><label for="dc">Discount</label>' +
                '<input id="dc" name="discount_code" type="text">' +
                '<button id="ap" type="button">Apply code</button></div></aside>' +
                TOTAL,
        )
        wireStore('dc', 'ap', 'drop')
        await run()
        expect(t.page[0]).toBe('submit:ap:SAVE20')
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
    })

    // A switch or a radio is a setting; a checkbox is a fold only when it
    // speaks of entering a code.
    for (const [label, html] of [
        [
            'a switch "Use promo"',
            '<div><div id="spend" role="switch" aria-checked="false" tabindex="0">Use promo</div></div>',
        ],
        [
            'a checkbox "Use my points"',
            '<div><input id="spend" type="checkbox"><label for="spend">Use my points</label></div>',
        ],
        [
            'a checkbox "Add shipping protection ($4.99)"',
            '<div><input id="spend" type="checkbox"><label for="spend">Add shipping protection ($4.99)</label></div>',
        ],
    ])
        it(`the server names ${label} as the reveal: never clicked`, async () => {
            freshPage(html + TOTAL)
            watch('spend')
            answer = req =>
                pick(null, null, idx(req.outline, /switch|checkbox/))
            await run()
            expect(asked('couponBoxPick')).toHaveLength(1)
            expect(spent()).toEqual([])
            expect(document.getElementById('spend').checked ?? false).toBe(
                false,
            )
            handedOver()
        })

    it('a checkbox that speaks of entering a code and folds the box is still opened', async () => {
        freshPage(
            '<div class="promo"><input type="checkbox" id="cb"><label for="cb">Have a promo code?</label>' +
                '<div id="content" style="display:none"><input id="dc" name="discount_code" type="text">' +
                '<button id="ap" type="button">Apply</button></div></div>' +
                TOTAL,
        )
        document.getElementById('cb').addEventListener('change', e => {
            document.getElementById('content').style.display = e.target.checked
                ? ''
                : 'none'
        })
        wireStore('dc', 'ap', 'drop')
        answer = req =>
            pick(
                idx(req.outline, /textbox/),
                idx(req.outline, /button "Apply/),
                idx(req.outline, /checkbox/),
            )
        await run()
        expect(document.getElementById('cb').checked).toBe(true)
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
    })
})

describe('store credit, a gift card or a balance is never spent by the finder or the pick', () => {
    // Applying store credit, a gift card or an account balance drops the
    // total exactly like a code would, and the money check would read it as a
    // saving that is not one: the shopper's own money, spent unasked. No code
    // is involved, so neither the rules nor the server's pick click such a
    // control, as a reveal or as an apply button, and neither types into or
    // presses Enter in a field that takes one.
    beforeEach(() => {
        flags = { discovery: true, llm: true }
    })
    const watch = id =>
        document
            .getElementById(id)
            .addEventListener('click', () => t.page.push('SPENT:' + id))
    const spent = () => t.page.filter(e => e.startsWith('SPENT:'))
    const FOLD = (label, lead = '') =>
        '<div class="fold">' +
        lead +
        '<button id="spend" type="button" aria-expanded="false">' +
        label +
        '</button><div id="panel" style="display:none">' +
        '<input id="x" name="field_7" type="text">' +
        '<button id="go" type="button">Go</button></div></div>'
    // The outline drops words it does not know ("credit", "balance"), so the
    // reveal is found as the page's first button.
    const pickFold = req =>
        pick(
            idx(req.outline, /textbox/),
            idx(req.outline, /button "Go/),
            idx(req.outline, /button /),
        )
    const opens = () =>
        document.getElementById('spend').addEventListener('click', () => {
            document.getElementById('panel').style.display = ''
        })
    const nothingSpent = () => {
        expect(asked('couponBoxPick')).toHaveLength(1)
        expect(spent()).toEqual([])
        expect(document.getElementById('x').value).toBe('')
        expect(t.savings).toEqual([])
        handedOver()
    }

    const CONTROLS = [
        'Use store credit',
        'Apply credit',
        'Apply gift card',
        'Have a gift card?',
        'Use balance',
    ]
    for (const label of CONTROLS)
        it(`"${label}" as the reveal: neither the rules nor the server open it`, async () => {
            freshPage(FOLD(label) + TOTAL)
            watch('spend')
            opens()
            wireStore('x', 'go', 'drop')
            answer = pickFold
            await run()
            nothingSpent()
        })
    for (const label of CONTROLS)
        it(`"${label}" beside a bare field, named as the apply button: never clicked, nothing typed`, async () => {
            freshPage(
                '<div class="f"><input id="x" name="field_7" type="text">' +
                    `<button id="spend" type="button">${label}</button></div>` +
                    TOTAL,
            )
            watch('spend')
            wireStore('x', 'spend', 'drop')
            answer = req =>
                pick(idx(req.outline, /textbox/), idx(req.outline, /button /))
            await run()
            nothingSpent()
        })

    it('a plain "Apply" beside a gift card number field: never clicked, nothing typed', async () => {
        freshPage(
            '<div class="gc"><label for="x">Gift card number</label>' +
                '<input id="x" name="gc_number" type="text">' +
                '<button id="spend" type="button">Apply</button></div>' +
                TOTAL,
        )
        watch('spend')
        wireStore('x', 'spend', 'drop')
        answer = req =>
            pick(idx(req.outline, /textbox/), idx(req.outline, /button /))
        await run()
        nothingSpent()
    })

    it('"Apply discount" in a section headed "Store credit": never clicked, nothing typed', async () => {
        freshPage(
            '<section><h3>Store credit</h3><p>$25.00 available</p>' +
                '<div class="f"><input id="x" name="field_7" type="text">' +
                '<button id="spend" type="button">Apply discount</button></div></section>' +
                TOTAL,
        )
        watch('spend')
        wireStore('x', 'spend', 'drop')
        answer = req =>
            pick(idx(req.outline, /textbox/), idx(req.outline, /button /))
        await run()
        nothingSpent()
    })

    it('an "Apply discount" reveal beside a store credit balance: never opened', async () => {
        freshPage(FOLD('Apply discount', '<p>Store credit: $25.00</p>') + TOTAL)
        watch('spend')
        opens()
        wireStore('x', 'go', 'drop')
        answer = pickFold
        await run()
        nothingSpent()
    })

    it('a store credit field that applies on Enter: nothing typed, Enter never pressed', async () => {
        freshPage(
            '<div class="sc"><label for="x">Store credit to use</label>' +
                '<input id="x" name="store_credit_amount" type="text"></div>' +
                TOTAL,
        )
        const keys = []
        document
            .getElementById('x')
            .addEventListener('keydown', e => keys.push(e.key))
        answer = req => pick(idx(req.outline, /textbox/), null)
        await run()
        expect(asked('couponBoxPick')).toHaveLength(1)
        expect(keys).toEqual([])
        expect(document.getElementById('x').value).toBe('')
        expect(t.savings).toEqual([])
        handedOver()
    })

    // What must still work: a coupon box beside a gift card or a balance.
    it('a promo box with a "Check gift card balance" link beside its Apply: the code goes in', async () => {
        freshPage(
            '<div class="promo"><label for="dc">Promo code</label>' +
                '<input id="dc" name="promo_code" type="text">' +
                '<button id="ap" type="button">Apply</button>' +
                '<a href="#gc">Check gift card balance</a></div>' +
                TOTAL,
        )
        wireStore('dc', 'ap', 'drop')
        await run()
        expect(t.page[0]).toBe('submit:ap:SAVE20')
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
    })

    it('a box labelled "Gift card or promo code": the code goes in', async () => {
        freshPage(
            '<div class="promo"><label for="dc">Gift card or promo code</label>' +
                '<input id="dc" name="gift_or_promo" type="text">' +
                '<button id="ap" type="button">Apply</button></div>' +
                TOTAL,
        )
        wireStore('dc', 'ap', 'drop')
        await run()
        expect(t.page[0]).toBe('submit:ap:SAVE20')
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
    })

    // Measured on uncommongoods.com 2026-10-22, markup trimmed: the cart's
    // promo box ("Apply a promo code", field "Promo Code") has an "apply"
    // button whose aria-label says "Submit Uncommon Credit Code". "Credit"
    // read as store credit refused the button, so neither the rules nor the
    // server's correct pick could use the box and the shopper got codes to
    // copy. A credit CODE is a code the shopper types, not a balance.
    const CREDIT_CODE_BOX =
        '<div class="panel"><h4>Apply a promo code</h4>' +
        '<div class="input-group"><label for="input-id-w13keza"><span>Promo Code</span></label>' +
        '<input id="input-id-w13keza" type="text" maxlength="10" autocomplete="off" aria-label="Promo Code">' +
        '<button id="cart-credits-submit-button" type="button" aria-label="Submit Uncommon Credit Code" class="btn-secondary"> apply </button>' +
        '</div></div>'
    it('a promo box whose apply button is labelled "Submit ... Credit Code": the code goes in', async () => {
        freshPage(CREDIT_CODE_BOX + TOTAL)
        wireStore('input-id-w13keza', 'cart-credits-submit-button', 'drop')
        answer = req =>
            pick(idx(req.outline, /textbox/), idx(req.outline, /button /))
        await run()
        expect(t.page[0]).toBe('submit:cart-credits-submit-button:SAVE20')
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
    })
    // Credit in the name alone is forgiven only when the label names a code.
    for (const [label, name] of [
        ['Use credit', 'cart-credits-submit-button'],
        ['Apply credits', 'cart-credits-submit-button'],
        ['Apply', 'cart-credits-submit-button'],
        ['Submit', 'store_credit_apply'],
    ])
        it(`"${label}" named ${name} beside a bare field is still never clicked`, async () => {
            freshPage(
                '<div class="f"><input id="x" name="field_7" type="text">' +
                    `<button id="spend" name="${name}" type="button">${label}</button></div>` +
                    TOTAL,
            )
            watch('spend')
            wireStore('x', 'spend', 'drop')
            answer = req =>
                pick(idx(req.outline, /textbox/), idx(req.outline, /button /))
            await run()
            nothingSpent()
        })

    it('a box the server names in a section headed "Credit card": a payment method, not credit, so the code goes in', async () => {
        freshPage(
            '<section><h3>Credit card</h3>' +
                '<form class="f" action="/cart/coupon"><input id="x" name="field_7" type="text">' +
                '<button id="go" type="button">Apply</button></form></section>' +
                TOTAL,
        )
        wireStore('x', 'go', 'drop')
        answer = req =>
            pick(idx(req.outline, /textbox/), idx(req.outline, /button "Apply/))
        await run()
        expect(t.page[0]).toBe('submit:go:SAVE20')
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
    })
})

describe('"Redeem" and the words that name a code read as the server reads them', () => {
    beforeEach(() => {
        flags = { discovery: true, llm: true }
    })
    const watch = id =>
        document
            .getElementById(id)
            .addEventListener('click', () => t.page.push('SPENT:' + id))
    const spent = () => t.page.filter(e => e.startsWith('SPENT:'))
    const pickBox = req =>
        pick(idx(req.outline, /textbox/), idx(req.outline, /button /))

    it('"Redeem" beside a field labelled "Gutschein": the code goes in', async () => {
        freshPage(
            '<div class="f"><label for="x">Gutschein</label>' +
                '<input id="x" name="field_7" type="text">' +
                '<button id="rd" type="button">Redeem</button></div>' +
                TOTAL,
        )
        wireStore('x', 'rd', 'drop')
        answer = pickBox
        await run()
        expect(t.page).toContain('submit:rd:SAVE20')
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
    })

    it('"Redeem" beside a field labelled "Gift card code": never clicked, nothing typed', async () => {
        freshPage(
            '<div class="f"><label for="x">Gift card code</label>' +
                '<input id="x" name="field_7" type="text">' +
                '<button id="spend" type="button">Redeem</button></div>' +
                TOTAL,
        )
        watch('spend')
        wireStore('x', 'spend', 'drop')
        answer = pickBox
        await run()
        expect(spent()).toEqual([])
        expect(document.getElementById('x').value).toBe('')
        expect(t.savings).toEqual([])
        handedOver()
    })

    it('"Redeem 500 points for a $5 code" as the reveal: never opened', async () => {
        freshPage(
            '<div class="fold"><button id="spend" type="button" aria-expanded="false">' +
                'Redeem 500 points for a $5 code</button>' +
                '<div id="panel" style="display:none"><input id="x" name="field_7" type="text">' +
                '<button id="go" type="button">Go</button></div></div>' +
                TOTAL,
        )
        watch('spend')
        document.getElementById('spend').addEventListener('click', () => {
            document.getElementById('panel').style.display = ''
        })
        wireStore('x', 'go', 'drop')
        answer = req =>
            pick(
                idx(req.outline, /textbox/),
                idx(req.outline, /button "Go/),
                idx(req.outline, /button /),
            )
        await run()
        expect(spent()).toEqual([])
        expect(document.getElementById('x').value).toBe('')
        expect(t.savings).toEqual([])
        handedOver()
    })

    it('a plain "Apply" in a section headed "Redeem a promo code": the code goes in', async () => {
        freshPage(
            '<section><h3>Redeem a promo code</h3>' +
                '<div class="f"><input id="x" name="field_7" type="text">' +
                '<button id="go" type="button">Apply</button></div></section>' +
                TOTAL,
        )
        wireStore('x', 'go', 'drop')
        answer = pickBox
        await run()
        expect(t.page).toContain('submit:go:SAVE20')
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
    })

    // A fold that names its code in another language is a code box's fold,
    // even where a fold that says only "discount" is not.
    for (const label of ['Bon de réduction', 'Rabattkod'])
        it(`a "${label}" fold in a section headed "Gift cards": it is opened and the code goes in`, async () => {
            freshPage(
                '<section><h3>Gift cards</h3><div class="fold">' +
                    `<button id="tg" type="button" aria-expanded="false">${label}</button>` +
                    '<div id="panel" style="display:none"><label for="x">Code promo</label>' +
                    '<input id="x" name="field_7" type="text">' +
                    '<button id="go" type="button">Go</button></div></div></section>' +
                    TOTAL,
            )
            document.getElementById('tg').addEventListener('click', () => {
                t.page.push('OPENED')
                document.getElementById('panel').style.display = ''
            })
            wireStore('x', 'go', 'drop')
            answer = req =>
                pick(
                    idx(req.outline, /textbox/),
                    idx(req.outline, /button "Go/),
                    idx(req.outline, /button /),
                )
            await run()
            expect(t.page).toContain('OPENED')
            expect(t.page).toContain('submit:go:SAVE20')
            expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
        })
})

describe("a control that moves the checkout on or opens the orders page is never clicked on the server's word", () => {
    // The server never names these, and the extension holds the same list:
    // "Next" and "Proceed" move the checkout on a step, and a control named
    // only "Orders" or "My orders" leaves the cart for the account pages.
    beforeEach(() => {
        flags = { discovery: true, llm: true }
    })
    const watch = id =>
        document
            .getElementById(id)
            .addEventListener('click', () => t.page.push('LEFT:' + id))
    const left = () => t.page.filter(e => e.startsWith('LEFT:'))

    for (const label of ['Next', 'Proceed', 'Orders', 'My orders'])
        it(`"${label}" named as the apply button: never clicked, nothing typed`, async () => {
            freshPage(
                '<div class="f"><input id="x" name="field_7" type="text">' +
                    `<button id="away" type="button">${label}</button></div>` +
                    TOTAL,
            )
            watch('away')
            wireStore('x', 'away', 'drop')
            answer = req =>
                pick(idx(req.outline, /textbox/), idx(req.outline, /button /))
            await run()
            expect(asked('couponBoxPick')).toHaveLength(1)
            expect(left()).toEqual([])
            expect(document.getElementById('x').value).toBe('')
            expect(t.savings).toEqual([])
            handedOver()
        })

    for (const label of ['Next', 'My orders'])
        it(`"${label}" named as the reveal: never opened`, async () => {
            freshPage(
                '<div class="fold">' +
                    `<button id="away" type="button" aria-expanded="false">${label}</button>` +
                    '<div id="panel" style="display:none">' +
                    '<input id="x" name="field_7" type="text">' +
                    '<button id="go" type="button">Go</button></div></div>' +
                    TOTAL,
            )
            watch('away')
            document.getElementById('away').addEventListener('click', () => {
                document.getElementById('panel').style.display = ''
            })
            wireStore('x', 'go', 'drop')
            answer = req =>
                pick(
                    idx(req.outline, /textbox/),
                    idx(req.outline, /button "Go/),
                    idx(req.outline, /button /),
                )
            await run()
            expect(asked('couponBoxPick')).toHaveLength(1)
            expect(left()).toEqual([])
            expect(document.getElementById('x').value).toBe('')
            expect(t.savings).toEqual([])
            handedOver()
        })

    // A name that holds "order" without being only that is still a button.
    it('"Apply to order" named as the apply button: the code goes in', async () => {
        freshPage(
            '<form class="f" action="/cart/coupon"><input id="x" name="field_7" type="text">' +
                '<button id="ap" type="button">Apply to order</button></form>' +
                TOTAL,
        )
        wireStore('x', 'ap', 'drop')
        answer = req =>
            pick(idx(req.outline, /textbox/), idx(req.outline, /button /))
        await run()
        expect(t.page).toContain('submit:ap:SAVE20')
        expect(t.savings).toEqual([{ code: 'SAVE20', amount: 20 }])
    })
})
