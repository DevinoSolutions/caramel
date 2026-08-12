import { beforeAll, describe, expect, it } from 'vitest'
import { getOnMessageListeners, loadExtensionSource } from './_load.mjs'

// WXT-migration P0 characterization pins (2026-08-12): the worker half of the
// checkout-modal caller relay (popup half: popup-caller-relay.test.mjs).
//
// Contract under pin (background.js:267-283):
//   - openPopup from a store tab opens a POPUP WINDOW whose URL carries
//     `index.html?isPopup=true&callerId=<sender tab id>` — the query string
//     popup.js reads at module-eval time.
//   - `userLoggedInFromPopup_<id>` routes {action:'userLoggedIn'} to tab <id>
//     AS A NUMBER (the worker parses the id with split('_')[1] + parseInt —
//     which only works while the prefix contains exactly one underscore, the
//     trailing one; the round-trip test below is what breaks if anyone
//     renames the action to snake_case).

let handler

beforeAll(() => {
    loadExtensionSource('background.js', [])
    ;[handler] = getOnMessageListeners()
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
            'chrome-extension://test-ext-id/index.html?isPopup=true&callerId=42',
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
            'chrome-extension://test-ext-id/index.html?isPopup=true&callerId=',
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
