import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { _caramelResetDiscoveryFlag } from '../coupon-box-discovery.js'
import { LEARNED_KEY } from '../coupon-box-learned.js'
import { caramelBeginRun, caramelMarkPendingSubmit } from '../dom-utils.js'
import {
    _caramelResetCachedCodes,
    getDomainRecord,
    startCheckoutDetection,
} from '../store-detect.js'
import { LEARNED_ACTIONS, learnedBackground } from './_learned-background.mjs'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'
// The background's side of the per-tab handoffs (see the helper).
const handoffs = tabHandoffBackground()

// A remembered coupon box on a cart that reloads per code. The box no rule
// would find is still the one the run carries on with on the page the store
// sent us to, and a code that drops the total there confirms it: the box is
// remembered and reported with the total drop as its evidence.

const LEARNED_FILE = pathToFileURL(
    resolve(import.meta.dirname, '../coupon-box-learned.js'),
).href

let applyCalls
// The background's per-tab hold of the box a run used.
let holds = new Map()
let reported
let local

vi.mock('../coupon-runner.js', async importOriginal => ({
    ...(await importOriginal()),
    startApplyingCoupons: (...args) => applyCalls.push(args),
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: () => {},
    }
})
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showFinalModal: () => {},
    insertCaramelPrompt: () => {},
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
}))

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
            : 'chrome-extension://caramel/' + path
    stub.runtime.sendMessage = (message, cb) => {
        if (handoffs.answers(message, cb)) return
        const a = message?.action
        if (a === 'fetchCoupons')
            cb({
                coupons: [
                    { code: 'DEAD5', id: 'c1' },
                    { code: 'SAVE10', id: 'c2' },
                ],
            })
        else if (a === 'couponBoxDiscoveryEnabled') cb({ enabled: true })
        else if (a === 'couponBoxLlmEnabled')
            cb({ enabled: true, mode: 'llm_first' })
        else if (LEARNED_ACTIONS.includes(a))
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

// A box no rule recognises: only the remembered selectors find it.
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
const TOTAL = amount =>
    `<div class="row"><span>Order total</span> <span>$${amount}</span></div>`
const ROW = { kind: 'total', label: 'order total', rows: 1 }
const REMEMBERED = {
    v: 1,
    input: 'input[name="field_7"]',
    apply: 'button#go',
    toggle: null,
    enterOnly: false,
    source: 'llm',
    confirmedAt: 1,
    failures: 1,
}

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    Object.defineProperty(globalThis.HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() {
            return this.textContent
        },
    })
})

beforeEach(async () => {
    sessionStorage.clear()
    handoffs.reset()
    history.replaceState({}, '', '/cart')
    applyCalls = []
    reported = []
    holds = new Map()
    local = {}
    Element.prototype.checkVisibility = () => true
    Element.prototype.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 120,
        bottom: 30,
        width: 120,
        height: 30,
    })
    getDomainRecord.cache = []
    _caramelResetCachedCodes()
    _caramelResetDiscoveryFlag()
    // The server has already been asked on this tab: only the memory could
    // still see a box here.
    await handoffs.put('box_pick', { [location.hostname]: 1 })
})

describe('a remembered box on a cart that reloads per code', () => {
    it('carries the run on where only the remembered box is on the page', async () => {
        local[LEARNED_KEY] = { [location.hostname]: REMEMBERED }
        document.body.innerHTML = BARE_BOX + TOTAL('100.00')
        caramelBeginRun()
        caramelMarkPendingSubmit('DEAD5', 'c1', [100], ROW)

        await startCheckoutDetection()

        expect(applyCalls).toHaveLength(1)
        expect(applyCalls[0][1]).toEqual({ resumed: true })
    })

    it('stops on the same page with nothing remembered', async () => {
        document.body.innerHTML = BARE_BOX + TOTAL('100.00')
        caramelBeginRun()
        caramelMarkPendingSubmit('DEAD5', 'c1', [100], ROW)

        await startCheckoutDetection()

        expect(applyCalls).toEqual([])
    })

    it('a code that dropped the total across the reload confirms the box it went through', async () => {
        // What the run's find left for the page the store sends us to.
        holds.set(location.hostname, {
            domain: location.hostname,
            box: {
                input: REMEMBERED.input,
                apply: REMEMBERED.apply,
                toggle: null,
                enterOnly: false,
            },
            source: 'llm',
            learned: true,
        })
        local[LEARNED_KEY] = { [location.hostname]: REMEMBERED }
        document.body.innerHTML = BARE_BOX + TOTAL('90.00')
        caramelBeginRun()
        caramelMarkPendingSubmit('SAVE10', 'c2', [100], ROW)

        await startCheckoutDetection()

        await vi.waitFor(() => expect(reported).toHaveLength(1))
        expect(reported[0]).toMatchObject({
            source: 'llm',
            evidence: 'total_dropped',
            outcome: 'confirmed',
        })
        expect(local[LEARNED_KEY][location.hostname]).toMatchObject({
            input: REMEMBERED.input,
            failures: 0,
        })
        expect(holds.has(location.hostname)).toBe(false)
    })

    it('a box the page wrote into its own storage confirms nothing', async () => {
        // The page's sessionStorage is the page's to write: a box planted
        // there, for this store or another, is never taken as the run's.
        for (const domain of [location.hostname, 'victim.test'])
            sessionStorage.setItem(
                'caramel_box_learn:' + domain,
                JSON.stringify({
                    domain,
                    box: {
                        input: REMEMBERED.input,
                        apply: REMEMBERED.apply,
                        toggle: null,
                        enterOnly: false,
                    },
                    source: 'llm',
                    learned: true,
                }),
            )
        local[LEARNED_KEY] = { [location.hostname]: REMEMBERED }
        document.body.innerHTML = BARE_BOX + TOTAL('90.00')
        caramelBeginRun()
        caramelMarkPendingSubmit('SAVE10', 'c2', [100], ROW)

        await startCheckoutDetection()
        await new Promise(r => setTimeout(r, 20))

        expect(reported).toEqual([])
        expect(local[LEARNED_KEY]).toEqual({
            [location.hostname]: REMEMBERED,
        })
    })

    it('a reload where the total did not move confirms nothing', async () => {
        holds.set(location.hostname, {
            domain: location.hostname,
            box: { input: REMEMBERED.input, apply: REMEMBERED.apply },
            source: 'llm',
            learned: true,
        })
        local[LEARNED_KEY] = { [location.hostname]: REMEMBERED }
        document.body.innerHTML = BARE_BOX + TOTAL('100.00')
        caramelBeginRun()
        caramelMarkPendingSubmit('DEAD5', 'c1', [100], ROW)

        await startCheckoutDetection()
        await new Promise(r => setTimeout(r, 20))

        expect(reported).toEqual([])
        expect(local[LEARNED_KEY][location.hostname].failures).toBe(1)
    })
})
