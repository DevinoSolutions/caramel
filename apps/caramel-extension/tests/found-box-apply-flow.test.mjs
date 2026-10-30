import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { _caramelRefusesTheCode, applyCoupon } from '../coupon-apply.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoveredRecord,
    caramelFinderConfirmed,
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
    wait,
} from './_found-box-harness.mjs'

// The real apply flow (coupon-apply.js applyCoupon) driving a box the finder
// picked (coupon-box-discovery.js caramelDiscoveredRecord). Real timers: the
// verdict is a race of pollers and what these pin lives in its timing.
//   · a store that enables Apply a tick after typing still gets the code;
//   · a total that dipped and came back is not a saving, and the box is not
//     saved as a proven one on the strength of it;
//   · a total drop beside the store's fresh refusal of the code is not a
//     saving — while a caveat printed as the code applies still is.

let logCalls

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
        log: (...args) => logCalls.push(args),
        // sleep stays real: the verdict's pollers are the thing under test.
    }
})

// The verdict waits up to 10s for a store that never answers.
const SLOW = 20000

// What the runner does with a success (coupon-runner.js): the box this run
// found is saved as the store's config for every later shopper.
const runnerWouldSave = (res, rec) => {
    if (res.success) caramelFinderConfirmed(rec)
    return sent.some(m => m?.action === 'couponBoxSave')
}

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

const setTotal = text => {
    document.getElementById('tot').textContent = text
}

// A Vue/React cart: the Apply button is disabled while the field is empty and
// is enabled by the framework's re-render, which lands on a microtask AFTER
// the input event (Vue nextTick, React 18 sync-lane flush). The shopper never
// notices: their click comes much later.
function enableApplyOnNextTick(input, btn) {
    btn.disabled = true
    input.addEventListener('input', () => {
        queueMicrotask(() => {
            btn.disabled = input.value.trim() === ''
        })
    })
}

describe('typing into a framework-controlled box', () => {
    it(
        'a store that enables Apply a tick after typing still gets the code',
        async () => {
            document.body.innerHTML = PROMO_BOX + TOTAL
            const input = document.getElementById('dc')
            const btn = document.getElementById('ap')
            enableApplyOnNextTick(input, btn)
            const submitted = []
            btn.addEventListener('click', () => submitted.push(input.value))

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            expect(rec?.caramelFound).toBe(true)

            await applyCoupon('SAVE20', rec)

            expect(btn.disabled).toBe(false)
            expect(submitted).toEqual(['SAVE20'])
        },
        SLOW,
    )

    it(
        'the same store with a config (a plain selector record) gets the code too',
        async () => {
            document.body.innerHTML = PROMO_BOX + TOTAL
            const input = document.getElementById('dc')
            const btn = document.getElementById('ap')
            enableApplyOnNextTick(input, btn)
            const submitted = []
            btn.addEventListener('click', () => submitted.push(input.value))

            await applyCoupon('SAVE20', {
                domain: 'shop.test',
                couponInput: '#dc',
                couponSubmit: '#ap',
                priceContainer: '#tot',
            })

            expect(submitted).toEqual(['SAVE20'])
        },
        SLOW,
    )

    it(
        'an Apply that never enables is logged and not clicked forever',
        async () => {
            document.body.innerHTML = PROMO_BOX + TOTAL
            const btn = document.getElementById('ap')
            btn.disabled = true
            const submitted = []
            btn.addEventListener('click', () => submitted.push(1))

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const res = await applyCoupon('SAVE20', rec)

            expect(res.success).toBe(false)
            expect(submitted).toEqual([])
            expect(
                logCalls.some(l => l[0] === 'AUTO_INSERT_APPLY_STILL_DISABLED'),
            ).toBe(true)
        },
        SLOW,
    )

    it(
        'a store whose Apply is enabled from the start gets the code',
        async () => {
            document.body.innerHTML = PROMO_BOX + TOTAL
            const input = document.getElementById('dc')
            const btn = document.getElementById('ap')
            const submitted = []
            btn.addEventListener('click', () => submitted.push(input.value))

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            await applyCoupon('SAVE20', rec)

            expect(submitted).toEqual(['SAVE20'])
        },
        SLOW,
    )
})

