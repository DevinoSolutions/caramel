import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { applyCoupon } from '../coupon-apply.js'
import { installChromeStub, stubLayout } from './_found-box-harness.mjs'

// T-11267. A store that answers a code in its own alert leaves that alert open
// behind our card unless the apply flow closes it. Full Source's checkout,
// measured live 2026-11-05: a refused code opens
//   <div class="window" role="dialog" aria-modal="true">
//     <button class="close-btn"><i class="fa fa-times"></i></button>
//     ... Attention  Coupon code is invalid or unrecognized
// The real applyCoupon on a configured box, with real timers. A code the store
// answers only in an alert waits out the verdict's 10 s window.

const SLOW = 20000
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

const REC = {
    domain: 'shop.test',
    couponInput: '#dc',
    couponSubmit: '#ap',
    priceContainer: '#tot',
}
const REFUSAL = 'Coupon code is invalid or unrecognized'

// The cart, and what the store does when Apply is clicked.
function cart(onApply) {
    document.body.innerHTML =
        '<div class="row"><span>Total</span><span id="tot">$100.00</span></div>' +
        '<input id="dc" type="text"><button id="ap" type="button">Apply</button>'
    document.getElementById('ap').addEventListener('click', onApply)
}

// A store dialog on the page, removed by its close control when it has one.
function dialog(words, { close = true, id = 'alert' } = {}) {
    const el = document.createElement('div')
    el.id = id
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'true')
    el.innerHTML = `<div><h3>Attention</h3><p>${words}</p></div>`
    if (close) {
        const x = document.createElement('button')
        x.className = 'close-btn'
        x.addEventListener('click', () => el.remove())
        el.prepend(x)
    }
    document.body.append(el)
    return el
}

const shown = id => !!document.getElementById(id)

// Every Escape the page hears, as a store's popup script would.
function listenForEscape(onEscape) {
    const seen = []
    const handler = e => {
        if (e.key !== 'Escape') return
        seen.push(e.type)
        onEscape?.()
    }
    document.addEventListener('keydown', handler)
    return {
        seen,
        stop: () => document.removeEventListener('keydown', handler),
    }
}

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
})

beforeEach(() => {
    logCalls = []
    document.body.innerHTML = ''
})

describe('an alert the store opened for this code', () => {
    it(
        "is closed through its own close control, and its refusal is that code's answer",
        async () => {
            cart(() => dialog(REFUSAL))
            const res = await applyCoupon('NOPE10', REC)
            expect(shown('alert')).toBe(false)
            expect(res.success).toBe(false)
            expect(res.errorMsg).toBe(REFUSAL)
            expect(res.errorIsNew).toBe(true)
        },
        SLOW,
    )

    it(
        'with no close control of its own is closed with Escape',
        async () => {
            const escape = listenForEscape(() =>
                document.getElementById('alert')?.remove(),
            )
            cart(() => dialog(REFUSAL, { close: false }))
            const res = await applyCoupon('NOPE10', REC)
            escape.stop()
            expect(escape.seen).toContain('keydown')
            expect(shown('alert')).toBe(false)
            expect(res.errorMsg).toBe(REFUSAL)
        },
        SLOW,
    )

    it(
        'beside a working code is closed and the saving stands',
        async () => {
            cart(() => {
                document.getElementById('tot').textContent = '$80.00'
                dialog('Coupon code applied')
            })
            const res = await applyCoupon('GOOD20', REC)
            expect(res.success).toBe(true)
            expect(res.newTotal).toBe(80)
            expect(shown('alert')).toBe(false)
        },
        SLOW,
    )

    it(
        "leaves the store's answer beside the box as the quote",
        async () => {
            const said = 'That promo code is not valid.'
            const rec = { ...REC, errorIndicator: '#err' }
            cart(() => {
                document.getElementById('err').textContent = said
                dialog(REFUSAL)
            })
            const err = document.createElement('p')
            err.id = 'err'
            document.body.append(err)
            const res = await applyCoupon('NOPE10', rec)
            expect(shown('alert')).toBe(false)
            expect(res.errorMsg).toBe(said)
        },
        SLOW,
    )

    it(
        'is reported even when it cannot be closed, and is left as it is',
        async () => {
            cart(() => dialog(REFUSAL, { close: false }))
            const res = await applyCoupon('NOPE10', REC)
            expect(shown('alert')).toBe(true)
            expect(res.errorMsg).toBe(REFUSAL)
            expect(
                logCalls.some(
                    ([name, data]) =>
                        name === 'AUTO_INSERT_STORE_ALERT' &&
                        data.closed === false,
                ),
            ).toBe(true)
        },
        SLOW,
    )
})

