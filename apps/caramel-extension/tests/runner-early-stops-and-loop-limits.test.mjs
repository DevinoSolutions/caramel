import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startApplyingCoupons } from '../coupon-runner.js'

// Characterization suite (T-5446), written BEFORE coupon-runner.js is split
// into modules: it pins the parts of startApplyingCoupons that no other suite
// asserts — the early stops (codes could not be loaded, none exist, none left
// untried, no store config), the 8-attempt cap and what the copy list still
// holds, the no-signal early exit and why a BLIND checkout is not the same
// thing, the wall-clock backstop, the late-total safety net, and what a
// cancel leaves behind.
//
// It pins what the code does today, not what anyone wishes it did. If a
// refactor changes one of these, the refactor changed behavior.

const stubs = vi.hoisted(() => ({
    applyCoupon: null,
    getCoupons: null,
    fetchCoupons: null,
    probeCartJson: null,
    sleep: null,
    triedCodes: {},
    finalModalCalls: [],
}))

vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        // `currentBrowser` is assigned by initCaramelBase(); a spread would
        // freeze it at undefined, so the live binding is passed through.
        get currentBrowser() {
            return actual.currentBrowser
        },
        sleep: (...args) => stubs.sleep(...args),
        caramelRecordSaving: () => {},
    }
})
vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: (...args) => stubs.applyCoupon(...args),
    probeCartJson: (...args) => stubs.probeCartJson(...args),
    _getTriedCodes: () => stubs.triedCodes,
    _markTriedCode: () => {},
    _unmarkTriedCode: () => {},
}))
vi.mock('../coupon-fetch.js', async importOriginal => ({
    ...(await importOriginal()),
    getCoupons: (...args) => stubs.getCoupons(...args),
    fetchCoupons: (...args) => stubs.fetchCoupons(...args),
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    showFinalModal: (...args) => stubs.finalModalCalls.push(args),
}))

let finalModalCalls
let appliedCodes

const REC = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
    priceContainer: '#total',
}

const codeList = n =>
    Array.from({ length: n }, (_, i) => ({
        code: `CODE${i + 1}`,
        id: `c${i + 1}`,
    }))

function setTotalText(text) {
    const el = document.getElementById('total')
    Object.defineProperty(el, 'innerText', { value: text, configurable: true })
}

/** The store answered in its own words — a signal, so no early exit. */
const storeRefusal = () => ({
    success: false,
    newTotal: NaN,
    committed: false,
    errorMsg: 'This code is not valid',
    errorIsNew: true,
})

/** Nothing happened that the page could show us — no signal at all. */
const silentCheckout = () => ({
    success: false,
    newTotal: 28,
    committed: false,
    errorMsg: null,
})

// jsdom performs no layout, so the real _isVisible fails closed on every
// element; implement the one signal it reads (same stand-in as
// empty-cart-guard.test.mjs).
beforeAll(() => {
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = () => true
})

beforeEach(() => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button><div id="total"></div>'
    setTotalText('Order Total $28.00')
    window.history.replaceState({}, '', '/cart')
    globalThis._caramelCancelled = false
    finalModalCalls = stubs.finalModalCalls = []
    appliedCodes = []
    stubs.triedCodes = {}
    stubs.getCoupons = async () => codeList(2)
    stubs.fetchCoupons = async () => []
    stubs.sleep = async () => {}
    stubs.probeCartJson = async () => null // non-Shopify: DOM path
    stubs.applyCoupon = async code => {
        appliedCodes.push(code)
        return storeRefusal()
    }
})