describe('reading the verdict off the total', () => {
    it(
        'a total area that re-renders first and only later shows the discount is a saving (T-10533)',
        async () => {
            // kipling-usa.com Shopify checkout, 2026-10-30: right after Apply
            // the summary re-drew the total row with the same number, and the
            // discounted total landed about 2.5s later. The redraw ended the
            // wait, the unchanged number ruled the code out, and the shopper
            // was told nothing worked while the order carried -$11.24.
            document.body.innerHTML = PROMO_BOX + TOTAL
            const btn = document.getElementById('ap')
            btn.addEventListener('click', () => {
                setTimeout(() => setTotal('USD $100.00'), 100)
                setTimeout(() => setTotal('USD $80.00'), 2500)
            })

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const res = await applyCoupon('SAVE20', rec)

            expect(res.success).toBe(true)
            expect(res.newTotal).toBe(80)
        },
        SLOW,
    )

    it(
        'a placeholder total mid re-draw does not end the wait either (T-10533)',
        async () => {
            document.body.innerHTML = PROMO_BOX + TOTAL
            const btn = document.getElementById('ap')
            btn.addEventListener('click', () => {
                setTimeout(() => setTotal('$0.00'), 100)
                setTimeout(() => setTotal('$100.00'), 400)
                setTimeout(() => setTotal('$80.00'), 2500)
            })

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const res = await applyCoupon('SAVE20', rec)

            expect(res.success).toBe(true)
            expect(res.newTotal).toBe(80)
        },
        SLOW,
    )

    it(
        'a refusal drawn after a same-number re-draw still ends the wait quickly (T-10533)',
        async () => {
            // The extra wait after a re-draw must not cost a refused code the
            // whole window: the store's own refusal of this code ends it.
            document.body.innerHTML = PROMO_BOX + TOTAL
            const btn = document.getElementById('ap')
            btn.addEventListener('click', () => {
                setTimeout(() => setTotal('USD $100.00'), 100)
                setTimeout(() => {
                    const msg = document.createElement('p')
                    msg.textContent = 'Enter a valid discount code'
                    btn.parentElement.appendChild(msg)
                }, 400)
            })

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const startedAt = performance.now()
            const res = await applyCoupon('NOPE', rec)

            expect(res.success).toBe(false)
            expect(performance.now() - startedAt).toBeLessThan(4000)
        },
        SLOW,
    )

    it(
        'a total that dipped and came back within a second is not a saving',
        async () => {
            // A cart that re-prices after the apply call: the summary
            // re-renders line by line, the total shows without the shipping
            // line for a moment, then the store's answer lands — the code did
            // nothing and the total is back where it was.
            document.body.innerHTML = PROMO_BOX + TOTAL
            const btn = document.getElementById('ap')
            btn.addEventListener('click', () => {
                setTimeout(() => setTotal('$90.00'), 50)
                setTimeout(() => setTotal('$100.00'), 1000)
            })

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const res = await applyCoupon('SAVE20', rec)
            // Let the store finish re-pricing before judging what was claimed.
            await wait(1200)

            expect(document.getElementById('tot').textContent).toBe('$100.00')
            expect(res.success).toBe(false)
            expect(runnerWouldSave(res, rec)).toBe(false)
        },
        SLOW,
    )

    it(
        'a total that dropped and stayed down is a saving, and the box is saved',
        async () => {
            document.body.innerHTML = PROMO_BOX + TOTAL
            const btn = document.getElementById('ap')
            btn.addEventListener('click', () => {
                setTimeout(() => setTotal('$90.00'), 50)
            })

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const res = await applyCoupon('SAVE20', rec)

            expect(res.success).toBe(true)
            expect(res.newTotal).toBe(90)
            expect(runnerWouldSave(res, rec)).toBe(true)
        },
        SLOW,
    )

    it(
        'a total that never moved settles quickly',
        async () => {
            document.body.innerHTML = PROMO_BOX + TOTAL
            const btn = document.getElementById('ap')
            // The store answers in the box, so the wait ends early; what
            // follows is the answer grace and the settle alone.
            btn.addEventListener('click', () => {
                setTimeout(() => {
                    const msg = document.createElement('p')
                    msg.textContent = 'This code is not valid.'
                    btn.parentElement.append(msg)
                }, 100)
            })

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const t0 = performance.now()
            const res = await applyCoupon('SAVE20', rec)

            expect(res.success).toBe(false)
            // Answer grace (1.5s) plus one settle read, never the 1.5s hold.
            expect(performance.now() - t0).toBeLessThan(3000)
        },
        SLOW,
    )

    const BOX_WITH_MESSAGE =
        '<div class="promo"><label for="dc">Discount code</label>' +
        '<input id="dc" name="discount_code" type="text">' +
        '<button id="ap" type="button">Apply</button>' +
        '<p id="msg" class="error" role="alert"></p></div>'

    const storeSays = (text, total) => {
        document.getElementById('ap').addEventListener('click', () => {
            setTimeout(() => {
                document.getElementById('msg').textContent = text
                if (total) setTotal(total)
            }, 100)
        })
    }

    it(
        "a total drop beside the store's fresh refusal of the code is not a saving",
        async () => {
            // The store refuses the code in the box's own area AND, in the
            // same re-render, its own automatic promotion (a threshold the
            // cart just crossed, a sitewide sale) takes $10 off.
            document.body.innerHTML = BOX_WITH_MESSAGE + TOTAL
            storeSays('SAVE20 is not a valid discount code.', '$90.00')

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const res = await applyCoupon('SAVE20', rec)

            expect(res.errorMsg || '').toMatch(/not a valid/i)
            expect(res.errorIsNew).toBe(true)
            expect(res.success).toBe(false)
            expect(runnerWouldSave(res, rec)).toBe(false)
        },
        SLOW,
    )

    it(
        "an acceptance with a caveat ('applied, cannot be combined') beside a drop is a saving",
        async () => {
            document.body.innerHTML = BOX_WITH_MESSAGE + TOTAL
            storeSays(
                'Promo code applied. Cannot be combined with other offers.',
                '$90.00',
            )

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const res = await applyCoupon('SAVE20', rec)

            expect(res.success).toBe(true)
        },
        SLOW,
    )

    it(
        "'Limit one offer per order' printed as the code applies is a saving",
        async () => {
            document.body.innerHTML = BOX_WITH_MESSAGE + TOTAL
            storeSays('Limit one offer per order.', '$90.00')

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const res = await applyCoupon('SAVE20', rec)

            expect(res.success).toBe(true)
        },
        SLOW,
    )

    it('what counts as the store refusing THIS code', () => {
        expect(
            _caramelRefusesTheCode(
                'SAVE20 is not a valid discount code.',
                'SAVE20',
            ),
        ).toBe(true)
        expect(
            _caramelRefusesTheCode('This coupon has expired.', 'SAVE20'),
        ).toBe(true)
        expect(_caramelRefusesTheCode('Code not recognised', 'SAVE20')).toBe(
            true,
        )
        expect(
            _caramelRefusesTheCode(
                'Sorry, SAVE20 cannot be used here.',
                'SAVE20',
            ),
        ).toBe(true)
        expect(
            _caramelRefusesTheCode('Limit one offer per order.', 'SAVE20'),
        ).toBe(false)
        expect(
            _caramelRefusesTheCode(
                'Promo code applied. Cannot be combined with other offers.',
                'SAVE20',
            ),
        ).toBe(false)
        expect(
            _caramelRefusesTheCode(
                'SAVE20 applied! Cannot be combined with other offers.',
                'SAVE20',
            ),
        ).toBe(false)
        expect(
            _caramelRefusesTheCode(
                'SAVE20 applied. Cannot be combined with SAVE20.',
                'SAVE20',
            ),
        ).toBe(false)
        expect(
            _caramelRefusesTheCode('A minimum spend of $50 applies.', 'SAVE20'),
        ).toBe(false)
        expect(_caramelRefusesTheCode('', 'SAVE20')).toBe(false)
        expect(_caramelRefusesTheCode(null, 'SAVE20')).toBe(false)
    })
})

