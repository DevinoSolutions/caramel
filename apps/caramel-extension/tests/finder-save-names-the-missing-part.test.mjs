import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoveredRecord,
} from '../coupon-box-discovery.js'
import {
    NO_CONFIG,
    PROMO_BOX,
    TOTAL,
    handoffs,
    installChromeStub,
    registerFinder,
    sent,
    setPath,
    stubLayout,
} from './_found-box-harness.mjs'

// A box the finder found but cannot save says WHICH part has no stable name.
// pureformulas.com, measured live 2026-10-22: the input (input#couponCode) and
// the apply button (button[aria-label="Apply coupon code"]) were named, and
// the order total was a bare <div class="col-4 text-end"> in a row of styling
// classes. The log said only FINDER_SAVE_NO_NAME {}, and the cause was first
// guessed as the aria-label button.

let logCalls

vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        log: (...args) => logCalls.push(args),
    }
})

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
    document.body.innerHTML = ''
    setPath('/cart')
    logCalls = []
    _caramelResetDiscoveryFlag()
})

// The pureformulas.com summary rows, trimmed: no id, name, test id or js- hook
// class on the total or anywhere above it.
const UNNAMED_TOTAL =
    '<div class="panel p-3"><div class="row align-items-center gx-1 fw-bold fs-18">' +
    '<div class="col-8">Total</div><div class="col-4 text-end">$27.00</div></div></div>'
const UNNAMED_APPLY_BOX =
    '<div class="promo"><label for="dc">Discount code</label>' +
    '<input id="dc" name="discount_code" type="text" placeholder="Enter code">' +
    '<button type="button">Apply</button></div>'

const saveLogs = () => logCalls.filter(l => l[0].startsWith('FINDER_SAVE_'))

describe('a found box that cannot be saved names the part that has no name', () => {
    it('a named box with a named total is saved and logs no refusal', async () => {
        document.body.innerHTML = PROMO_BOX + TOTAL
        const rec = await caramelDiscoveredRecord(NO_CONFIG)
        expect(rec?.caramelFound).toBe(true)
        expect(rec.caramelSave).toEqual({
            input: 'input#dc',
            apply: 'button#ap',
            toggle: null,
            total: 'span#tot',
        })
        expect(saveLogs()).toEqual([])
    })

    it('an unnamed order total is named as the missing part', async () => {
        document.body.innerHTML = PROMO_BOX + UNNAMED_TOTAL
        const rec = await caramelDiscoveredRecord(NO_CONFIG)
        expect(rec?.caramelFound).toBe(true)
        expect(rec.caramelSave).toBeUndefined()
        expect(saveLogs()).toEqual([
            ['FINDER_SAVE_NO_NAME', { missing: ['total'], risky: [] }],
        ])
    })

    it('an unnamed apply button is named, beside the unnamed total', async () => {
        document.body.innerHTML = UNNAMED_APPLY_BOX + UNNAMED_TOTAL
        const rec = await caramelDiscoveredRecord(NO_CONFIG)
        expect(rec?.caramelFound).toBe(true)
        expect(rec.caramelSave).toBeUndefined()
        expect(saveLogs()).toEqual([
            ['FINDER_SAVE_NO_NAME', { missing: ['apply', 'total'], risky: [] }],
        ])
    })
})
