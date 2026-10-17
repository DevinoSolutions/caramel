import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { _caramelResetDiscoveryFlag } from '../coupon-box-discovery.js'
import { LEARNED_KEY } from '../coupon-box-learned.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import {
    caramelConfiglessRecord,
    getDomainRecord,
    isCheckout,
} from '../store-detect.js'
import { LEARNED_ACTIONS, learnedBackground } from './_learned-background.mjs'

// The server's pick mode and the learned coupon box, on a store with no
// config. These pin:
//   · rules_first is today's order; llm_first asks the server first and falls
//     back to the rules on any miss in the same visit; llm_only never lets
//     the rules find the box, and a miss is a miss;
//   · the prompt offers a run where the run could find a box in that mode;
//   · a box is remembered only when the store answered through it (the total
//     dropped, or it replied about the code), is tried first next time, and
//     is forgotten after two failed uses;
//   · a store with a served config is untouched by all of it, and with the
//     finder off nothing is read or saved.

const LEARNED_FILE = pathToFileURL(
    resolve(import.meta.dirname, '../coupon-box-learned.js'),
).href
const OUTLINE_FILE = pathToFileURL(
    resolve(import.meta.dirname, '../coupon-box-outline.js'),
).href

let finalModals
let appliedWith
let applyResult // what the store does with a code: { success } / { errorMsg }
let flagOn
let llmOn
let mode
let answer
let pickCalls
// The background's per-tab hold of the box a run used.
let holds = new Map()
let reported // couponBoxLearned messages
let local // storage.local
let localReads

vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: async (code, rec) => {
        appliedWith.push({ code, rec })
        return {
            success: false,
            applied: false,
            ...(typeof applyResult === 'function'
                ? applyResult(code)
                : applyResult),
        }
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
    stub.storage.local.get = (keys, cb) => {
        localReads.push(...[].concat(keys))
        cb(
            Object.fromEntries(
                [].concat(keys).map(k => [k, structuredClone(local[k])]),
            ),
        )
    }
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
            cb({
                coupons: [
                    { code: 'SAVE20', id: 'c1' },
                    { code: 'TAKE10', id: 'c2' },
                ],
            })
        else if (a === 'couponBoxDiscoveryEnabled') cb({ enabled: flagOn })
        else if (a === 'couponBoxLlmEnabled') cb({ enabled: llmOn, mode })
        else if (a === 'couponBoxPick') {
            pickCalls.push(message)
            cb(typeof answer === 'function' ? answer(message) : answer)
        } else if (LEARNED_ACTIONS.includes(a))
            learnedBackground(
                stub.storage.local,
                reported,
                holds,
            )(message).then(cb)
        else cb?.({})
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
// A box the rules recognise.
const RULES_BOX =
    '<div class="r"><label for="dc">Discount code</label>' +
    '<input id="dc" name="discount_code" type="text">' +
    '<button id="ap" type="button">Apply</button></div>'
// Six wrappers: the rules look for a field's apply button no more than six
// levels up from it, so a button outside them is one only the server names.
const deep = html => '<div>'.repeat(6) + html + '</div>'.repeat(6)
const PROMO_FIELD =
    '<input id="x" name="field_7" type="text" placeholder="Promo code">'
// A promo box the rules never settle on: they cannot reach its button.
const BARE_BOX =
    '<div class="f">' +
    deep(PROMO_FIELD) +
    '<button id="go" type="button">Go</button></div>'
// The same box, folded behind a toggle the rules do not read: "Promo code"
// on a plain button with no disclosure signal.
const FOLDED =
    '<button id="tg" type="button">Promo code</button>' +
    '<div id="panel" style="display:none"><label for="dc">Discount code</label>' +
    '<input id="dc" name="discount_code" type="text">' +
    '<button id="ap" type="button">Apply</button></div>'
// The bare box, as remembered.
const LEARNED_BARE = {
    v: 1,
    input: 'input[name="field_7"]',
    apply: 'button#go',
    toggle: null,
    enterOnly: false,
    source: 'llm',
    confirmedAt: 1,
    failures: 0,
}

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
const BARE_PICK = req =>
    box(
        idx(req.outline, /textbox "Promo code"/),
        idx(req.outline, /button "Go"/),
    )

const noConfig = () => caramelConfiglessRecord(location.hostname)
const run = (rec = noConfig()) => startApplyingCoupons(rec)
const drivenInput = () =>
    document.querySelector(appliedWith[0]?.rec.couponInput)?.id ?? null
const gaveCodesToCopy = () =>
    expect(finalModals.at(-1)[2]).toMatch(/couldn't find the promo box/)
const learned = () => local[LEARNED_KEY]?.[location.hostname]
const remember = entry => {
    local[LEARNED_KEY] = { [location.hostname]: entry }
}
// The memory is written after the run's own work, never in its way.
const settle = () =>
    vi.waitFor(() => {
        if (!(reported.length || learned() !== undefined))
            throw new Error('not yet')
    })

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
    applyResult = {}
    pickCalls = []
    reported = []
    holds = new Map()
    local = {}
    localReads = []
    flagOn = true
    llmOn = true
    mode = 'rules_first'
    answer = { outcome: 'no_box', confidence: 80, why: 'none', cached: false }
    getDomainRecord.cache = []
    _caramelResetDiscoveryFlag()
})

