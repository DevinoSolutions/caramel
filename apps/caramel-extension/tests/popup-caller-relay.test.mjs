import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import { afterLoginSuccess, initPopupEntry } from '../popup.js'

// WXT-migration P0 characterization pins (2026-08-12): the checkout-modal
// caller relay had ZERO coverage, and it is exactly the seam the React/WXT
// popup rewrite disturbs — CARAMEL_CALLER_ID is read from location.search when
// initPopupEntry() runs (popup.js, the ESM port's successor to the old
// module-eval-time read), and its failure mode is silent: the modal's "Sign In"
// flow simply never resumes in the originating tab.
//
// The contract under pin (popup half — background.js's half is pinned in
// background-caller-relay.test.mjs, including the round trip):
//   - opened with ?callerId=<tabId>, a successful login sends the worker
//     `userLoggedInFromPopup_<tabId>` (single underscore before the id — the
//     worker parses with split('_')[1]) and closes the window ~150ms later,
//     WITHOUT re-rendering; a dead originating tab must not prevent the close.
//   - opened normally (toolbar), it re-renders via initPopup() and neither
//     messages the worker nor closes.
//
// initPopupEntry() is re-run per describe-block with the URL already in place,
// because that call is what captures the id — a pin in itself: set the URL
// after the capture and the relay silently degrades to the toolbar branch.
// (`CARAMEL_CALLER_ID` defaults to null, the same value URLSearchParams.get()
// returns for an absent parameter.)
//
// "initPopup ran" is observed one layer down, at initPopup's own first act:
// it awaits getActiveTabDomainRecord(), which calls
// caramelSendMessage({action:'getActiveTabDomainRecord'}) synchronously. Under
// ESM that call resolves to popup.js's module-local binding, so the old
// `globalThis.initPopup = vi.fn()` swap has no seam to replace — mocking the
// collaborator it reaches for does, and it keeps the raw
// currentBrowser.runtime.sendMessage recorder below free to record ONLY the
// relay's own worker message.

const POPUP_DOM =
    '<div id="loading-container"></div>' +
    '<button id="settingsIcon" style="display:none"></button>' +
    '<div id="auth-container"></div>'

/* Never settles: initPopup awaits it, so the probe records that the render
 * started without letting the rest of the chain run under fake timers. */
const stubs = vi.hoisted(() => ({
    caramelSendMessage: vi.fn(() => new Promise(() => {})),
}))

vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        // `currentBrowser` is a live binding that initCaramelBase() assigns;
        // a plain spread would freeze its pre-init `undefined`.
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelSendMessage: stubs.caramelSendMessage,
    }
})

/** How many times initPopup() has started since the last reset. */
const initPopupRuns = () =>
    stubs.caramelSendMessage.mock.calls.filter(
        ([message]) => message?.action === 'getActiveTabDomainRecord',
    ).length

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
// currentBrowser nobody reads from (the same thing the old harness did across
// its two loads). What each describe re-runs is the capture.
beforeAll(() => {
    installChromeStub()
    initCouponConstants()
    initCaramelBase()
    initCouponRunner()
})

const openPopupAt = urlPath => {
    history.replaceState(null, '', urlPath)
    document.body.innerHTML = POPUP_DOM
    window.close = vi.fn()
    initPopupEntry()
}

beforeEach(() => {
    stubs.caramelSendMessage.mockClear()
})

describe('caller relay — popup opened by the checkout modal (?callerId=42)', () => {
    beforeAll(() => {
        openPopupAt('/index.html?isPopup=true&callerId=42')
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
            expect(initPopupRuns()).toBe(0)

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
            expect(initPopupRuns()).toBe(0)
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
        openPopupAt('/index.html')
    })

    it('re-renders in place: initPopup runs, no worker message, no close', () => {
        vi.useFakeTimers()
        try {
            const sent = []
            globalThis.currentBrowser.runtime.sendMessage = m => {
                sent.push(m)
                return Promise.resolve()
            }
            window.close = vi.fn()

            afterLoginSuccess()

            expect(initPopupRuns()).toBe(1)
            expect(sent).toEqual([])
            vi.advanceTimersByTime(1000)
            expect(window.close).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})
