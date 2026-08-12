import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { caramelPostNavigationVerdict } from '../coupon-apply.js'
import { caramelMarkPendingSubmit } from '../dom-utils.js'
import {
    _caramelResetCachedCodes,
    getDomainRecord,
    startCheckoutDetection,
} from '../store-detect.js'

// When the store already answered, stop asking the shopper to go and find out.
//
// motoin.de (QA sweep 2026-08-06) is a classic form-POST cart: submitting a
// promo code is a full page load, which takes the content script with it. We
// come back, cannot compare against a before-state we no longer have, and said
// “We submitted SALE20 just before the page reloaded — check your order summary
// to see whether it applied.” One inch above that sentence the store was
// printing “Dieser Gutschein ist abgelaufen”. The code had expired; the merchant
// had said so; we sent the shopper off to work it out for themselves.
//
// Attribution can't be done by comparison here — there is no earlier state of
// this document — so it is done by content, on evidence a static label cannot
// produce: the text NAMES the code we submitted, or it speaks in the vocabulary
// of a rejection. Everything else stays unquoted, exactly as in
// tests/store-said-attribution.test.mjs.

// Collaborators the old suite replaced by assigning over a global are replaced
// through module mocks now. `getDomainRecord` and `getCachedCodes` are the
// exception: both live in store-detect.js and are called from inside
// store-detect.js, so no mock can stand in front of them — they are driven
// through their own seams instead (the store-list cache the source itself
// maintains, and the coupon fetch getCachedCodes delegates to).
const stubs = vi.hoisted(() => ({
    coupons: [],
    finalModalCalls: [],
}))

vi.mock('../caramel-base.js', async importOriginal => ({
    ...(await importOriginal()),
    sleep: async () => {},
    caramelRecordSaving: () => {},
}))
vi.mock('../coupon-fetch.js', async importOriginal => ({
    ...(await importOriginal()),
    fetchCoupons: async () => stubs.coupons,
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    insertCaramelPrompt: () => {},
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    showFinalModal: (...args) => stubs.finalModalCalls.push(args),
}))

let finalModalCalls

const REC = {
    domain: 'motoin.de',
    couponInput: '#promo',
    priceContainer: '#total',
    errorIndicator: '.alert',
}

function setTotalText(text) {
    let el = document.getElementById('total')
    if (!el) {
        el = document.createElement('div')
        el.id = 'total'
        document.body.appendChild(el)
    }
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

function showAlert(text) {
    const el = document.createElement('div')
    el.className = 'alert'
    el.textContent = text
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
    document.body.appendChild(el)
    return el
}

/** jsdom implements no layout, so nothing reports itself visible. */
function alwaysVisible() {
    return true
}

// jsdom performs no layout, so the real _isVisible fails closed on every
// element; the old suite said "everything here is visible" by replacing it.
beforeAll(() => {
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = alwaysVisible
})

beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = '<input id="promo" />'
    finalModalCalls = stubs.finalModalCalls = []
    // getDomainRecord answers out of the store-list cache the source keeps on
    // the function itself, so this is REC served for the page under test — the
    // lookup matches on hostname, which jsdom will not let a test move.
    getDomainRecord.cache = [{ ...REC, domain: location.hostname }]
    _caramelResetCachedCodes()
    stubs.coupons = [
        { code: 'SALE20', id: 'c1' },
        { code: 'SPRING10', id: 'c2' },
    ]
})

describe('reading the store’s answer off the page it sent us to', () => {
    it('takes a rejection that names the code we submitted', () => {
        showAlert('Der Gutschein SALE20 wurde nicht angewendet')

        expect(caramelPostNavigationVerdict(REC, 'SALE20')).toMatch(/SALE20/)
    })

    it('takes a rejection written in the vocabulary of one', () => {
        // The motoin banner, in German, naming no code.
        showAlert('Dieser Gutschein ist nicht mehr gültig')

        expect(caramelPostNavigationVerdict(REC, 'SALE20')).toMatch(/gültig/)
    })

    it('leaves the page’s furniture alone', () => {
        // The mango failure arriving through the other door: a static label
        // that mentions neither our code nor a rejection.
        showAlert('Gutscheincode')

        expect(caramelPostNavigationVerdict(REC, 'SALE20')).toBeNull()
    })

    it('says nothing when the store said nothing', () => {
        expect(caramelPostNavigationVerdict(REC, 'SALE20')).toBeNull()
        showAlert('   ')
        expect(caramelPostNavigationVerdict(REC, 'SALE20')).toBeNull()
    })

    it('survives a config with no error selector at all', () => {
        expect(
            caramelPostNavigationVerdict({ domain: 'x.com' }, 'SALE20'),
        ).toBeNull()
        expect(caramelPostNavigationVerdict(null, 'SALE20')).toBeNull()
    })
})

describe('what the shopper is told after the reload', () => {
    it('repeats the store’s reason instead of sending them to look for it', async () => {
        // No readable total on this page — the case that used to end in
        // "check your order summary".
        caramelMarkPendingSubmit('SALE20', 'c1', [])
        showAlert('Dieser Gutschein ist abgelaufen')

        await startCheckoutDetection()

        const message = finalModalCalls[0][2]
        expect(message).toMatch(/store said/i)
        expect(message).toMatch(/abgelaufen/)
        expect(message).not.toMatch(/check your order summary/i)
    })

    it('still hands over the other codes to try', async () => {
        caramelMarkPendingSubmit('SALE20', 'c1', [])
        showAlert('Dieser Gutschein ist abgelaufen')

        await startCheckoutDetection()

        expect(finalModalCalls[0][4]?.length).toBeGreaterThan(0)
    })

    it('leads with the reason when the total is readable and flat', async () => {
        caramelMarkPendingSubmit('SALE20', 'c1', [80])
        setTotalText('Gesamt 80,00 €')
        showAlert('Dieser Gutschein ist abgelaufen')

        await startCheckoutDetection()

        expect(finalModalCalls[0][2]).toMatch(/store said/i)
        expect(finalModalCalls[0][2]).toMatch(/hasn't changed/i)
    })

    it('still admits it cannot tell when the store said nothing', async () => {
        // The honest fallback has to survive: no verdict, no readable total.
        caramelMarkPendingSubmit('SALE20', 'c1', [])

        await startCheckoutDetection()

        expect(finalModalCalls[0][2]).toMatch(/check your order summary/i)
    })

    it('never claims a saving off the store’s words alone', async () => {
        // A verdict is not a measurement. The amount stays zero and no code is
        // headlined as applied.
        caramelMarkPendingSubmit('SALE20', 'c1', [])
        showAlert('Dieser Gutschein ist abgelaufen')

        await startCheckoutDetection()

        expect(finalModalCalls[0][0]).toBe(0)
        expect(finalModalCalls[0][1]).toBeNull()
    })
})