describe('startApplyingCoupons — it stops early, and says why', () => {
    it('says so when the codes could not be loaded, and tries nothing', async () => {
        stubs.getCoupons = async () => {
            throw new Error('offline')
        }

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
        const [amount, code, message] = finalModalCalls[0]
        expect(amount).toBe(0)
        expect(code).toBeNull()
        expect(message).toBe(
            "Couldn't load codes right now — give it another go in a moment.",
        )
    })

    it('says the catalogue is empty when the list is empty, and tries nothing', async () => {
        stubs.getCoupons = async () => []

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
        expect(finalModalCalls[0][2]).toBe(
            "No codes for this store just yet — we're working on it.",
        )
    })

    it('treats a list that is not a list the same way as an empty one', async () => {
        stubs.getCoupons = async () => null

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual([])
        expect(finalModalCalls[0][2]).toBe(
            "No codes for this store just yet — we're working on it.",
        )
    })

    it('hands every code over to copy when this tab already tried them all', async () => {
        stubs.getCoupons = async () => codeList(3)
        stubs.triedCodes = { CODE1: 1, CODE2: 1, CODE3: 1 }

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
        const [amount, code, message, isSignIn, list] = finalModalCalls[0]
        expect(amount).toBe(0)
        expect(code).toBeNull()
        expect(message).toMatch(/already tried these codes on this page/)
        expect(isSignIn).toBe(false)
        expect(list.map(c => c.code)).toEqual(['CODE1', 'CODE2', 'CODE3'])
    })

    it('skips the codes this tab already tried and applies only the rest', async () => {
        stubs.getCoupons = async () => codeList(3)
        stubs.triedCodes = { CODE1: 1 }

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual(['CODE2', 'CODE3'])
    })

    it('with no store config, offers the catalogue codes it holds to paste by hand', async () => {
        stubs.fetchCoupons = async (host, a, b) => {
            stubs.fetchCoupons.args = [host, a, b]
            return [{ code: ' HELD ONE ', id: 'h1' }, { code: '' }]
        }

        await startApplyingCoupons(null)

        expect(stubs.fetchCoupons.args).toEqual([location.hostname, '', ''])
        expect(appliedCodes).toEqual([])
        expect(finalModalCalls).toHaveLength(1)
        const [amount, code, message, isSignIn, list] = finalModalCalls[0]
        expect(amount).toBe(0)
        expect(code).toBeNull()
        expect(message).toBe(
            "We can't fill in the promo box on this store yet — copy a code below and paste it in at checkout.",
        )
        expect(isSignIn).toBe(false)
        // Cleaned (trimmed, unicode space collapsed) and empty codes dropped.
        expect(list.map(c => c.code)).toEqual(['HELD ONE'])
    })

    it('with no store config and no catalogue codes, says there are none', async () => {
        stubs.fetchCoupons = async () => []

        await startApplyingCoupons(null)

        expect(finalModalCalls).toHaveLength(1)
        expect(finalModalCalls[0][2]).toBe(
            "We don't have codes for this store yet.",
        )
        expect(finalModalCalls[0][4]).toEqual([])
    })

    it('with no store config and a catalogue that cannot be reached, blames us, not the store', async () => {
        stubs.fetchCoupons = async () => {
            throw new Error('API down')
        }

        await startApplyingCoupons(null)

        expect(finalModalCalls).toHaveLength(1)
        expect(finalModalCalls[0][2]).toBe(
            "We don't have codes for this store yet.",
        )
        expect(finalModalCalls[0][4]).toEqual([])
    })
})

describe('startApplyingCoupons — the attempt cap', () => {
    it('tries 8 codes at most, but still offers all of them to copy', async () => {
        stubs.getCoupons = async () => codeList(11)

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual(
            Array.from({ length: 8 }, (_, i) => `CODE${i + 1}`),
        )
        expect(finalModalCalls).toHaveLength(1)
        const list = finalModalCalls[0][4]
        expect(list.map(c => c.code)).toEqual(
            Array.from({ length: 11 }, (_, i) => `CODE${i + 1}`),
        )
    })

    it('marks as rejected only the codes the store turned down in its own words', async () => {
        stubs.getCoupons = async () => codeList(11)

        await startApplyingCoupons(REC)

        const list = finalModalCalls[0][4]
        const rejected = list.filter(c => c.rejected).map(c => c.code)
        expect(rejected).toEqual(
            Array.from({ length: 8 }, (_, i) => `CODE${i + 1}`),
        )
        // The three it never got to carry no verdict at all.
        for (const c of list.slice(8)) expect(c.rejected).toBeUndefined()
    })

    it('quotes the store back to the shopper when it said why', async () => {
        await startApplyingCoupons(REC)

        expect(finalModalCalls[0][2]).toBe(
            'The store said: “This code is not valid” — copy a code below to try it manually.',
        )
    })
})

describe('startApplyingCoupons — the no-signal early exit', () => {
    it('stops after 2 codes when the checkout shows nothing and the total is readable', async () => {
        stubs.getCoupons = async () => codeList(5)
        stubs.applyCoupon = async code => {
            appliedCodes.push(code)
            return silentCheckout()
        }

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual(['CODE1', 'CODE2'])
        expect(finalModalCalls).toHaveLength(1)
        // Nothing the store said, so no reason is quoted and nothing is marked.
        expect(finalModalCalls[0][2]).toBeNull()
        expect(finalModalCalls[0][4].some(c => c.rejected)).toBe(false)
        expect(finalModalCalls[0][4]).toHaveLength(5)
    })

    it('does not stop early on a checkout it cannot read — blindness is not evidence', async () => {
        stubs.getCoupons = async () => codeList(5)
        // No priceContainer, no success or error selector: no channel by
        // which an outcome could ever be seen.
        stubs.applyCoupon = async code => {
            appliedCodes.push(code)
            return silentCheckout()
        }

        await startApplyingCoupons({
            domain: 'example.com',
            couponInput: '#promo',
            couponSubmit: '#apply',
        })

        expect(appliedCodes).toEqual([
            'CODE1',
            'CODE2',
            'CODE3',
            'CODE4',
            'CODE5',
        ])
    })

    it('keeps going while the store keeps answering, however many codes it refuses', async () => {
        stubs.getCoupons = async () => codeList(4)

        await startApplyingCoupons(REC)

        expect(appliedCodes).toHaveLength(4)
    })

    it('does not let text that was already on the page count as a reaction', async () => {
        stubs.getCoupons = async () => codeList(5)
        stubs.applyCoupon = async code => {
            appliedCodes.push(code)
            return {
                success: false,
                newTotal: 28,
                committed: false,
                errorMsg: 'Promo code',
                errorIsNew: false,
            }
        }

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual(['CODE1', 'CODE2'])
        // The label was the store's furniture, not its answer: not quoted.
        expect(finalModalCalls[0][2]).toBeNull()
    })
})

