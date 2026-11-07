import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A config whose toggle and apply selectors no longer match the store's box.
 *
 * Live on lindtusa.com (Magento, 1.4.22, 2026-10-27): the config names
 * `#block-discount-heading, .block.discount .title` to open the box and
 * `#discount-coupon-form button.action.apply` to apply a code. The cart now
 * wraps the whole discount block in Magento's collapsible widget ("Enter
 * Promotion Code") and an Amasty multi-coupon form whose button is
 * `button.amcoupons-apply`. The input still matched, so the prompt never
 * showed (the box was hidden, its toggle unmatched), and a run would have
 * failed every code with "Input / apply button missing".
 */

let applyCoupon

/** jsdom has no layout: innerText is set by hand (see apply-verdict.test). */
function setText(el, text) {
    el.textContent = text
    Object.defineProperty(el, 'innerText', {
        value: text,
        configurable: true,
    })
}

beforeAll(() => {
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = function () {
        for (let el = this; el && el.style; el = el.parentElement)
            if (el.style.display === 'none') return false
        return true
    }
})

const REC = {
    domain: 'example.com',
    couponInput: '#coupon_code',
    showInput: '#block-discount-heading, .block.discount .title',
    couponSubmit: '#discount-coupon-form button.action.apply',
    priceContainer: '.grand.totals .price',
}

let clicked
beforeEach(async () => {
    clicked = []
    document.body.innerHTML = `
        <div class="block" data-collapsible="true" role="tablist">
            <div id="opener" class="title" data-role="title" role="tab" aria-expanded="false" tabindex="0"><strong>Enter Promotion Code</strong></div>
            <div id="panel" class="content" data-role="content" role="tabpanel" style="display:none">
                <div id="block-discount" class="block discount">
                    <div class="content" data-role="content">
                        <form id="discount-coupon-form">
                            <div class="fieldset amcoupons-main-container">
                                <div class="field amcoupons-input"><div class="control">
                                    <input id="coupon_code" class="input-text" type="text" name="discount_code" />
                                </div></div>
                                <div class="actions-toolbar">
                                    <button id="apply" class="amcoupons-apply action primary" type="submit">Apply</button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        </div>
        <table><tr class="grand totals"><td><span class="price"></span></td></tr></table>`
    setText(document.querySelector('.grand.totals .price'), '$18.99')
    const opener = document.getElementById('opener')
    opener.addEventListener('click', () => {
        clicked.push('opener')
        document.getElementById('panel').style.display = ''
        opener.setAttribute('aria-expanded', 'true')
    })
    document
        .getElementById('discount-coupon-form')
        .addEventListener('submit', e => e.preventDefault())
    document.getElementById('apply').addEventListener('click', () => {
        clicked.push('apply')
        setTimeout(
            () =>
                setText(
                    document.querySelector('.grand.totals .price'),
                    '$15.19',
                ),
            150,
        )
    })
    vi.resetModules()
    ;({ applyCoupon } = await import('../coupon-apply.js'))
})

describe('a config whose box selectors went stale on a Magento cart', () => {
    it('opens the panel by its own header and applies with the form’s one button', async () => {
        const res = await applyCoupon('LINDT20', REC)

        expect(clicked[0]).toBe('opener')
        expect(clicked).toContain('apply')
        expect(document.getElementById('coupon_code').value).toBe('LINDT20')
        expect(res.success).toBe(true)
        expect(res.newTotal).toBe(15.19)
    }, 15000)

    it('never borrows a button from a form that asks for more than the code', async () => {
        // The same box, but its form also takes an email: the one submit
        // button sends that, so there is no apply button to use.
        const email = document.createElement('input')
        email.type = 'email'
        document.getElementById('coupon_code').after(email)

        const res = await applyCoupon('LINDT20', REC)

        expect(clicked).not.toContain('apply')
        expect(res.success).toBe(false)
    }, 15000)
})