describe('pick mode', () => {
    it('rules_first: the rules find the box, the server is not asked', async () => {
        document.body.innerHTML = RULES_BOX + BARE_BOX + TOTAL
        answer = BARE_PICK

        await run()

        expect(pickCalls).toHaveLength(0)
        expect(drivenInput()).toBe('dc')
    })

    it('llm_first: the server is asked first, and its box is the one driven', async () => {
        mode = 'llm_first'
        document.body.innerHTML = RULES_BOX + BARE_BOX + TOTAL
        answer = BARE_PICK

        await run()

        expect(pickCalls).toHaveLength(1)
        expect(drivenInput()).toBe('x')
    })

    for (const [what, reply] of [
        ['no box', { outcome: 'no_box' }],
        ['no pick', { outcome: 'no_pick' }],
        ['a refusal', { error: 'HTTP 429' }],
        ['an error', { error: 'TypeError: Failed to fetch' }],
    ])
        it(`llm_first: ${what} falls back to the rules in the same visit`, async () => {
            mode = 'llm_first'
            document.body.innerHTML = RULES_BOX + TOTAL
            answer = reply

            await run()

            expect(pickCalls).toHaveLength(1)
            expect(drivenInput()).toBe('dc')
        })

    it('llm_only: a miss is a miss, even where the rules see a box', async () => {
        mode = 'llm_only'
        document.body.innerHTML = RULES_BOX + TOTAL

        await run()

        expect(pickCalls).toHaveLength(1)
        expect(appliedWith).toHaveLength(0)
        gaveCodesToCopy()
    })

    it('llm_only: the server box is driven, through the same record', async () => {
        mode = 'llm_only'
        document.body.innerHTML = BARE_BOX + TOTAL
        answer = BARE_PICK

        await run()

        expect(drivenInput()).toBe('x')
        expect(appliedWith[0].rec.caramelFound).toBe(true)
    })

    it('llm_only: a named toggle does not let the rules find the box it reveals', async () => {
        document.body.innerHTML = FOLDED + TOTAL
        document.getElementById('tg').addEventListener('click', () => {
            document.getElementById('panel').style.display = ''
        })
        answer = req => box(null, null, idx(req.outline, /button "Promo code"/))

        mode = 'llm_only'
        await run()
        expect(appliedWith).toHaveLength(0)

        // The same answer in llm_first: the rules may read what it revealed.
        mode = 'llm_first'
        sessionStorage.clear()
        _caramelResetDiscoveryFlag()
        document.getElementById('panel').style.display = 'none'
        await run()
        expect(drivenInput()).toBe('dc')
    })

    it('llm_only: a refused button is never swapped for one the rules find', async () => {
        document.body.innerHTML =
            '<div>' +
            PROMO_FIELD +
            '<button id="po" type="button">Place order</button>' +
            '<button id="ap" type="button">Apply</button></div>' +
            TOTAL
        answer = req =>
            box(
                idx(req.outline, /textbox/),
                idx(req.outline, /button "Place order"/),
            )

        mode = 'llm_only'
        await run()
        expect(appliedWith).toHaveLength(0)

        mode = 'llm_first'
        sessionStorage.clear()
        _caramelResetDiscoveryFlag()
        await run()
        expect(
            document.querySelector(appliedWith[0].rec.couponSubmit)?.id,
        ).toBe('ap')
    })

    it('a mode this build does not know is rules_first', async () => {
        mode = 'llm_sometimes'
        document.body.innerHTML = RULES_BOX + TOTAL

        await run()

        expect(pickCalls).toHaveLength(0)
        expect(drivenInput()).toBe('dc')
    })

    it('with the pick flag off, any mode is rules_first', async () => {
        llmOn = false
        mode = 'llm_only'
        document.body.innerHTML = RULES_BOX + TOTAL

        await run()

        expect(pickCalls).toHaveLength(0)
        expect(drivenInput()).toBe('dc')
    })

    it('a store with a served config is rules_first in every mode, and never reads a learned box', async () => {
        mode = 'llm_only'
        remember(LEARNED_BARE)
        document.body.innerHTML = RULES_BOX + BARE_BOX + TOTAL
        applyResult = { success: true, newTotal: 80, committed: true }

        await run({ domain: location.hostname, couponInput: '#gone' })

        expect(pickCalls).toHaveLength(0)
        expect(drivenInput()).toBe('dc')
        expect(localReads).not.toContain(LEARNED_KEY)
        await new Promise(r => setTimeout(r, 20))
        expect(reported).toEqual([])
        expect(learned()).toEqual(LEARNED_BARE)
    })
})