describe('startApplyingCoupons — the wall-clock backstop', () => {
    // 2026-10-26 (T-9105): the first three codes are always tried, so a slow
    // first refusal no longer ends the run on its own (it skipped TEXT15, the
    // working second code, on bumbleandbumble.com); the budget stops it after
    // them. Was: only CODE1 tried.
    it('stops trying once 35 seconds are spent with nothing applied (after the first three codes), and offers the rest', async () => {
        stubs.getCoupons = async () => codeList(5)
        let clock = 0
        const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
        stubs.applyCoupon = async code => {
            appliedCodes.push(code)
            clock += 36000
            return storeRefusal()
        }

        try {
            await startApplyingCoupons(REC)
        } finally {
            now.mockRestore()
        }

        expect(appliedCodes).toEqual(['CODE1', 'CODE2', 'CODE3'])
        expect(finalModalCalls).toHaveLength(1)
        expect(finalModalCalls[0][4]).toHaveLength(5)
    })

    it('never cuts a run short once a code has won', async () => {
        stubs.getCoupons = async () => codeList(3)
        let clock = 0
        const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
        stubs.applyCoupon = async code => {
            appliedCodes.push(code)
            clock += 36000
            setTotalText('Order Total $20.00')
            return {
                success: true,
                newTotal: 20,
                committed: true,
                errorMsg: null,
            }
        }

        try {
            await startApplyingCoupons(REC)
        } finally {
            now.mockRestore()
        }

        expect(appliedCodes).toEqual(['CODE1'])
        expect(finalModalCalls[0][0]).toBe(8)
        expect(finalModalCalls[0][1]).toBe('CODE1')
    })
})

describe('startApplyingCoupons — the late-total safety net', () => {
    it('credits a code whose row is showing and whose total falls just after the verdict', async () => {
        document.body.insertAdjacentHTML(
            'beforeend',
            '<div class="promo-row">SAVE10 applied</div>',
        )
        stubs.getCoupons = async () => codeList(3)
        stubs.applyCoupon = async code => {
            appliedCodes.push(code)
            // The checkout re-renders its total a beat after the verdict: the
            // runner's own 400ms poll is what sees it.
            stubs.sleep = async () => setTotalText('Order Total $18.00')
            return {
                success: false,
                newTotal: 28,
                committed: true,
                errorMsg: 'flash of error',
                errorIsNew: true,
            }
        }

        await startApplyingCoupons({ ...REC, successIndicator: '.promo-row' })

        expect(appliedCodes).toEqual(['CODE1'])
        expect(finalModalCalls).toHaveLength(1)
        expect(finalModalCalls[0][0]).toBe(10)
        expect(finalModalCalls[0][1]).toBe('CODE1')
    })

    it('does not wait on, or credit, a code when no applied row is showing', async () => {
        stubs.getCoupons = async () => codeList(2)
        stubs.applyCoupon = async code => {
            appliedCodes.push(code)
            stubs.sleep = async () => setTotalText('Order Total $18.00')
            return storeRefusal()
        }

        await startApplyingCoupons({ ...REC, successIndicator: '.promo-row' })

        expect(appliedCodes).toEqual(['CODE1', 'CODE2'])
        expect(finalModalCalls[0][0]).toBe(0)
        expect(finalModalCalls[0][1]).toBeNull()
    })

    it('does not credit a row that reads "Not Applied"', async () => {
        document.body.insertAdjacentHTML(
            'beforeend',
            '<div class="promo-row">SAVE10 Not Applied</div>',
        )
        stubs.getCoupons = async () => codeList(2)
        stubs.applyCoupon = async code => {
            appliedCodes.push(code)
            stubs.sleep = async () => setTotalText('Order Total $18.00')
            return storeRefusal()
        }

        await startApplyingCoupons({ ...REC, successIndicator: '.promo-row' })

        expect(appliedCodes).toEqual(['CODE1', 'CODE2'])
        expect(finalModalCalls[0][1]).toBeNull()
    })
})

describe('startApplyingCoupons — cancelling', () => {
    it('stops the loop and shows no result card when the shopper cancels mid-run', async () => {
        stubs.getCoupons = async () => codeList(4)
        stubs.applyCoupon = async code => {
            appliedCodes.push(code)
            globalThis._caramelCancelled = true
            return storeRefusal()
        }

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual(['CODE1'])
        expect(finalModalCalls).toEqual([])
    })

    it('clears a cancel left over from an earlier run when a new run starts', async () => {
        globalThis._caramelCancelled = true

        await startApplyingCoupons(REC)

        expect(appliedCodes).toEqual(['CODE1', 'CODE2'])
        expect(globalThis._caramelCancelled).toBe(false)
    })
})
