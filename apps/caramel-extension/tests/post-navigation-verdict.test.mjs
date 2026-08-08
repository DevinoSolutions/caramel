import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

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

let caramelPostNavigationVerdict
let caramelMarkPendingSubmit
let startCheckoutDetection
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

beforeAll(() => {
    ;({ caramelPostNavigationVerdict, caramelMarkPendingSubmit } =
        loadExtensionSources(
            [
                'coupon-constants.generated.js',
                'caramel-base.js',
                'dom-utils.js',
                'store-detect.js',
                'coupon-apply.js',
                'coupon-fetch.js',
                'coupon-runner.js',
            ],
            ['caramelPostNavigationVerdict', 'caramelMarkPendingSubmit'],
        ))
    startCheckoutDetection = globalThis.startCheckoutDetection
})

beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = '<input id="promo" />'
    finalModalCalls = []
    globalThis._isVisible = el => !!el
    globalThis.getDomainRecord = async () => REC
    globalThis.getCachedCodes = async () => [
        { code: 'SALE20', id: 'c1' },
        { code: 'SPRING10', id: 'c2' },
    ]
    globalThis.insertCaramelPrompt = () => {}
    globalThis.isCheckout = async () => true
    globalThis.showFinalModal = (...args) => finalModalCalls.push(args)
    globalThis.caramelRecordSaving = () => {}
    globalThis.reportOutcome = () => {}
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
