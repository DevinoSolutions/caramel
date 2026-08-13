import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import {
    afterLoginSuccess,
    capturePopupCallerId,
    setAfterLoginRerender,
} from '../popup-core.js'

// WXT-migration P0 characterization pins (2026-08-12; P2-ported to popup-core
// 2026-08-13): the checkout-modal caller relay had ZERO coverage, and it is
// exactly the seam the React/WXT popup rewrite disturbs — CARAMEL_CALLER_ID
// is read from location.search when capturePopupCallerId() runs (the React
// boot's FIRST popup-core call, before anything renders), and its failure
// mode is silent: the modal's "Sign In" flow simply never resumes in the
// originating tab.
//
// The contract under pin (popup half — background.js's half is pinned in
// background-caller-relay.test.mjs, including the round trip):
//   - opened with ?callerId=<tabId>, a successful login sends the worker
//     `userLoggedInFromPopup_<tabId>` (single underscore before the id — the
//     worker parses with split('_')[1]) and closes the window ~150ms later,
//     WITHOUT re-rendering; a dead originating tab must not prevent the close.
//   - opened normally (toolbar), it re-renders IN PLACE: the callback the
//     React app registers via setAfterLoginRerender() fires, and neither a
//     worker message nor a close happens. (The vanilla popup hard-called
//     initPopup() here; the registration seam is the P2 successor, and THIS
//     suite is what fails if the React boot forgets to register.)
//
// capturePopupCallerId() is re-run per describe-block with the URL already in
// place, because that call is what captures the id — a pin in itself: set the
// URL after the capture and the relay silently degrades to the toolbar
// branch. (`CARAMEL_CALLER_ID` defaults to null, the same value
// URLSearchParams.get() returns for an absent parameter.)

/* Realm stub, lifted from tests/_load.mjs (installChromeStub), which the ESM
 * port retires. Permissive Proxy: any unknown property materializes as a
 * callable no-op, so a source file touching an API this suite doesn't care
 * about cannot abort it. Two deliberate exceptions, exactly as _load.mjs had
 * them — storage.*.get/set/remove invoke their callbacks like the real API
 * (empty storage), and runtime.lastError stays UNDEFINED outside a failing
 * callback, because the proxy would otherwise auto-create a truthy callable
 * that caramelSendMessage reads as a closed port. */
function installChromeStub() {
    const cache = new WeakMap()
    const wrap = target => {
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
        stub.storage[area].remove = (_keys, cb) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
    return stub
}

// The realm is stood up ONCE — vitest gives the FILE one module registry, and
// caramel-base's double-load guard means a second stub would be orphaned on a
// currentBrowser nobody reads from. What each describe re-runs is the capture.
beforeAll(() => {
    installChromeStub()
    initCouponConstants()
    initCaramelBase()
    initCouponRunner()
})

/** The React app's registered re-resolve, observed instead of performed. */
const rerender = vi.fn()

const openPopupAt = urlPath => {
    history.replaceState(null, '', urlPath)
    window.close = vi.fn()
    capturePopupCallerId()
    setAfterLoginRerender(rerender)
}

beforeEach(() => {
    rerender.mockClear()
})

describe('caller relay — popup opened by the checkout modal (?callerId=42)', () => {
    beforeAll(() => {
        openPopupAt('/popup.html?isPopup=true&callerId=42')
    })

    it('notifies the worker with userLoggedInFromPopup_<callerId> and closes ~150ms later, without re-rendering', () => {
        vi.useFakeTimers()
        try {
            const sent = []
            globalThis.currentBrowser.runtime.sendMessage = m => {
                sent.push(m)
                return Promise.resolve()
            }
            window.close = vi.fn()

            afterLoginSuccess()

            // The exact action string is the wire contract: background.js
            // parses the id with split('_')[1], so the prefix must keep its
            // single trailing underscore and contain no other one.
            expect(sent).toEqual([{ action: 'userLoggedInFromPopup_42' }])
            expect(rerender).not.toHaveBeenCalled()

            // The close is DELAYED so the message reaches the worker first.
            vi.advanceTimersByTime(149)
            expect(window.close).not.toHaveBeenCalled()
            vi.advanceTimersByTime(1)
            expect(window.close).toHaveBeenCalledTimes(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('still closes when the originating tab is gone (sendMessage throws)', () => {
        vi.useFakeTimers()
        try {
            globalThis.currentBrowser.runtime.sendMessage = () => {
                throw new Error('Could not establish connection')
            }
            window.close = vi.fn()

            expect(() => afterLoginSuccess()).not.toThrow()

            vi.advanceTimersByTime(150)
            expect(window.close).toHaveBeenCalledTimes(1)
            expect(rerender).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })

    it('swallows an async rejection from a dead tab (promise-shaped sendMessage)', async () => {
        vi.useFakeTimers()
        try {
            globalThis.currentBrowser.runtime.sendMessage = () =>
                Promise.reject(new Error('Receiving end does not exist'))
            window.close = vi.fn()

            afterLoginSuccess()
            // Let the rejection settle; an unhandled rejection would fail the
            // suite via vitest's global handler.
            await Promise.resolve()
            await Promise.resolve()

            vi.advanceTimersByTime(150)
            expect(window.close).toHaveBeenCalledTimes(1)
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('caller relay — plain toolbar popup (no callerId)', () => {
    beforeAll(() => {
        openPopupAt('/popup.html')
    })

    it('re-renders in place: the registered rerender runs, no worker message, no close', () => {
        vi.useFakeTimers()
        try {
            const sent = []
            globalThis.currentBrowser.runtime.sendMessage = m => {
                sent.push(m)
                return Promise.resolve()
            }
            window.close = vi.fn()

            afterLoginSuccess()

            expect(rerender).toHaveBeenCalledTimes(1)
            expect(sent).toEqual([])
            vi.advanceTimersByTime(1000)
            expect(window.close).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})
