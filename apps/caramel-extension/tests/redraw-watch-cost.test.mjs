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
import { applyCoupon } from '../coupon-apply.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoveredRecord,
} from '../coupon-box-discovery.js'
import {
    NO_CONFIG,
    TOTAL,
    handoffs,
    installChromeStub,
    registerFinder,
    sent,
    setPath,
    stubLayout,
} from './_found-box-harness.mjs'

// What the redraw watch (coupon-apply.js _caramelWatchRedraws, T-11368) costs
// the store's page. kipling-usa.com, 2026-10-31: on the first #633 build a
// code that works took 6.6-9.4 s against 1.4.31's 5.9-6.1 s, with the watch
// on from the first code and watching every style and class change on the
// page with its old value. A code tried before any refusal now starts no
// watch at all, and once one runs, the page-wide part sees nodes and text
// only; style and class are watched on the refusal's own nodes.
//
// A file of its own: the page's earlier answers live for the module's life,
// and the first test needs a page that has refused nothing yet.

vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showFinalModal: () => {},
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
        log: () => {},
    }
})

const SLOW = 20000
const REFUSAL = 'Enter a valid discount code or gift card'
const BOX =
    '<div class="promo"><label for="dc">Discount code</label>' +
    '<input id="dc" name="discount_code" type="text">' +
    '<button id="ap" type="button">Apply</button>' +
    '<div id="msg" class="error"></div></div>'

let observed
beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
    registerFinder()
})
beforeEach(() => {
    sessionStorage.clear()
    handoffs.reset()
    sent.length = 0
    setPath('/checkout')
    _caramelResetDiscoveryFlag()
    document.body.innerHTML = BOX + TOTAL
    observed = []
    const real = MutationObserver.prototype.observe
    vi.spyOn(MutationObserver.prototype, 'observe').mockImplementation(
        function (target, options) {
            observed.push({ target, options })
            return real.call(this, target, options)
        },
    )
})
afterEach(() => vi.restoreAllMocks())

// The redraw watch's own registrations: the page-wide one is the only
// observer here asking for text changes, the refusal's nodes the only ones
// asking for old attribute values.
const pageWide = () => observed.filter(o => o.options?.characterData)
const oldAttributes = () => observed.filter(o => o.options?.attributeOldValue)

const later = (fn, ms) => setTimeout(fn, ms)
const setTotal = text => (document.getElementById('tot').textContent = text)

describe('what the redraw watch costs the page', () => {
    it(
        'a code that works, tried before any refusal, starts no watch',
        async () => {
            document
                .getElementById('ap')
                .addEventListener('click', () =>
                    later(() => setTotal('$85.00'), 300),
                )
            const rec = await caramelDiscoveredRecord(NO_CONFIG)

            const res = await applyCoupon('TREAT', rec)

            expect(res.success).toBe(true)
            expect(pageWide()).toEqual([])
            expect(oldAttributes()).toEqual([])
        },
        SLOW,
    )

    it(
        'after a refusal, the page-wide watch takes no attributes, and the refusal is watched where it stands',
        async () => {
            let clicks = 0
            document.getElementById('ap').addEventListener('click', () => {
                clicks++
                if (clicks === 1)
                    return later(
                        () =>
                            (document.getElementById('msg').textContent =
                                REFUSAL),
                        300,
                    )
                later(() => {
                    document.getElementById('msg').textContent = ''
                    setTotal('$85.00')
                }, 300)
            })
            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const first = await applyCoupon('MV15', rec)
            expect(first.errorIsNew).toBe(true)
            observed.length = 0

            const res = await applyCoupon('TREAT', rec)

            expect(res.success).toBe(true)
            expect(pageWide()).toHaveLength(1)
            expect(pageWide()[0].target).toBe(document.documentElement)
            expect(pageWide()[0].options.attributes).toBeFalsy()
            const msg = document.getElementById('msg')
            const watched = oldAttributes().map(o => o.target)
            expect(watched).toContain(msg)
            for (const el of watched) expect(el.contains(msg)).toBe(true)
            expect(watched).not.toContain(document.body)
            expect(watched).not.toContain(document.documentElement)
        },
        SLOW,
    )
})