describe('the prompt offers a run where the mode could find a box', () => {
    const asked = () =>
        sessionStorage.setItem('caramel_box_pick:' + location.hostname, '1')

    it('llm_only: a box only the rules see is no reason to offer', async () => {
        document.body.innerHTML = RULES_BOX + TOTAL
        asked()

        mode = 'rules_first'
        expect(await isCheckout()).toBe(true)

        mode = 'llm_only'
        _caramelResetDiscoveryFlag()
        expect(await isCheckout()).toBe(false)
    })

    it('llm_only and llm_first: a cart the server has not been asked about is offered', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        for (const m of ['llm_only', 'llm_first']) {
            mode = m
            _caramelResetDiscoveryFlag()
            expect(await isCheckout()).toBe(true)
        }
    })

    it('a remembered box is offered when nothing else would be', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        asked()
        expect(await isCheckout()).toBe(false)

        remember(LEARNED_BARE)
        _caramelResetDiscoveryFlag()
        expect(await isCheckout()).toBe(true)
    })

    it('llm_only does not offer a box the rules once found', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        asked()
        remember({ ...LEARNED_BARE, source: 'rules' })

        mode = 'llm_only'
        expect(await isCheckout()).toBe(false)
    })

    it('a store with a served config keeps the rules in llm_only', async () => {
        getDomainRecord.cache = [
            { domain: location.hostname, couponInput: '#gone' },
        ]
        mode = 'llm_only'
        document.body.innerHTML = RULES_BOX + TOTAL
        asked()

        expect(await isCheckout()).toBe(true)
    })
})

