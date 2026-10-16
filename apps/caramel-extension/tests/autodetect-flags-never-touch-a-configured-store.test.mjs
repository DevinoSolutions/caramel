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
import { startApplyingCoupons } from '../coupon-runner.js'
import {
    _caramelResetCachedCodes,
    getDomainRecord,
    tryInitialize,
} from '../store-detect.js'

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
// They also pin where that promise ends today, so it is a decision rather
// than a surprise: a configured store whose selectors match NOTHING on the
// page falls through to the finder (that is the finder's second purpose, see
// coupon-runner.js "No config describes a box we can see"), and with the pick
// flag on that page asks the server too.

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
    // The outline builder is loaded from the extension's own URL; map it onto
    // the source file so a page that does ask really sends its outline.
    stub.runtime.getURL = path => {
        trace.urls.push(path)
        return path === 'assets/coupon-box-outline.js'
            ? OUTLINE_FILE
            : 'chrome-extension://caramel/' + path
    }
    stub.runtime.sendMessage = (message, cb) => {
        const { action, ...rest } = message || {}
        // The flag questions are recorded too: on a reachable configured box
        // they must not even be asked.
        trace.messages.push({ action, ...rest })
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
                // no outline was loaded, nothing was marked as found.
                expect(asked(run, 'couponBoxDiscoveryEnabled')).toEqual([])
                expect(asked(run, 'couponBoxLlmEnabled')).toEqual([])
                expect(asked(run, 'couponBoxPick')).toEqual([])
                expect(run.urls).not.toContain('assets/coupon-box-outline.js')
                expect(run.found).toBe(0)
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

describe('where the promise ends today: a configured store whose selectors match nothing', () => {
    // A stale config: the store renamed its field. The flags DO change what
    // happens here, by design (the finder exists to rescue exactly this).
    const STALE = () => ({
        ...MAGENTO(),
        couponInput: '#old_coupon_field',
        showInput: '#old_toggle',
    })
    const BARE = `
<div class="row"><span>Total</span><span>$120.00</span></div>
<div class="f"><input id="x" name="field_7" type="text"><button id="go" type="button">Go</button></div>`

    it('flags off: the codes are handed over to copy, and nothing is asked', async () => {
        flags = FLAG_SETS[0]
        document.body.innerHTML = BARE
        rec = STALE()
        trace = {
            messages: [],
            prompts: [],
            modals: [],
            savings: [],
            page: [],
            urls: [],
        }
        getDomainRecord.cache = null
        _caramelResetDiscoveryFlag()
        sessionStorage.clear()
        await startApplyingCoupons(rec)
        expect(asked(trace, 'couponBoxPick')).toEqual([])
        expect(trace.urls).not.toContain('assets/coupon-box-outline.js')
        expect(trace.modals.at(-1).message).toMatch(
            /couldn't find the promo box/,
        )
    })

    it('both flags on: the server IS asked for this configured store (documented behaviour, not an accident)', async () => {
        flags = FLAG_SETS[3]
        document.body.innerHTML = BARE
        rec = STALE()
        trace = {
            messages: [],
            prompts: [],
            modals: [],
            savings: [],
            page: [],
            urls: [],
        }
        getDomainRecord.cache = null
        _caramelResetDiscoveryFlag()
        sessionStorage.clear()
        await startApplyingCoupons(rec)
        expect(asked(trace, 'couponBoxPick')).toHaveLength(1)
        // A "no box" answer still ends exactly where flags-off did.
        expect(trace.modals.at(-1).message).toMatch(
            /couldn't find the promo box/,
        )
        expect(trace.savings).toEqual([])
    })
})

describe('a stale config with the finder on: deliberate behaviour, pinned', () => {
    // The store renamed its promo field; the config still names the old one
    // and still names a toggle that exists. With the finder on, this page is
    // allowed to fall through to it. Three things make that safe, and each is
    // pinned here: the config's own selectors are always tried first, the
    // finder starts only after they are proven to give no usable box, and a
    // saving is recorded only when the total really drops.
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

    // `answer`: 'drop' takes $12 off for SAVE12; 'says-yes' prints an
    // accepted message for every code and the total never moves.
    async function visit(answer) {
        flags = FLAG_SETS[3]
        trace = {
            messages: [],
            prompts: [],
            modals: [],
            savings: [],
            page: [],
            urls: [],
        }
        getDomainRecord.cache = []
        _caramelResetCachedCodes()
        _caramelResetDiscoveryFlag()
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
        const btn = document.getElementById('ap')
        btn.addEventListener('click', () => {
            const code = document.getElementById('dc').value
            trace.page.push('apply:' + code)
            setTimeout(() => {
                const msg = document.createElement('div')
                msg.className = 'note'
                if (answer === 'drop' && code === 'SAVE12') {
                    document.getElementById('total-num').textContent = '108.00'
                    msg.textContent = 'Discount applied'
                } else {
                    msg.textContent = `Coupon ${code} applied!`
                }
                btn.parentElement.appendChild(msg)
            }, 5)
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

    it("(a) + (b): the config's box and toggle are tried, and proven useless, before the finder is asked", async () => {
        const run = await visit('drop')
        const finderAt = seq.indexOf('finder-asked')
        expect(finderAt).toBeGreaterThan(-1)
        const before = seq.slice(0, finderAt)
        // Looked up, toggle clicked, looked up again after the toggle: all of
        // it before the finder's flag is even asked.
        expect(before[0]).toBe('config-box-lookup')
        expect(before).toContain('config-toggle-clicked')
        expect(before.lastIndexOf('config-box-lookup')).toBeGreaterThan(
            before.indexOf('config-toggle-clicked'),
        )
        // The finder ran here, on the box the rules see, and the code the
        // store took is the one recorded.
        expect(run.page).toContain('apply:SAVE12')
        expect(run.page).not.toContain('ORDER')
    }, 20000)

    it('(c) the total really drops: one $12 saving, reported as worked once', async () => {
        const run = await visit('drop')
        expect(run.savings).toEqual([{ code: 'SAVE12', amount: 12 }])
        expect(
            asked(run, 'reportOutcome').filter(m => m.outcome === 'worked'),
        ).toHaveLength(1)
    }, 20000)

    it('(c) the store SAYS "applied" but the total never moves: no saving, nothing reported as worked', async () => {
        const run = await visit('says-yes')
        expect(
            asked(run, 'reportOutcome').filter(m => m.outcome === 'worked'),
        ).toEqual([])
        expect(run.savings).toEqual([])
        expect(run.modals.at(-1).amount).toBe(0)
        // Both codes were really tried in the box the finder found.
        expect(run.page.filter(e => e.startsWith('apply:'))).toEqual([
            'apply:SAVE12',
            'apply:SECOND10',
        ])
    }, 60000)
})
