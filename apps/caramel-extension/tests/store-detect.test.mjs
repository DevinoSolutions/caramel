import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { loadExtensionSource, loadExtensionSources } from './_load.mjs'

// D3 pin (audit/ext-e2e-report.md #8, ext-config-trace.md §5.5) —
// startCheckoutDetection()'s SPA re-detection MutationObserver is the sole
// safety net for a coupon box that appears AFTER the initial page-load
// check (drawer carts, SPA route changes — see the function's own doc
// comment). E2E reproduced it catching a freshly-INSERTED box but missing
// an already-present box that's merely revealed via a class/style toggle,
// because the observer only watched `childList`. The fix widens the SAME
// observer to also watch class/style/hidden attribute changes, feeding the
// exact same debounce (`scheduled` + one setTimeout(recheck, 400)) — no new
// mechanism. These pins drive both signal shapes through the real function.
let startCheckoutDetection
let getDomainRecord
let currentRec = null

beforeAll(() => {
    // Real load order (manifest.json): constants, then the F-008 split
    // files (coupon-fetch.js reads window.CaramelCoupons at module-eval
    // time), then UI-helpers.js — startCheckoutDetection's recheck() calls
    // insertCaramelPrompt(), which lives there.
    loadExtensionSource('coupon-constants.generated.js', [])
    ;({ startCheckoutDetection, getDomainRecord } = loadExtensionSources(
        [
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
            'UI-helpers.js',
        ],
        ['startCheckoutDetection', 'getDomainRecord'],
    ))

    // getDomainRecord's prod-TTL path (ttl>0, since _isDevInstall() is false
    // against this stub) reads chrome.storage.local before falling back to
    // the fetchSupportedStores message — stub both legs of that chain. Real
    // response shapes match background.js's contract (background.test.mjs).
    globalThis.currentBrowser.storage.local.get = (_keys, cb) => cb({})
    globalThis.currentBrowser.storage.local.set = () => {}
    globalThis.currentBrowser.runtime.sendMessage = (message, cb) => {
        if (message?.action === 'fetchSupportedStores') {
            cb({ supported: currentRec ? [currentRec] : [] })
        } else if (message?.action === 'fetchCoupons') {
            cb({ coupons: [{ code: 'SAVE10', status: 'valid' }] })
        } else {
            cb(undefined)
        }
    }
})

beforeEach(() => {
    document.body.innerHTML = ''
    // Re-injection guards are the whole point of this suite — must not leak
    // a previous test's observer/cache into the next one.
    window.__caramel_checkout_observer = null
    getDomainRecord.cache = null
    globalThis._caramelCodes = null
    currentRec = null
    vi.useFakeTimers()
})

afterEach(() => {
    window.__caramel_checkout_observer?.disconnect()
    window.__caramel_checkout_observer = null
    vi.useRealTimers()
})

// jsdom never computes real layout (offsetParent/display are inert), so
// _isVisible's checkVisibility() branch is the deterministic hook this repo
// already leans on for visibility-dependent tests — same idea as
// shared-utils.test.mjs's Object.defineProperty(el, 'innerText', ...).
function setVisible(el, visible) {
    el.checkVisibility = () => visible
}

describe('store-detect.js startCheckoutDetection — SPA re-detection (D3)', () => {
    it('(a) a node inserted after the initial check still triggers the prompt', async () => {
        currentRec = {
            domain: 'localhost',
            couponInput: '#promo-a',
            showInput: null,
        }

        const done = startCheckoutDetection()
        // Nothing matches '#promo-a' yet, so isCheckout()'s internal 3s
        // grace (dom-utils.js waitForElement) has to time out before the
        // initial tryInitialize() gives up and startCheckoutDetection()
        // arms the recheck observer under test.
        await vi.advanceTimersByTimeAsync(3100)
        await done

        expect(document.getElementById('caramel-small-prompt')).toBeNull()

        const node = document.createElement('input')
        node.id = 'promo-a'
        setVisible(node, true)
        document.body.appendChild(node)

        await vi.advanceTimersByTimeAsync(1000)

        expect(document.getElementById('caramel-small-prompt')).not.toBeNull()
    })

    it('(b) a class/style toggle on a PRE-EXISTING hidden node triggers the prompt', async () => {
        const node = document.createElement('input')
        node.id = 'promo-b'
        node.className = 'drawer-hidden'
        setVisible(node, false)
        document.body.appendChild(node)
        currentRec = {
            domain: 'localhost',
            couponInput: '#promo-b',
            showInput: null,
        }

        const done = startCheckoutDetection()
        // The node already exists (just hidden), so isCheckout()'s
        // waitForElement resolves "found-immediately" — no 3s wait here.
        await vi.advanceTimersByTimeAsync(100)
        await done

        expect(document.getElementById('caramel-small-prompt')).toBeNull()

        // No new node — only an attribute/visibility change on the SAME
        // pre-rendered element (the SPA drawer-cart reveal this defect
        // missed: childList alone never fires for this).
        setVisible(node, true)
        node.className = 'drawer-visible'

        await vi.advanceTimersByTimeAsync(1000)

        expect(document.getElementById('caramel-small-prompt')).not.toBeNull()
    })

    it('(c) a childList insertion and an attribute toggle firing together still insert exactly one prompt', async () => {
        const node = document.createElement('input')
        node.id = 'promo-c'
        node.className = 'drawer-hidden'
        setVisible(node, false)
        document.body.appendChild(node)
        currentRec = {
            domain: 'localhost',
            couponInput: '#promo-c',
            showInput: null,
        }

        const done = startCheckoutDetection()
        await vi.advanceTimersByTimeAsync(100)
        await done

        expect(document.getElementById('caramel-small-prompt')).toBeNull()

        // Both signal types inside the same synchronous block, so they land
        // in the same debounce window: an unrelated node insertion
        // (childList) plus the visibility toggle (attributes) on the
        // pre-existing node.
        const extra = document.createElement('div')
        extra.id = 'unrelated-insert'
        document.body.appendChild(extra)
        setVisible(node, true)
        node.className = 'drawer-visible'

        await vi.advanceTimersByTimeAsync(1000)

        expect(document.querySelectorAll('#caramel-small-prompt').length).toBe(
            1,
        )
    })
})
