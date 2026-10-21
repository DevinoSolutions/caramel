import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { _caramelResetDiscoveryFlag } from '../coupon-box-discovery.js'
import { _caramelResetFinderLoad } from '../coupon-box-finder-loader.js'
import { startApplyingCoupons } from '../coupon-runner.js'
import {
    _caramelResetCachedCodes,
    getDomainRecord,
    tryInitialize,
} from '../store-detect.js'
import { FINDER_ASSET, FINDER_FILE } from './_finder-asset.mjs'

// The promo-box finder and the server's pick are switched by two server flags,
// couponBoxDiscovery and couponBoxLlm. Both exist for stores we have NO usable
// config for. A store whose served config describes a box the shopper can
// reach must not notice them at all: same prompt, same messages to the
// background, same codes typed in the same order, same clicks, same verdict,
// same saving recorded. These tests run the real detection and the real apply
// flow (store-detect.js, coupon-runner.js, coupon-apply.js) four times per
// page, once per flag combination, and require the four recordings to be
// identical. Only the UI layer is stubbed, to record what the shopper would
// be shown.
//
// The promise holds for a configured store whose selectors match NOTHING on
// the page too: a store with a config never runs auto-detect. Its page ends
// where it always did, with the codes to copy: the finder and the pick are
// never loaded, never asked, and no box they would see is ever typed into.

const FLAG_SETS = [
    { discovery: false, llm: false },
    { discovery: true, llm: false },
    { discovery: false, llm: true },
    { discovery: true, llm: true },
]

const COUPONS = [
    {
        code: 'SAVE12',
        id: 'c1',
        discount_type: 'PERCENTAGE',
        discount_amount: 12,
    },
    {
        code: 'SECOND10',
        id: 'c2',
        discount_type: 'PERCENTAGE',
        discount_amount: 10,
    },
]

const OUTLINE_FILE = pathToFileURL(
    resolve(import.meta.dirname, '../coupon-box-outline.js'),
).href

let flags
let rec // the served config for this page
let trace

vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    // Not a platform cart: the DOM form path runs, which is where the finder
    // could ever be reached.
    probeCartJson: async () => null,
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    insertCaramelPrompt: r => {
        trace.prompts.push(r.domain)
    },
    showFinalModal: (amount, code, message, _x, list) => {
        trace.modals.push({
            amount,
            code,
            message,
            list: (list || []).map(c => c.code),
        })
    },
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: entry => {
            trace.savings.push({ code: entry.code, amount: entry.amount })
        },
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
        stub.storage[area].remove = (_keys, cb) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    // The outline builder and the finder are loaded from the extension's own
    // URL; map them onto their source files so a page that does load them
    // really runs them.
    stub.runtime.getURL = path => {
        trace.urls.push(path)
        if (path === 'assets/coupon-box-outline.js') return OUTLINE_FILE
        if (path === FINDER_ASSET) return FINDER_FILE
        return 'chrome-extension://caramel/' + path
    }
    stub.runtime.sendMessage = (message, cb) => {
        const { action, ...rest } = message || {}
        // The flag questions are recorded too: on a reachable configured box
        // they must not even be asked.
        // A handoff record carries the wall-clock time it was written (the
        // run's start): when a run started is not something a flag may
        // change, so it is not compared.
        const value =
            rest.value && typeof rest.value.t === 'number'
                ? { ...rest.value, t: '<time>' }
                : rest.value
        trace.messages.push(
            'value' in rest ? { action, ...rest, value } : { action, ...rest },
        )
        let reply = {}
        if (action === 'fetchSupportedStores') reply = { supported: [rec] }
        else if (action === 'fetchCoupons') reply = { coupons: COUPONS }
        else if (action === 'couponBoxDiscoveryEnabled')
            reply = { enabled: flags.discovery }
        else if (action === 'couponBoxLlmEnabled')
            reply = { enabled: flags.llm }
        else if (action === 'couponBoxPick')
            reply = { outcome: 'no_box', confidence: 80, why: 'none' }
        if (typeof cb === 'function') cb(reply)
        return undefined
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
}

