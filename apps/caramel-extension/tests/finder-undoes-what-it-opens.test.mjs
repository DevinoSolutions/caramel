import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoveredRecord,
} from '../coupon-box-discovery.js'
import { FINDER_ASSET, FINDER_FILE } from './_finder-asset.mjs'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'

// The finder undoes what it opens. On a store with no config it may click a
// toggle to find a folded promo box; when no box from that click is then used,
// whatever the click opened is closed again, and the same toggle is never
// clicked a second time in one run. Modelled on a real cart: its "Have a
// coupon code?" button opens a store info popup (a Magnific Popup: a fixed
// backdrop and a fixed wrapper appended to <body>, with a "×" close) that
// holds no field, only a note that codes go in at checkout. Before this, the
// rules clicked it, the server's pick named the same button and clicked it
// again, and the run ended on the copy-a-code card with the popup left open
// over the cart.

const NO_CONFIG = { domain: 'shop.test', caramelNoConfig: true }
const handoffs = tabHandoffBackground()
const OUTLINE_FILE = pathToFileURL(
    resolve(import.meta.dirname, '../coupon-box-outline.js'),
).href

let llmOn
let pickCalls
let answer

vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        sleep: () => new Promise(resolve => setTimeout(resolve, 0)),
    }
})

function installChromeStub() {
    const noop = () => {}
    const area = {
        get: (_keys, cb) => typeof cb === 'function' && cb({}),
        set: (_items, cb) => typeof cb === 'function' && cb(),
    }
    const stub = {
        storage: { sync: area, local: area, session: area },
        runtime: {
            lastError: undefined,
            getURL: path => {
                if (path === FINDER_ASSET) return FINDER_FILE
                if (path === 'assets/coupon-box-outline.js') return OUTLINE_FILE
                return 'chrome-extension://caramel/' + path
            },
            sendMessage: (message, cb) => {
                if (handoffs.answers(message, cb)) return
                const a = message?.action
                if (a === 'couponBoxDiscoveryEnabled') cb({ enabled: true })
                else if (a === 'couponBoxLlmEnabled') cb({ enabled: llmOn })
                else if (a === 'couponBoxPick') {
                    pickCalls.push(message)
                    cb(typeof answer === 'function' ? answer(message) : answer)
                } else cb({})
            },
            onMessage: { addListener: noop },
        },
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
}

// jsdom has no layout: hidden = display:none on the element or an ancestor,
// everything else a 120x30 box.
function stubLayout() {
    const hidden = el => {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement)
            if (n.hidden || n.style?.display === 'none') return true
        return false
    }
    Element.prototype.checkVisibility = function () {
        return !hidden(this)
    }
    Element.prototype.getBoundingClientRect = function () {
        const w = hidden(this) ? 0 : 120
        const h = hidden(this) ? 0 : 30
        return { left: 0, top: 0, right: w, bottom: h, width: w, height: h }
    }
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() {
            return hidden(this) ? '' : this.textContent
        },
    })
}

const TOTAL =
    '<div class="cart-totals"><div class="row"><span>Subtotal</span><span>$84.99</span></div>' +
    '<div class="row"><span>Total</span><span>$84.99</span></div></div>'

// The cart's own button, as the store renders it.
const HAVE_A_CODE =
    '<div class="cart-promo"><button type="button" class="promo-code-info link-button">Have a coupon code?</button></div>'

// The index the outline gave the element on the line matching `re`.
function idx(outline, re) {
    const line = outline.split('\n').find(l => re.test(l))
    return Number(/\[(\d+)\]/.exec(line)[1])
}
const pickToggle = re => req => ({
    outcome: 'box',
    input: null,
    button: null,
    toggle: idx(req.outline, re),
    confidence: 90,
    why: 'Toggle reveals hidden coupon field',
    cached: false,
})

// The store's info popup: a fixed backdrop and a fixed wrapper on <body>, the
// wrapper holding a "×" close and no field. Closed by its own × (and by
// Escape on keyup, as the popup script does).
function infoPopupOpener() {
    const opened = { clicks: 0 }
    const close = () => {
        document.querySelector('.mfp-bg')?.remove()
        document.querySelector('.mfp-wrap')?.remove()
    }
    document.addEventListener('keyup', e => {
        if (e.key === 'Escape') close()
    })
    document.querySelector('.promo-code-info').addEventListener('click', () => {
        opened.clicks++
        if (document.querySelector('.mfp-wrap')) return
        const bg = document.createElement('div')
        bg.className = 'mfp-bg mfp-ready'
        bg.style.position = 'fixed'
        const wrap = document.createElement('div')
        wrap.className = 'mfp-wrap mfp-close-btn-in mfp-ready'
        wrap.style.position = 'fixed'
        wrap.innerHTML =
            '<div class="mfp-container"><div class="mfp-content">' +
            '<div class="mfp-content-modal">' +
            '<button title="Close (Esc)" type="button" class="mfp-close">×</button>' +
            '<h1>Coupon Codes</h1>' +
            '<p>A coupon code can be entered during the checkout process. Please note only one coupon code or discount can be used per order.</p>' +
            '</div></div></div>'
        document.body.append(bg, wrap)
        wrap.querySelector('.mfp-close').addEventListener('click', close)
    })
    return opened
}

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
})

beforeEach(() => {
    sessionStorage.clear()
    handoffs.reset()
    document.body.innerHTML = ''
    window.history.replaceState({}, '', '/cart')
    llmOn = true
    pickCalls = []
    answer = { outcome: 'no_box', confidence: 80, why: 'none', cached: false }
    _caramelResetDiscoveryFlag()
})

