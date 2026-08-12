import { beforeAll, describe, expect, it } from 'vitest'

// WXT-migration P0 characterization pins (2026-08-12; URL updated to
// popup.html in P1 when WXT renamed the popup page): the worker half of the
// checkout-modal caller relay (popup half: popup-caller-relay.test.mjs).
//
// Contract under pin (background.js:267-283):
//   - openPopup from a store tab opens a POPUP WINDOW whose URL carries
//     `popup.html?isPopup=true&callerId=<sender tab id>` — the query string
//     popup.js reads at module-eval time.
//   - `userLoggedInFromPopup_<id>` routes {action:'userLoggedIn'} to tab <id>
//     AS A NUMBER (the worker parses the id with split('_')[1] + parseInt —
//     which only works while the prefix contains exactly one underscore, the
//     trailing one; the round-trip test below is what breaks if anyone
//     renames the action to snake_case).

let handler

// The worker realm background.js expects, lifted from the tests/_load.mjs
// harness this suite no longer uses. Both halves must be in place BEFORE the
// module is imported:
//
//  1. The permissive chrome Proxy — anything not explicitly set answers as a
//     callable no-op, so the API surface initBackground() touches on the way
//     past (alarms, badge styling, tab listeners) never throws. The tests
//     below overwrite the three members they assert on; because the stub is
//     one object shared with the `currentBrowser` initBackground() resolved,
//     those overwrites are what the handler calls.
//  2. ServiceWorkerGlobalScope — background.js decides AT MODULE EVAL whether
//     it is an MV3 service worker, and its non-worker fallback keep-alive is a
//     bare setInterval that holds the runner's event loop open forever. Chrome
//     and Safari really do run this file as a service worker, so the realm
//     says so and keepAlive() takes the chrome.alarms branch.
function installWorkerRealm() {
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
    // Real Chrome invokes storage callbacks (empty storage) and leaves
    // runtime.lastError undefined outside a failed callback. The bare proxy
    // does neither, which leaves getStoredToken's promise pending forever and
    // its lastError check reading a truthy auto-created no-op.
    for (const area of ['sync', 'local', 'session']) {
        stub.storage[area].get = (_keys, cb) => cb?.({})
        stub.storage[area].set = (_items, cb) => cb?.()
        stub.storage[area].remove = (_keys, cb) => cb?.()
    }
    stub.runtime.lastError = undefined
    const listeners = []
    stub.runtime.onMessage.addListener = fn => listeners.push(fn)
    globalThis.ServiceWorkerGlobalScope = {
        [Symbol.hasInstance]: () => true,
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
    return listeners
}

beforeAll(async () => {
    const listeners = installWorkerRealm()
    const { initBackground } = await import('../background.js')
    initBackground()
    ;[handler] = listeners
})

const invoke = (message, sender = {}) =>
    new Promise(resolve => {
        handler(message, sender, resolve)
    })

describe('background.js caller relay', () => {
    it('openPopup opens a popup window addressed back to the calling tab', async () => {
        const created = []
        globalThis.chrome.runtime.getURL = p =>
            'chrome-extension://test-ext-id/' + p
        globalThis.chrome.windows.create = w => created.push(w)

        const resp = await invoke({ action: 'openPopup' }, { tab: { id: 42 } })

        expect(resp).toEqual({ success: true })
        expect(created).toHaveLength(1)
        expect(created[0].url).toBe(
            'chrome-extension://test-ext-id/popup.html?isPopup=true&callerId=42',
        )
        expect(created[0].type).toBe('popup')
    })

    it('a senderless openPopup still opens, with an empty callerId (toolbar-branch popup)', async () => {
        const created = []
        globalThis.chrome.runtime.getURL = p =>
            'chrome-extension://test-ext-id/' + p
        globalThis.chrome.windows.create = w => created.push(w)

        await invoke({ action: 'openPopup' }, {})

        expect(created[0].url).toBe(
            'chrome-extension://test-ext-id/popup.html?isPopup=true&callerId=',
        )
    })

    it('userLoggedInFromPopup_<id> routes userLoggedIn to that tab, id as a NUMBER', async () => {
        const sent = []
        globalThis.chrome.tabs.sendMessage = (tabId, message) => {
            sent.push({ tabId, message })
        }

        const resp = await invoke({ action: 'userLoggedInFromPopup_42' })

        expect(resp).toEqual({ success: true })
        expect(sent).toEqual([
            { tabId: 42, message: { action: 'userLoggedIn' } },
        ])
        expect(sent[0].tabId).toBeTypeOf('number')
    })

    it('round trip: the callerId the worker MINTS survives its own parse', async () => {
        // Producer: capture the popup URL openPopup builds for tab 1337.
        const created = []
        globalThis.chrome.runtime.getURL = p =>
            'chrome-extension://test-ext-id/' + p
        globalThis.chrome.windows.create = w => created.push(w)
        await invoke({ action: 'openPopup' }, { tab: { id: 1337 } })

        // The popup reads the id off location.search (popup.js:55) and echoes
        // it back inside the action string (popup.js:61) — replicate exactly.
        const callerId = new URL(created[0].url).searchParams.get('callerId')

        // Consumer: the echoed action must land on the ORIGINAL tab.
        const sent = []
        globalThis.chrome.tabs.sendMessage = (tabId, message) => {
            sent.push({ tabId, message })
        }
        await invoke({ action: 'userLoggedInFromPopup_' + callerId })

        expect(sent).toEqual([
            { tabId: 1337, message: { action: 'userLoggedIn' } },
        ])
    })
})