describe('a dialog that was already open', () => {
    it(
        'is not touched, while the new alert beside it is closed',
        async () => {
            const clicked = vi.fn()
            cart(() => dialog(REFUSAL))
            const open = dialog('Your coupon code stays valid for a week', {
                id: 'open',
            })
            open.querySelector('.close-btn').addEventListener('click', clicked)
            await applyCoupon('NOPE10', REC)
            expect(clicked).not.toHaveBeenCalled()
            expect(shown('open')).toBe(true)
            expect(shown('alert')).toBe(false)
        },
        SLOW,
    )

    it(
        'is not closed by an Escape meant for the new alert',
        async () => {
            const escape = listenForEscape(() =>
                document.getElementById('open')?.remove(),
            )
            cart(() => dialog(REFUSAL, { close: false }))
            dialog('Choose a gift', { id: 'open' })
            const res = await applyCoupon('NOPE10', REC)
            escape.stop()
            expect(escape.seen).toEqual([])
            expect(shown('open')).toBe(true)
            expect(res.errorMsg).toBe(REFUSAL)
        },
        SLOW,
    )

    it(
        'is still that dialog when the store draws it again as a new node',
        async () => {
            const words = 'Your coupon code stays valid for a week'
            cart(() => {
                document.getElementById('open').remove()
                dialog(words, { id: 'open' })
            })
            dialog(words, { id: 'open' })
            await applyCoupon('NOPE10', REC)
            expect(shown('open')).toBe(true)
        },
        SLOW,
    )
})

describe('what opens during a try and is not its answer', () => {
    it.each([
        ['a chat prompt', 'Need help? Chat with us'],
        ['a cookie notice', 'We use cookies to improve your visit'],
        ['a field problem', 'Please enter a valid zip code'],
    ])(
        'leaves %s open',
        async (_name, words) => {
            cart(() => dialog(words))
            await applyCoupon('NOPE10', REC)
            expect(shown('alert')).toBe(true)
        },
        SLOW,
    )

    it(
        'leaves a dialog that holds a field open: it may be the box itself',
        async () => {
            cart(() => {
                const form = dialog('Get a coupon code in your inbox')
                form.append(document.createElement('input'))
            })
            await applyCoupon('NOPE10', REC)
            expect(shown('alert')).toBe(true)
        },
        SLOW,
    )
})

describe('the close control', () => {
    it(
        'is never a link that leaves the page',
        async () => {
            let clicked = false
            cart(() => {
                const el = dialog(REFUSAL, { close: false })
                const a = document.createElement('a')
                a.href = 'https://other.test/close'
                a.className = 'close'
                a.addEventListener('click', e => {
                    e.preventDefault()
                    clicked = true
                })
                el.append(a)
            })
            await applyCoupon('NOPE10', REC)
            expect(clicked).toBe(false)
        },
        SLOW,
    )

    it(
        'is never a control that completes the order',
        async () => {
            let clicked = false
            cart(() => {
                const el = dialog(REFUSAL, { close: false })
                const b = document.createElement('button')
                b.type = 'button'
                b.className = 'close'
                b.textContent = 'Place order'
                b.addEventListener('click', () => {
                    clicked = true
                })
                el.append(b)
            })
            await applyCoupon('NOPE10', REC)
            expect(clicked).toBe(false)
        },
        SLOW,
    )
})

it(
    'a failure while closing never costs the verdict',
    async () => {
        cart(() => {
            document.getElementById('tot').textContent = '$80.00'
            const el = dialog('Coupon code applied', { close: false })
            el.querySelector = () => {
                throw new Error('a page script broke this read')
            }
        })
        const res = await applyCoupon('GOOD20', REC)
        expect(res.success).toBe(true)
        expect(res.newTotal).toBe(80)
        expect(shown('alert')).toBe(true)
    },
    SLOW,
)