describe('a toggle whose click showed no box is put back', () => {
    it('an info popup with no field is closed by its ×, and the toggle is clicked once even when the pick names it', async () => {
        document.body.innerHTML = HAVE_A_CODE + TOTAL
        const popup = infoPopupOpener()
        answer = pickToggle(/button "Have a coupon code\?"/)

        expect(await caramelDiscoveredRecord(NO_CONFIG)).toBe(null)

        expect(popup.clicks).toBe(1)
        expect(document.querySelector('.mfp-wrap')).toBe(null)
        expect(document.querySelector('.mfp-bg')).toBe(null)
        // The page was put back before the server read it.
        expect(pickCalls).toHaveLength(1)
        expect(pickCalls[0].outline).not.toContain('Coupon Codes')
    })

    it('with the server pick off, the popup is still closed', async () => {
        llmOn = false
        document.body.innerHTML = HAVE_A_CODE + TOTAL
        const popup = infoPopupOpener()

        expect(await caramelDiscoveredRecord(NO_CONFIG)).toBe(null)

        expect(popup.clicks).toBe(1)
        expect(document.querySelector('.mfp-wrap')).toBe(null)
        expect(pickCalls).toHaveLength(0)
    })

    it('a popup with no close control is closed by Escape', async () => {
        document.body.innerHTML = HAVE_A_CODE + TOTAL
        const keys = []
        document.addEventListener('keydown', e => {
            keys.push(e.key)
            if (e.key === 'Escape') document.getElementById('note')?.remove()
        })
        let clicks = 0
        document
            .querySelector('.promo-code-info')
            .addEventListener('click', () => {
                clicks++
                const note = document.createElement('div')
                note.id = 'note'
                note.className = 'info-overlay'
                note.style.position = 'fixed'
                note.innerHTML = '<p>Coupon codes are entered at checkout.</p>'
                document.body.append(note)
            })

        expect(await caramelDiscoveredRecord(NO_CONFIG)).toBe(null)

        expect(clicks).toBe(1)
        expect(keys).toContain('Escape')
        expect(document.getElementById('note')).toBe(null)
    })

    it('a dialog nothing else closes is shut with its aria-expanded toggle', async () => {
        document.body.innerHTML =
            '<div class="cart-promo"><button type="button" class="promo-code-info" aria-expanded="false">Have a coupon code?</button></div>' +
            TOTAL
        const toggle = document.querySelector('.promo-code-info')
        let clicks = 0
        toggle.addEventListener('click', () => {
            clicks++
            const open = toggle.getAttribute('aria-expanded') === 'true'
            toggle.setAttribute('aria-expanded', open ? 'false' : 'true')
            if (open) document.getElementById('info')?.remove()
            else {
                const info = document.createElement('div')
                info.id = 'info'
                info.setAttribute('role', 'dialog')
                info.innerHTML = '<p>Codes are entered at checkout.</p>'
                document.body.append(info)
            }
        })

        expect(await caramelDiscoveredRecord(NO_CONFIG)).toBe(null)

        // Once to look, once to put it back: never a third time for the pick.
        expect(clicks).toBe(2)
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        expect(document.getElementById('info')).toBe(null)
    })

    it("a popup the server's pick opened, with no field in it, is closed too", async () => {
        // A plain "Promo code" button with no disclosure signal is a row
        // title to the rules, but the pick may click it.
        document.body.innerHTML =
            '<div class="cart-promo"><button id="tg" type="button">Promo code</button></div>' +
            TOTAL
        let clicks = 0
        document.getElementById('tg').addEventListener('click', () => {
            clicks++
            const wrap = document.createElement('div')
            wrap.className = 'popup-wrap'
            wrap.style.position = 'fixed'
            wrap.innerHTML =
                '<p>Enter your code at checkout.</p>' +
                '<button type="button" aria-label="Close">×</button>'
            wrap.querySelector('button').addEventListener('click', () =>
                wrap.remove(),
            )
            document.body.append(wrap)
        })
        answer = pickToggle(/button "Promo code"/)

        expect(await caramelDiscoveredRecord(NO_CONFIG)).toBe(null)

        expect(pickCalls).toHaveLength(1)
        expect(clicks).toBe(1)
        expect(document.querySelector('.popup-wrap')).toBe(null)
    })
})

describe('a toggle whose click showed the box is left as it is', () => {
    it('a dialog holding the promo field is used, and stays open', async () => {
        document.body.innerHTML = HAVE_A_CODE + TOTAL
        let clicks = 0
        document
            .querySelector('.promo-code-info')
            .addEventListener('click', () => {
                clicks++
                const dialog = document.createElement('div')
                dialog.id = 'promo-dialog'
                dialog.setAttribute('role', 'dialog')
                dialog.setAttribute('aria-modal', 'true')
                dialog.style.position = 'fixed'
                dialog.innerHTML =
                    '<button type="button" class="close" aria-label="Close">×</button>' +
                    '<label for="dc">Discount code</label>' +
                    '<input id="dc" name="discount_code" type="text">' +
                    '<button id="ap" type="button">Apply</button>'
                document.body.append(dialog)
            })

        const rec = await caramelDiscoveredRecord(NO_CONFIG)

        expect(clicks).toBe(1)
        expect(document.querySelector(rec.couponInput)?.id).toBe('dc')
        expect(document.querySelector(rec.couponSubmit)?.id).toBe('ap')
        expect(document.getElementById('promo-dialog')).not.toBe(null)
        expect(pickCalls).toHaveLength(0)
    })
})