describe('a learned box', () => {
    it('is saved when the total dropped, and reported with that evidence', async () => {
        document.body.innerHTML = RULES_BOX + TOTAL
        applyResult = { success: true, newTotal: 80, committed: true }

        await run()
        await settle()

        expect(learned()).toMatchObject({
            v: 1,
            input: 'input#dc',
            apply: 'button#ap',
            toggle: null,
            enterOnly: false,
            source: 'rules',
            failures: 0,
        })
        await vi.waitFor(() => expect(reported).toHaveLength(1))
        expect(reported[0]).toMatchObject({
            domain: location.hostname,
            box: {
                input: 'input#dc',
                apply: 'button#ap',
                toggle: null,
                enterOnly: false,
            },
            source: 'rules',
            evidence: 'total_dropped',
            outcome: 'confirmed',
        })
    })

    it('is saved when the store answered about the code', async () => {
        document.body.innerHTML = RULES_BOX + TOTAL
        applyResult = { errorMsg: 'This code is invalid.', errorIsNew: true }

        await run()
        await settle()
        await vi.waitFor(() => expect(reported).toHaveLength(1))

        expect(learned()?.input).toBe('input#dc')
        expect(reported[0].evidence).toBe('store_answered')
    })

    it('is not saved when nothing happened, or the text was already there', async () => {
        document.body.innerHTML = RULES_BOX + TOTAL
        applyResult = { errorMsg: 'Enter a valid code', errorIsNew: false }

        await run()
        await new Promise(r => setTimeout(r, 20))

        expect(learned()).toBeUndefined()
        expect(reported).toEqual([])
    })

    it("a server pick the store answered through is saved as the model's", async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        answer = BARE_PICK
        applyResult = { success: true, newTotal: 80, committed: true }

        await run()
        await settle()

        expect(learned()).toMatchObject({
            input: 'input#x',
            apply: 'button#go',
            source: 'llm',
        })
        await vi.waitFor(() => expect(reported).toHaveLength(1))
    })

    it('is tried first next time, before the rules and before the server', async () => {
        mode = 'llm_first'
        remember(LEARNED_BARE)
        document.body.innerHTML = RULES_BOX + BARE_BOX + TOTAL

        await run()

        expect(drivenInput()).toBe('x')
        expect(pickCalls).toHaveLength(0)
        // No code took: one failed use of the remembered box.
        await vi.waitFor(() => expect(reported).toHaveLength(1))
        expect(reported[0].outcome).toBe('failed')
    })

    it('two failed uses forget it, and each is reported', async () => {
        remember(LEARNED_BARE)
        document.body.innerHTML = BARE_BOX + TOTAL

        await run()
        await vi.waitFor(() => expect(learned()?.failures).toBe(1))
        await vi.waitFor(() => expect(reported).toHaveLength(1))
        expect(reported[0]).toMatchObject({
            outcome: 'failed',
            evidence: null,
            source: 'llm',
        })

        _caramelResetDiscoveryFlag()
        sessionStorage.clear()
        await run()
        await vi.waitFor(() => expect(learned()).toBeUndefined())
        expect(local[LEARNED_KEY]).toEqual({})
        await vi.waitFor(() => expect(reported).toHaveLength(2))
        expect(reported[1].outcome).toBe('failed')
    })

    it('a reply, then a code that dropped the total: the drop is reported too', async () => {
        document.body.innerHTML = RULES_BOX + TOTAL
        applyResult = code =>
            code === 'SAVE20'
                ? { errorMsg: 'This code is invalid.', errorIsNew: true }
                : { success: true, newTotal: 80, committed: true }

        await run()
        await vi.waitFor(() => expect(reported).toHaveLength(2))

        expect(reported.map(r => r.evidence)).toEqual([
            'store_answered',
            'total_dropped',
        ])
    })

    it('a page with nothing in the total is not a use of the remembered box', async () => {
        remember(LEARNED_BARE)
        // The total reads $0.00 (an empty order, or not the cart at all), and
        // the box is not on this page: nothing was tried, nothing counts.
        document.body.innerHTML =
            '<div class="row"><span>Total</span><span>$0.00</span></div>'

        await run()
        await new Promise(r => setTimeout(r, 20))

        expect(appliedWith).toHaveLength(0)
        expect(learned()?.failures).toBe(0)
        expect(reported).toEqual([])
    })

    it('one that no longer fits the page is a failed use, and detection goes on', async () => {
        remember({ ...LEARNED_BARE, input: 'input[name="gone"]' })
        document.body.innerHTML = RULES_BOX + TOTAL

        await run()

        expect(drivenInput()).toBe('dc')
        await vi.waitFor(() => expect(learned()?.failures).toBe(1))
        // Only this install's memory: not news for anyone else.
        expect(reported).toEqual([])
    })

    it('llm_only never uses a box the rules once found', async () => {
        mode = 'llm_only'
        remember({ ...LEARNED_BARE, source: 'rules' })
        document.body.innerHTML = BARE_BOX + TOTAL

        await run()

        expect(pickCalls).toHaveLength(1)
        expect(appliedWith).toHaveLength(0)
    })

    it('a server answer naming a learned box by selectors (under box) is used and saved as learned', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL
        answer = {
            outcome: 'box',
            source: 'learned',
            input: null,
            button: null,
            toggle: null,
            box: {
                input: 'input[name="field_7"]',
                apply: 'button#go',
                toggle: null,
                enterOnly: false,
            },
        }
        applyResult = { success: true, newTotal: 80, committed: true }

        await run()
        await settle()

        expect(drivenInput()).toBe('x')
        expect(learned()?.source).toBe('server_learned')
        await vi.waitFor(() => expect(reported).toHaveLength(1))
        expect(reported[0]).toMatchObject({
            source: 'server_learned',
            outcome: 'confirmed',
        })
    })

    it('a server learned box whose selector fits two elements is not used', async () => {
        document.body.innerHTML = BARE_BOX + BARE_BOX + TOTAL
        answer = {
            outcome: 'box',
            source: 'learned',
            input: null,
            button: null,
            toggle: null,
            box: {
                input: 'input[name="field_7"]',
                apply: null,
                toggle: null,
                enterOnly: true,
            },
        }

        await run()

        expect(appliedWith).toHaveLength(0)
    })

    it('llm_first: a server learned box that finds nothing here is a no-pick, and the rules go on', async () => {
        mode = 'llm_first'
        document.body.innerHTML = RULES_BOX + TOTAL
        answer = {
            outcome: 'box',
            source: 'learned',
            input: null,
            button: null,
            toggle: null,
            box: {
                input: 'input[name="gone"]',
                apply: 'button#gone',
                toggle: null,
                enterOnly: false,
            },
        }

        await run()

        expect(pickCalls).toHaveLength(1)
        expect(drivenInput()).toBe('dc')
        // Nothing was typed into it: that says nothing about the store.
        await new Promise(r => setTimeout(r, 20))
        expect(reported.filter(r => r.outcome === 'failed')).toEqual([])
    })

    it('with the finder off nothing is read or saved', async () => {
        flagOn = false
        remember(LEARNED_BARE)
        document.body.innerHTML = RULES_BOX + TOTAL
        applyResult = { success: true, newTotal: 80, committed: true }

        await run()
        await new Promise(r => setTimeout(r, 20))

        expect(appliedWith).toHaveLength(0)
        expect(localReads).not.toContain(LEARNED_KEY)
        expect(reported).toEqual([])
    })
})
