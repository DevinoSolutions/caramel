import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeAppliedCoupon } from '../coupon-apply.js'

// Salesforce Commerce Cloud (SFRA) carts ask before they remove a code: the
// row's × opens #removeCouponModal ("Remove Coupon? ... Yes / No") and only
// its Yes calls Cart-RemoveCouponLineItem (aquasana.com, live 2026-10-27).
// Our click stopped at the dialog, so a refused code stayed on the cart and
// the next code was refused as "cannot be combined with other coupons already
// in your cart" (T-9569).

vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        sleep: async () => {},
    }
})

const REC = {
    couponInput: '#couponCode',
    couponRemove: '.remove-coupon',
}

/** The SFRA cart: one refused code's row, and the dialog its × opens. */
function sfraCart({
    dialogText = 'Remove Coupon? Are you sure you want to remove the following coupon from the cart? JULY50',
} = {}) {
    document.body.innerHTML = `
        <input id="couponCode" />
        <div class="coupons-and-promos">
          <div class="coupon-price-adjustment">JULY50 NOT APPLIED
            <button type="button" class="remove-coupon" data-code="JULY50"
              data-toggle="modal" data-target="#removeCouponModal">×</button>
          </div>
        </div>
        <div class="modal" id="removeCouponModal" hidden>
          <p class="dialog-text">${dialogText}</p>
          <button type="button" id="dismiss" data-dismiss="modal">×</button>
          <button type="button" id="no" data-dismiss="modal">No</button>
          <button type="button" id="yes" class="btn delete-coupon-confirmation-btn" data-dismiss="modal">Yes</button>
        </div>`
    const modal = document.getElementById('removeCouponModal')
    // jsdom has no layout: innerText is the text, and the × opens the dialog.
    Object.defineProperty(modal, 'innerText', {
        get: () => modal.textContent,
        configurable: true,
    })
    document
        .querySelector('.remove-coupon')
        .addEventListener('click', () => modal.removeAttribute('hidden'))
    document.getElementById('yes').addEventListener('click', () => {
        document.querySelector('.coupon-price-adjustment').remove()
        modal.setAttribute('hidden', '')
    })
}

beforeAll(() => {
    const { Element } = globalThis.window ?? globalThis
    // Visible unless it, or an ancestor, is hidden.
    Element.prototype.checkVisibility = function () {
        return !this.closest('[hidden]')
    }
})

let clicked = []
beforeAll(() => {
    document.addEventListener(
        'click',
        e => clicked.push(e.target.id || e.target.className),
        true,
    )
})
beforeEach(() => {
    clicked = []
})

describe('a cart that asks "remove this coupon?" before it removes it', () => {
    it('confirms the dialog the remove button opens, so the code really comes off', async () => {
        sfraCart()

        await removeAppliedCoupon(REC, { code: 'JULY50' })

        expect(clicked).toContain('yes')
        expect(clicked).not.toContain('no')
        expect(document.querySelector('.coupon-price-adjustment')).toBeNull()
    })

    it('waits for a dialog that opens a moment after the click', async () => {
        sfraCart()
        // Bootstrap shows its backdrop first, and the dialog after it.
        const modal = document.getElementById('removeCouponModal')
        let checks = 0
        modal.checkVisibility = () =>
            ++checks > 3 && !modal.hasAttribute('hidden')

        await removeAppliedCoupon(REC, { code: 'JULY50' })

        expect(clicked).toContain('yes')
        expect(document.querySelector('.coupon-price-adjustment')).toBeNull()
    })

    it('lets the dialog finish fading in before it presses Yes', async () => {
        // Bootstrap ignores a hide asked for mid-fade: the dialog stayed open
        // over the cart and the next code's x shut it instead of opening it.
        sfraCart()
        const modal = document.getElementById('removeCouponModal')
        let frames = 0
        modal.getAnimations = () =>
            ++frames <= 3 ? [{ playState: 'running' }] : []
        let fadingAtYes = null
        document
            .getElementById('yes')
            .addEventListener('click', () => (fadingAtYes = frames <= 3), true)

        await removeAppliedCoupon(REC, { code: 'JULY50' })

        expect(clicked).toContain('yes')
        expect(fadingAtYes).toBe(false)
    })

    it('never confirms a dialog that is not about a coupon', async () => {
        sfraCart({ dialogText: 'Remove this item from your bag? Classic Tee' })

        await removeAppliedCoupon(REC, { code: 'JULY50' })

        expect(clicked).not.toContain('yes')
    })

    it('leaves a remove button that names no dialog exactly as before', async () => {
        sfraCart()
        const btn = document.querySelector('.remove-coupon')
        btn.removeAttribute('data-target')
        btn.removeAttribute('data-toggle')

        await removeAppliedCoupon(REC, { code: 'JULY50' })

        expect(clicked).toEqual(['remove-coupon'])
    })
})