// jsdom has no layout: hidden = display:none on the element or an ancestor
// (or a closed <details> around it), everything else a 120x30 box.
function stubLayout() {
    const hidden = el => {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            if (n.hidden || n.style?.display === 'none') return true
            if (
                n.parentElement?.tagName === 'DETAILS' &&
                !n.parentElement.open &&
                n.tagName !== 'SUMMARY'
            )
                return true
        }
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

// A real served config shape (naturepedic.com, tests/fixtures), with the
// domain set to the page's own host so the lookup finds it.
const MAGENTO = () => ({
    domain: location.hostname,
    couponInput: '#coupon_code',
    couponSubmit:
        'button[data-action="apply-coupon"], #discount-coupon-form button.action.apply',
    couponRemove:
        'button[data-action="cancel-coupon"], #discount-coupon-form button.action.cancel',
    priceContainer: '.grand.totals .price, tr.grand.totals .price',
    showInput: '#block-discount-heading, .title[data-role="title"]',
    successIndicator:
        'button[data-action="cancel-coupon"], #discount-coupon-form button.action.cancel',
    errorIndicator: '.message-error, div.message.error div',
})

const FORM = (formStyle = '') => `
<div class="grand totals"><span class="price">$<span id="total-num">120.00</span></span></div>
<div class="discount">
  <div id="block-discount-heading" role="button">Apply Promo Code</div>
  <form id="discount-coupon-form" style="${formStyle}">
    <input type="text" id="coupon_code" name="coupon_code" placeholder="Enter code"/>
    <button type="button" data-action="apply-coupon">Apply Discount</button>
    <div class="message-error" style="display:none"></div>
    <div id="applied-slot"></div>
  </form>
</div>
<button id="place-order" type="button">Place Order</button>`

// The store's own behaviour, wired after the markup lands (innerHTML never
// runs scripts). `answer` is 'win' (the first code takes $12 off) or
// 'reject' (every code refused in the store's words).
function wireStore(answer) {
    const form = document.getElementById('discount-coupon-form')
    document
        .getElementById('block-discount-heading')
        ?.addEventListener('click', () => {
            trace.page.push('toggle')
            form.style.display = ''
        })
    document.getElementById('place-order').addEventListener('click', () => {
        trace.page.push('ORDER')
    })
    document
        .querySelector('[data-action="apply-coupon"]')
        .addEventListener('click', () => {
            const code = document.getElementById('coupon_code').value
            trace.page.push('apply:' + code)
            if (answer === 'win' && code === 'SAVE12') {
                setTimeout(() => {
                    document.getElementById('total-num').textContent = '108.00'
                    document.getElementById('applied-slot').innerHTML =
                        '<button type="button" data-action="cancel-coupon">Cancel Coupon</button>'
                }, 5)
                return
            }
            setTimeout(() => {
                const err = document.querySelector('.message-error')
                err.textContent = `The coupon code "${code}" is not valid.`
                err.style.display = ''
            }, 5)
        })
}

async function shopperVisits({ html, answer, config, details = false }) {
    trace = {
        messages: [],
        prompts: [],
        modals: [],
        savings: [],
        page: [],
        urls: [],
        found: 0,
    }
    getDomainRecord.cache = null
    _caramelResetCachedCodes()
    _caramelResetDiscoveryFlag()
    _caramelResetFinderLoad()
    sessionStorage.clear()
    window.history.replaceState({}, '', '/checkout/cart/')
    rec = config
    document.body.innerHTML = details
        ? `<details id="d"><summary>Have a promo code?</summary>${html}</details>`
        : html
    wireStore(answer)

    await tryInitialize()
    if (trace.prompts.length)
        await startApplyingCoupons(await getDomainRecord(location.hostname))
    trace.found = document.querySelectorAll('[data-caramel-found]').length
    return trace
}

async function underEveryFlagSet(visit) {
    const runs = []
    for (const f of FLAG_SETS) {
        flags = f
        runs.push(await visit())
    }
    return runs
}

const asked = (t, action) => t.messages.filter(m => m.action === action)

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
})

beforeEach(() => {
    flags = FLAG_SETS[0]
})