describe("the store's answer in a page-wide alert, far from the box", () => {
    // pureformulas.com, measured live 2026-10-22: the cart answers a refused
    // code in one banner at the top of the page
    // (main > section > div.pfCart > div.container > div.alert[role=alert]),
    // nowhere near the box. Reading only around the box found nothing, the
    // run saw no answer from the store, and stopped after two codes as if the
    // checkout took no input at all.
    const SAID =
        "Oops! This code can't be applied. Possible reasons include exclusions on certain brands or products, order total not meeting the minimum requirement, prior use, or Autoship orders not qualifying."
    // Six wrappers: the banner sits further from the field than the five
    // levels the box's own area is read over.
    const deep = inner =>
        '<div><div><div><div><div><div>' +
        inner +
        '</div></div></div></div></div></div>'
    const page = alert =>
        '<main><div class="pfCart"><div class="container">' +
        `<div id="alert" class="alert alert-error" role="alert" aria-live="polite">${alert}</div>` +
        '</div>' +
        deep(PROMO_BOX + TOTAL) +
        '</div></main>'
    const storeAlerts = text =>
        document.getElementById('ap').addEventListener('click', () => {
            setTimeout(() => {
                document.getElementById('alert').textContent = text
            }, 100)
        })

    it(
        "a refusal that appears in the page's alert after the submit is the store's answer",
        async () => {
            document.body.innerHTML = page('')
            storeAlerts(SAID)

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            expect(rec?.caramelFound).toBe(true)
            const res = await applyCoupon('SAVE20', rec)

            expect(res.errorMsg).toBe(SAID)
            expect(res.errorIsNew).toBe(true)
            expect(res.success).toBe(false)
        },
        SLOW,
    )

    it(
        'the same refusal already showing before the submit is not quoted as our answer',
        async () => {
            document.body.innerHTML = page(SAID)

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const res = await applyCoupon('SAVE20', rec)

            expect(res.errorIsNew).toBe(false)
        },
        SLOW,
    )

    it(
        "the next refused code's banner, re-drawn with the same words, is the store's answer again",
        async () => {
            // Measured live on the same cart: the submit removes the banner
            // the previous code got, and the store's answer is a NEW banner
            // with the very same sentence about 2.5s later. Text alone cannot
            // tell it from the old one; the element can.
            document.body.innerHTML = page(SAID)
            document.getElementById('ap').addEventListener('click', () => {
                setTimeout(() => document.getElementById('alert').remove(), 50)
                setTimeout(() => {
                    const fresh = document.createElement('div')
                    fresh.className = 'alert alert-error'
                    fresh.setAttribute('role', 'alert')
                    fresh.textContent = SAID
                    document.querySelector('.container').prepend(fresh)
                }, 150)
            })

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const res = await applyCoupon('SAVE20', rec)

            expect(res.errorMsg).toBe(SAID)
            expect(res.errorIsNew).toBe(true)
        },
        SLOW,
    )

    it(
        'an alert about something other than a code is not read as a refusal',
        async () => {
            document.body.innerHTML = page('')
            storeAlerts('This item is no longer available.')

            const rec = await caramelDiscoveredRecord(NO_CONFIG)
            const res = await applyCoupon('SAVE20', rec)

            expect(res.errorMsg).toBe(null)
        },
        SLOW,
    )

    it(
        'a box from a config keeps reading only its own area',
        async () => {
            document.body.innerHTML = page('')
            storeAlerts(SAID)

            const res = await applyCoupon('SAVE20', {
                domain: 'shop.test',
                couponInput: '#dc',
                couponSubmit: '#ap',
                priceContainer: '#tot',
            })

            expect(res.errorMsg).toBe(null)
        },
        SLOW,
    )
})
