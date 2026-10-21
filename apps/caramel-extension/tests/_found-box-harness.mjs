// Harness for the suites that drive a box the finder picked
// (coupon-box-discovery.js) through the real apply flow (coupon-apply.js
// applyCoupon). Mirrors coupon-box-discovery.test.mjs: a Proxy chrome stub
// that answers the few messages the finder and the apply flow send, and a
// jsdom layout stub (hidden = display:none / hidden attribute; everything
// else a 120x30 box at the origin, or where placeAt put it; innerText is the
// text content).
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as finder from '../coupon-box-discovery.js'
import { _caramelUseLoadedFinder } from '../coupon-box-finder-loader.js'
import { EXT_ROOT } from './_entry-modules.mjs'
import { finderOnlyGetURL } from './_finder-asset.mjs'
import { tabHandoffBackground } from './_tab-handoff-background.mjs'

// The selector grammar the finder imports on demand to describe a box it
// found (coupon-box-discovery.js savable): under vitest the source module
// stands in for the built asset, so a found box is savable here as it is in
// the build.
const SELECTORS_FILE = pathToFileURL(
    join(EXT_ROOT, 'coupon-box-selectors.js'),
).href
const getURL = path =>
    path === 'assets/coupon-box-selectors.js'
        ? SELECTORS_FILE
        : finderOnlyGetURL(path)

/** The apply flow reaches the finder through the loader's seam
 *  (coupon-box-finder-loader.js caramelLoadedFinder); a suite that drives
 *  the real applyCoupon on a found box must register it, as the runner's
 *  caramelLoadFinder would. */
export function registerFinder() {
    _caramelUseLoadedFinder(finder)
}

/** Every non-handoff message the page sent the background (couponBoxSave,
 *  the flags, …), for a test to assert on. */
export const sent = []

export const NO_CONFIG = { domain: 'shop.test', caramelNoConfig: true }
export const handoffs = tabHandoffBackground()

export const COUPONS = [
    {
        code: 'SAVE20',
        id: 'c1',
        discount_type: 'PERCENTAGE',
        discount_amount: 20,
    },
]

export const TOTAL =
    '<div class="row"><span>Total</span><span id="tot">$100.00</span></div>'
export const PROMO_BOX =
    '<div class="promo"><label for="dc">Discount code</label>' +
    '<input id="dc" name="discount_code" type="text" placeholder="Enter code">' +
    '<button id="ap" type="button">Apply</button></div>'

export const flags = { discovery: true, llm: false }

export function installChromeStub() {
    const cache = new WeakMap()
    function wrap(target) {
        if (cache.has(target)) return cache.get(target)
        const proxy = new Proxy(target, {
            get(obj, prop) {
                if (prop === 'then' || typeof prop === 'symbol')
                    return undefined
                if (!(prop in obj)) obj[prop] = wrap(function () {})
                return obj[prop]
            },
            apply: () => undefined,
        })
        cache.set(target, proxy)
        return proxy
    }
    const stub = wrap(function chromeStubRoot() {})
    for (const area of ['sync', 'local', 'session']) {
        stub.storage[area].get = (_keys, cb) => {
            if (typeof cb === 'function') cb({})
        }
        stub.storage[area].set = (_items, cb) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    stub.runtime.getURL = getURL
    stub.runtime.sendMessage = (message, cb) => {
        if (handoffs.answers(message, cb)) return
        sent.push(message)
        if (message?.action === 'fetchCoupons') cb({ coupons: COUPONS })
        else if (message?.action === 'couponBoxDiscoveryEnabled')
            cb({ enabled: flags.discovery })
        else if (message?.action === 'couponBoxLlmEnabled')
            cb({ enabled: flags.llm })
        else cb({})
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
}

/** Per-element layout overrides: `placeAt(el, {left, top})` moves one box so
 *  a test can say "this button is 200px below the field", which jsdom's
 *  everything-at-the-origin stub cannot. */
const placed = new WeakMap()
export function placeAt(el, rect) {
    placed.set(el, rect)
}

export function stubLayout() {
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
        const at = placed.get(this) || { left: 0, top: 0 }
        return {
            x: at.left,
            y: at.top,
            left: at.left,
            top: at.top,
            right: at.left + w,
            bottom: at.top + h,
            width: w,
            height: h,
        }
    }
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
        configurable: true,
        get() {
            return hidden(this) ? '' : this.textContent
        },
    })
}

export function setPath(pathname) {
    window.history.replaceState({}, '', pathname)
}

export const wait = ms => new Promise(r => setTimeout(r, ms))