describe('a configured store whose box the shopper can reach', () => {
    const PAGES = {
        'box in plain view, the first code works': {
            html: FORM(),
            answer: 'win',
            config: MAGENTO,
        },
        'box in plain view, the store refuses every code': {
            html: FORM(),
            answer: 'reject',
            config: MAGENTO,
        },
        "box folded behind the config's own toggle": {
            html: FORM('display:none'),
            answer: 'win',
            config: MAGENTO,
        },
        // Labels the finder and the pick refuse to click (a reveal named
        // only for offers, an apply button that names points). A configured
        // store's own selectors are clicked as written.
        'offers reveal and a "Redeem points" apply button, named by the config':
            {
                html: FORM('display:none')
                    .replace('Apply Promo Code', 'View offers')
                    .replace('Apply Discount', 'Redeem points'),
                answer: 'win',
                config: MAGENTO,
            },
        'box behind a closed <details> the config never named': {
            html: FORM(),
            answer: 'win',
            config: () => ({ ...MAGENTO(), showInput: undefined }),
            details: true,
        },
    }

    for (const [name, page] of Object.entries(PAGES))
        it(`${name}: identical under every flag combination`, async () => {
            const runs = await underEveryFlagSet(() =>
                shopperVisits({ ...page, config: page.config() }),
            )
            const [off] = runs
            // The page really was exercised: a prompt, codes typed, a verdict.
            expect(off.prompts).toHaveLength(1)
            expect(off.page.some(e => e.startsWith('apply:'))).toBe(true)
            expect(off.modals).toHaveLength(1)
            expect(off.page).not.toContain('ORDER')
            for (const run of runs) {
                expect(run).toEqual(off)
                // Not merely the same outcome: the flags were never asked,
                // neither the finder nor the outline was loaded, nothing was
                // marked as found.
                expect(asked(run, 'couponBoxDiscoveryEnabled')).toEqual([])
                expect(asked(run, 'couponBoxLlmEnabled')).toEqual([])
                expect(asked(run, 'couponBoxPick')).toEqual([])
                expect(run.urls).not.toContain(FINDER_ASSET)
                expect(run.urls).not.toContain('assets/coupon-box-outline.js')
                expect(run.found).toBe(0)
            }
        })

    it('a configured reveal and apply button the finder would refuse are still clicked, under every flag combination', async () => {
        const html = FORM('display:none')
            .replace('Apply Promo Code', 'View offers')
            .replace('Apply Discount', 'Redeem points')
        for (const f of FLAG_SETS) {
            flags = f
            const run = await shopperVisits({
                html,
                answer: 'win',
                config: MAGENTO(),
            })
            expect(run.page.slice(0, 2)).toEqual(['toggle', 'apply:SAVE12'])
            expect(run.savings).toEqual([{ code: 'SAVE12', amount: 12 }])
        }
    })

    it('the money is the same too: one $12 saving when the code worked, none when refused', async () => {
        for (const f of FLAG_SETS) {
            flags = f
            const won = await shopperVisits({
                html: FORM(),
                answer: 'win',
                config: MAGENTO(),
            })
            expect(won.savings).toEqual([{ code: 'SAVE12', amount: 12 }])
            const refused = await shopperVisits({
                html: FORM(),
                answer: 'reject',
                config: MAGENTO(),
            })
            expect(refused.savings).toEqual([])
        }
    })
})

describe('a configured store whose selectors match nothing: the codes to copy, under every flag combination', () => {
    // A stale config: the store renamed its field. The flags change nothing
    // here either: a store with a config never runs auto-detect.
    const STALE = () => ({
        ...MAGENTO(),
        couponInput: '#old_coupon_field',
        showInput: '#old_toggle',
    })
    // A box the finder's rules would take, and the server's pick a box too.
    const BARE = `
<div class="row"><span>Total</span><span>$120.00</span></div>
<div class="promo"><label for="dc">Discount code</label>
  <input id="dc" name="discount_code" type="text">
  <button id="ap" type="button">Apply</button></div>`

    for (const f of FLAG_SETS)
        it(`discovery ${f.discovery ? 'on' : 'off'}, pick ${f.llm ? 'on' : 'off'}: nothing asked, nothing loaded, nothing typed`, async () => {
            flags = f
            document.body.innerHTML = BARE
            const typed = []
            document
                .getElementById('ap')
                .addEventListener('click', () =>
                    typed.push(document.getElementById('dc').value),
                )
            rec = STALE()
            trace = {
                messages: [],
                prompts: [],
                modals: [],
                savings: [],
                page: [],
                urls: [],
            }
            // The list was read: this record is its row for this store.
            getDomainRecord.cache = [rec]
            _caramelResetDiscoveryFlag()
            _caramelResetFinderLoad()
            sessionStorage.clear()
            await startApplyingCoupons(rec)
            expect(asked(trace, 'couponBoxDiscoveryEnabled')).toEqual([])
            expect(asked(trace, 'couponBoxLlmEnabled')).toEqual([])
            expect(asked(trace, 'couponBoxPick')).toEqual([])
            expect(trace.urls).not.toContain(FINDER_ASSET)
            expect(trace.urls).not.toContain('assets/coupon-box-outline.js')
            expect(typed).toEqual([])
            expect(document.querySelector('[data-caramel-found]')).toBeNull()
            expect(trace.savings).toEqual([])
            expect(trace.modals.at(-1).message).toMatch(
                /couldn't find the promo box/,
            )
        })

    // Detection: the prompt's own question (isCheckout) never asks the
    // finder for a configured store either.
    for (const f of FLAG_SETS)
        it(`detection, discovery ${f.discovery ? 'on' : 'off'}, pick ${f.llm ? 'on' : 'off'}: the finder is never asked whether to offer`, async () => {
            flags = f
            trace = {
                messages: [],
                prompts: [],
                modals: [],
                savings: [],
                page: [],
                urls: [],
            }
            getDomainRecord.cache = null
            _caramelResetCachedCodes()
            _caramelResetDiscoveryFlag()
            _caramelResetFinderLoad()
            sessionStorage.clear()
            window.history.replaceState({}, '', '/checkout/cart/')
            rec = STALE()
            document.body.innerHTML = BARE

            await tryInitialize()

            expect(asked(trace, 'couponBoxDiscoveryEnabled')).toEqual([])
            expect(asked(trace, 'couponBoxPick')).toEqual([])
            expect(trace.urls).not.toContain(FINDER_ASSET)
            expect(trace.prompts).toEqual([])
        }, 20000)
})

