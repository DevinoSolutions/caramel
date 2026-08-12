import { beforeAll, describe, expect, it, vi } from 'vitest'
import { loadExtensionSource, loadExtensionSources } from './_load.mjs'

// WXT-migration P0 characterization pins (2026-08-12): the checkout-modal
// caller relay had ZERO coverage, and it is exactly the seam the React/WXT
// popup rewrite disturbs — CARAMEL_CALLER_ID is read from location.search AT
// MODULE-EVALUATION TIME (popup.js:55), and its failure mode is silent: the
// modal's "Sign In" flow simply never resumes in the originating tab.
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
// popup.js is evaluated per describe-block with the URL already in place,
// because the id is captured at eval time — a pin in itself: set the URL
// after load and the relay silently degrades to the toolbar branch.

const POPUP_DOM =
    '<div id="loading-container"></div>' +
    '<button id="settingsIcon" style="display:none"></button>' +
    '<div id="auth-container"></div>'

const loadPopupAt = urlPath => {
    history.replaceState(null, '', urlPath)
    document.body.innerHTML = POPUP_DOM
    loadExtensionSource('coupon-constants.generated.js', [])
    loadExtensionSources(
        [
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
        ],
        [],
    )
    window.close = vi.fn()
    return loadExtensionSource('popup.js', ['afterLoginSuccess'])
        .afterLoginSuccess
}

describe('caller relay — popup opened by the checkout modal (?callerId=42)', () => {
    let afterLoginSuccess

    beforeAll(() => {
        afterLoginSuccess = loadPopupAt('/index.html?isPopup=true&callerId=42')
    })

    it('notifies the worker with userLoggedInFromPopup_<callerId> and closes ~150ms later, without re-rendering', () => {
        vi.useFakeTimers()
        try {
            const sent = []
            globalThis.currentBrowser.runtime.sendMessage = m => {
                sent.push(m)
                return Promise.resolve()
            }
            globalThis.initPopup = vi.fn()
            window.close = vi.fn()

            afterLoginSuccess()

            // The exact action string is the wire contract: background.js
            // parses the id with split('_')[1], so the prefix must keep its
            // single trailing underscore and contain no other one.
            expect(sent).toEqual([{ action: 'userLoggedInFromPopup_42' }])
            expect(globalThis.initPopup).not.toHaveBeenCalled()

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
            globalThis.initPopup = vi.fn()
            window.close = vi.fn()

            expect(() => afterLoginSuccess()).not.toThrow()

            vi.advanceTimersByTime(150)
            expect(window.close).toHaveBeenCalledTimes(1)
            expect(globalThis.initPopup).not.toHaveBeenCalled()
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
    let afterLoginSuccess

    beforeAll(() => {
        afterLoginSuccess = loadPopupAt('/index.html')
    })

    it('re-renders in place: initPopup runs, no worker message, no close', () => {
        vi.useFakeTimers()
        try {
            const sent = []
            globalThis.currentBrowser.runtime.sendMessage = m => {
                sent.push(m)
                return Promise.resolve()
            }
            globalThis.initPopup = vi.fn()
            window.close = vi.fn()

            afterLoginSuccess()

            expect(globalThis.initPopup).toHaveBeenCalledTimes(1)
            expect(sent).toEqual([])
            vi.advanceTimersByTime(1000)
            expect(window.close).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})
