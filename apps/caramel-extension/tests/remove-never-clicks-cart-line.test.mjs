import { beforeEach, describe, expect, it, vi } from 'vitest'
import { removeAppliedCoupon } from '../coupon-apply.js'

// Between codes, removeAppliedCoupon takes our failed code back off the cart.
// Many store configs name the remove button broadly — `[aria-label*="Remove"]`
// is on hundreds of Shopify configs — and on a Shopify cart that also matches
// every product line's own button, labelled "Remove <product name>". The
// forbidden-control guard reads "remove item / from cart", not a product name,
// so it lets those through. When the discount row does not print our code, the
// old fallback clicked the LAST candidate, and on a cart whose discount chip
// renders before the line list that is a product leaving the shopper's cart.

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
    couponInput: '#Discount',
    couponRemove: '[aria-label*="Remove"]',
}

// Shaped like Dawn: the discount chip sits in the footer above the line list,
// and each line's remove is a <cart-remove-button> beside its quantity field.
const DAWN_CART = `
    <div class="cart__footer">
      <input id="Discount" value="SAVE10" />
      <ul class="discounts">
        <li class="discounts__discount">10% off
          <button id="chip" aria-label="Remove discount">x</button></li>
      </ul>
    </div>
    <table class="cart-items"><tbody>
      <tr class="cart-item" id="CartItem-1">
        <td><a href="/products/classic-tee">Classic Tee</a></td>
        <td><input name="updates[]" value="1" />
          <cart-remove-button><a id="line1" aria-label="Remove Classic Tee" href="/cart/change?line=1&quantity=0">x</a></cart-remove-button></td>
      </tr>
      <tr class="cart-item" id="CartItem-2">
        <td><a href="/products/socks">Socks</a></td>
        <td><input name="updates[]" value="2" />
          <cart-remove-button><a id="line2" aria-label="Remove Socks" href="/cart/change?line=2&quantity=0">x</a></cart-remove-button></td>
      </tr>
    </tbody></table>`

// The same cart without any platform class names: only the quantity field
// says which rows are products.
const PLAIN_CART = `
    <div class="footer">
      <input id="Discount" value="SAVE10" />
      <div class="chip"><span>10% off</span>
        <button id="chip" aria-label="Remove">x</button></div>
    </div>
    <div class="rows">
      <div class="row"><div class="info">Classic Tee</div>
        <div class="controls"><input name="quantity" value="1" />
          <button id="line1" aria-label="Remove Classic Tee">x</button></div></div>
      <div class="row"><div class="info">Socks</div>
        <div class="controls"><input name="quantity" value="2" />
          <button id="line2" aria-label="Remove Socks">x</button></div></div>
    </div>`

let clicked

function watchClicks() {
    clicked = []
    for (const el of document.querySelectorAll('button, a[aria-label]')) {
        el.addEventListener('click', e => {
            e.preventDefault()
            clicked.push(e.currentTarget.id)
        })
    }
}

beforeEach(() => {
    Element.prototype.checkVisibility = () => true
})

describe('removeAppliedCoupon never removes a product line', () => {
    it('Dawn cart: clicks the discount chip, never the last line remove', async () => {
        document.body.innerHTML = DAWN_CART
        watchClicks()

        const removed = await removeAppliedCoupon(REC, { code: 'SAVE10' })

        expect(clicked).toEqual(['chip'])
        expect(removed).toBe(true)
    })

    it('plain cart: a quantity field beside the button marks it a product line', async () => {
        document.body.innerHTML = PLAIN_CART
        watchClicks()

        await removeAppliedCoupon(REC, { code: 'SAVE10' })

        expect(clicked).toEqual(['chip'])
    })

    it('refuses rather than guesses when every candidate is a product line', async () => {
        document.body.innerHTML = DAWN_CART
        document.querySelector('.discounts').remove()
        watchClicks()

        const removed = await removeAppliedCoupon(REC, { code: 'SAVE10' })

        expect(clicked).toEqual([])
        expect(removed).toBe(false)
        // Refusing is not a fallback to clearing the box: the code is
        // committed, and a cleared input says nothing about the cart.
        expect(document.getElementById('Discount').value).toBe('SAVE10')
    })

    it('a line that prints our code (a line-level discount) is still a line', async () => {
        document.body.innerHTML = PLAIN_CART
        document.querySelector('.chip').remove()
        document
            .querySelector('.row .info')
            .insertAdjacentHTML('beforeend', ' <span>SAVE10 applied</span>')
        watchClicks()

        const removed = await removeAppliedCoupon(REC, { code: 'SAVE10' })

        expect(clicked).toEqual([])
        expect(removed).toBe(false)
    })

    it('a lone discount chip on a one-line cart is still removed', async () => {
        // The climb from the chip must stop before the container that also
        // holds the one product line, or the only quantity field on the page
        // would make the chip read as a line.
        document.body.innerHTML = `
            <form id="cart">
              <div class="line"><span>Classic Tee</span>
                <input name="quantity" value="1" /></div>
              <div class="summary">
                <input id="Discount" value="SAVE10" />
                <div class="chip"><button id="chip" aria-label="Remove">x</button></div>
              </div>
            </form>`
        watchClicks()

        const removed = await removeAppliedCoupon(REC, { code: 'SAVE10' })

        expect(clicked).toEqual(['chip'])
        expect(removed).toBe(true)
    })
})
