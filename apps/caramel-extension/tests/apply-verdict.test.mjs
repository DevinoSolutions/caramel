import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Characterization of applyCoupon()'s snapshot -> verdict path.
 *
 * Pinned 2026-10-02, BEFORE the snapshot/verdict logic was extracted into
 * caramelSnapshotCart / caramelAwaitCouponVerdict (shared with
 * code-capture.js, which judges a shopper-typed code by the same rule). The
 * suites around it (apply-multi-price-total, false-success,
 * pre-existing-discount, ...) pin the price arithmetic and the runner's
 * reaction to a verdict; none of them pins the SUCCESS RULE itself:
 *
 *     priceDropped || (committed && stuck) || (committed && !errorMsg)
 *
 * These drive the REAL applyCoupon against a real (jsdom) checkout and assert
 * the verdict triple for each branch, so the extraction cannot move it.
 */

let applyCoupon

const BASE = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
}

/** jsdom has no layout: innerText is undefined and nothing is "visible".
 *  textContent is set too, because the price watcher observes DOM mutations
 *  and a bare property definition mutates nothing. */
function setText(el, text) {
    el.textContent = text
    Object.defineProperty(el, 'innerText', {
        value: text,
        configurable: true,
    })
}

/** The store answers one tick AFTER the click, like a real round-trip (the
 *  verdict waiter baselines the page right after the submit is dispatched). */
function respond(fn) {
    document.getElementById('apply').addEventListener('click', () => {
        setTimeout(fn, 150)
    })
}

function mountAppliedRow() {
    const row = document.createElement('div')
    row.id = 'applied-row'
    setText(row, 'SAVE10 applied')
    document.body.appendChild(row)
}

function showError(text) {
    const err = document.getElementById('err')
    setText(err, text)
}

beforeAll(() => {
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = () => true
})

beforeEach(async () => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button>' +
        '<div id="total"></div><div id="err"></div>'
    setText(document.getElementById('total'), '$100.00')
    vi.resetModules()
    ;({ applyCoupon } = await import('../coupon-apply.js'))
})

describe('applyCoupon verdict — success rule', () => {
    it('a price drop alone is a success, with the moved total', async () => {
        const rec = { ...BASE, priceContainer: '#total' }
        respond(() => setText(document.getElementById('total'), '$90.00'))

        const res = await applyCoupon('SAVE10', rec)

        expect(res.success).toBe(true)
        expect(res.newTotal).toBe(90)
        expect(res.committed).toBe(false)
        expect(res.errorMsg).toBeNull()
    })

    it('error text with no applied row and no price move is a failure', async () => {
        const rec = { ...BASE, errorIndicator: '#err' }
        respond(() => showError('This code is invalid'))

        const res = await applyCoupon('NOPE', rec)

        expect(res.success).toBe(false)
        expect(res.committed).toBe(false)
        expect(res.errorMsg).toBe('This code is invalid')
        expect(res.errorIsNew).toBe(true)
    })

    it('an applied row that stays, with no error, is a success', async () => {
        const rec = { ...BASE, successIndicator: '#applied-row' }
        respond(mountAppliedRow)

        const res = await applyCoupon('SAVE10', rec)

        expect(res.success).toBe(true)
        expect(res.committed).toBe(true)
        expect(res.errorMsg).toBeNull()
    })

    it('a row that sticks beats a noisy error region (rule 2)', async () => {
        const rec = {
            ...BASE,
            successIndicator: '#applied-row',
            errorIndicator: '#err',
        }
        respond(() => {
            mountAppliedRow()
            showError('Your code is invalid for some items')
        })

        const res = await applyCoupon('SAVE10', rec)

        expect(res.committed).toBe(true)
        expect(res.errorMsg).toBeTruthy()
        expect(res.success).toBe(true)
    })

    // A box the finder picked (coupon-box-discovery.js) has no store-written
    // success selector behind it, so the money rule alone decides.
    it('a finder-picked box: an applied row that stays is NOT a success without a price drop', async () => {
        const rec = {
            ...BASE,
            successIndicator: '#applied-row',
            priceContainer: '#total',
            caramelFound: true,
        }
        respond(mountAppliedRow)

        const res = await applyCoupon('SAVE10', rec)

        expect(res.committed).toBe(true)
        expect(res.success).toBe(false)
    })

    it('a finder-picked box: a price drop is a success', async () => {
        const rec = { ...BASE, priceContainer: '#total', caramelFound: true }
        respond(() => setText(document.getElementById('total'), '$90.00'))

        const res = await applyCoupon('SAVE10', rec)

        expect(res.success).toBe(true)
        expect(res.newTotal).toBe(90)
    })

    it('returns exactly the documented verdict keys', async () => {
        const rec = { ...BASE, successIndicator: '#applied-row' }
        respond(mountAppliedRow)

        const res = await applyCoupon('SAVE10', rec)

        expect(Object.keys(res).sort()).toEqual([
            'committed',
            'errorIsNew',
            'errorMsg',
            'newTotal',
            'success',
        ])
    })
})

describe('caramelAwaitCouponVerdict — logging of the code', () => {
    // The store's own furniture quotes the code before we submit anything, so
    // the verdict helper logs AUTO_INSERT_ERROR_NOT_ATTRIBUTABLE.
    async function runWith(opts) {
        const logged = []
        vi.resetModules()
        vi.doMock('../caramel-base.js', async importOriginal => ({
            ...(await importOriginal()),
            log: (...args) => logged.push(args),
        }))
        const mod = await import('../coupon-apply.js')
        const rec = { ...BASE, errorIndicator: '#err' }
        setText(document.getElementById('err'), 'Code SAVE10 is invalid')
        const snapshot = mod.caramelSnapshotCart(rec)
        await mod.caramelAwaitCouponVerdict(rec, snapshot, {
            code: 'SAVE10',
            timeoutMs: 300,
            ...opts,
        })
        vi.doUnmock('../caramel-base.js')
        return logged.filter(
            args => args[0] === 'AUTO_INSERT_ERROR_NOT_ATTRIBUTABLE',
        )
    }

    it('the runner keeps its full diagnostics (code and text)', async () => {
        const lines = await runWith({})

        expect(lines).toHaveLength(1)
        expect(JSON.stringify(lines[0])).toContain('SAVE10')
    })

    it('a redacted (shopper-code) verdict never logs the code or the page text', async () => {
        const lines = await runWith({ redact: true })

        expect(lines).toHaveLength(1)
        expect(JSON.stringify(lines)).not.toContain('SAVE10')
        expect(JSON.stringify(lines)).not.toContain('invalid')
    })
})