describe('a stale config with the finder on: the config is tried, the finder never', () => {
    // The store renamed its promo field; the config still names the old one
    // and still names a toggle that exists. The config's own selectors are
    // tried, as they always were, and then the page ends with the codes to
    // copy: the box the finder would see is never typed into.
    const STALE_WITH_TOGGLE = () => ({
        ...MAGENTO(),
        couponInput: '#old_coupon_field',
        showInput: '#old_toggle',
    })
    const PAGE = `
<div class="grand totals"><span>Total</span><span class="price">$<span id="total-num">120.00</span></span></div>
<div id="old_toggle" role="button">Apply Promo Code</div>
<div class="promo"><label for="dc">Discount code</label>
  <input id="dc" name="discount_code" type="text">
  <button id="ap" type="button">Apply</button></div>
<button id="place-order" type="button">Place Order</button>`

    let seq
    let realQsa
    beforeEach(() => {
        seq = []
        realQsa = Document.prototype.querySelectorAll
        Document.prototype.querySelectorAll = function (sel) {
            if (String(sel).includes('#old_coupon_field'))
                seq.push('config-box-lookup')
            return realQsa.call(this, sel)
        }
    })
    afterEach(() => {
        Document.prototype.querySelectorAll = realQsa
    })

    async function visit() {
        flags = FLAG_SETS[3]
        trace = {
            messages: [],
            prompts: [],
            modals: [],
            savings: [],
            page: [],
            urls: [],
        }
        getDomainRecord.cache = [STALE_WITH_TOGGLE()]
        _caramelResetCachedCodes()
        _caramelResetDiscoveryFlag()
        _caramelResetFinderLoad()
        sessionStorage.clear()
        window.history.replaceState({}, '', '/checkout/cart/')
        document.body.innerHTML = PAGE
        rec = STALE_WITH_TOGGLE()
        document.getElementById('old_toggle').addEventListener('click', () => {
            seq.push('config-toggle-clicked')
        })
        document.getElementById('place-order').addEventListener('click', () => {
            trace.page.push('ORDER')
        })
        document.getElementById('ap').addEventListener('click', () => {
            trace.page.push('apply:' + document.getElementById('dc').value)
        })
        const send = chrome.runtime.sendMessage
        chrome.runtime.sendMessage = (message, cb) => {
            if (message?.action === 'couponBoxDiscoveryEnabled')
                seq.push('finder-asked')
            if (message?.action === 'couponBoxPick') seq.push('pick-asked')
            return send(message, cb)
        }
        try {
            await startApplyingCoupons(rec)
        } finally {
            chrome.runtime.sendMessage = send
        }
        return trace
    }

    it("the config's box and toggle are tried; the finder and the pick are never asked or loaded", async () => {
        const run = await visit()
        expect(seq[0]).toBe('config-box-lookup')
        expect(seq).toContain('config-toggle-clicked')
        expect(seq).not.toContain('finder-asked')
        expect(seq).not.toContain('pick-asked')
        expect(run.urls).not.toContain(FINDER_ASSET)
        expect(run.urls).not.toContain('assets/coupon-box-outline.js')
    }, 20000)

    it('the box the finder would see is never typed into: no saving, nothing reported as worked, the codes to copy', async () => {
        const run = await visit()
        expect(run.page).toEqual([])
        expect(document.querySelector('[data-caramel-found]')).toBeNull()
        expect(run.savings).toEqual([])
        expect(
            asked(run, 'reportOutcome').filter(m => m.outcome === 'worked'),
        ).toEqual([])
        expect(run.modals.at(-1).message).toMatch(/couldn't find the promo box/)
    }, 20000)
})
