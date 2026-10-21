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
