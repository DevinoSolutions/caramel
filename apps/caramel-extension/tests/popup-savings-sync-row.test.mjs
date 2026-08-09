import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSource, loadExtensionSources } from './_load.mjs'

// The "Sync my savings" row in the popup settings view.
//
// The row is a consent control, so the tests below are mostly about what it
// must NOT do: appear for someone with no account to sync to, arrive already
// switched on, or claim a change the account never accepted.
//
// Harness mirrors popup-settings-view.test.mjs — real load order, one shared
// chrome stub, only the worker transport and storage stubbed. The service
// worker's own handler is covered separately in savings-sync.test.mjs; here it
// is stubbed so a failing PATCH can be produced on demand.

let renderSettingsView
let syncData
let localData
let sentMessages
/** What the stubbed worker answers `setSavingsSync` with. */
let patchResponse

beforeAll(() => {
    document.body.innerHTML =
        '<div id="loading-container"></div>' +
        '<button id="settingsIcon" style="display:none"></button>' +
        '<div id="auth-container"></div>' +
        '<div id="toastContainer"></div>'

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

    globalThis.currentBrowser.runtime.sendMessage = (message, cb) => {
        sentMessages.push(message)
        if (message?.action === 'getActiveTabDomainRecord') {
            cb({ url: 'https://www.example.com/cart' })
        } else if (message?.action === 'setSavingsSync') {
            cb(patchResponse)
        } else if (message?.action === 'syncSavings') {
            cb({ accepted: 0, duplicates: 0, stored: [], rejected: [] })
        } else {
            cb(undefined)
        }
    }
    globalThis.currentBrowser.storage.sync.get = (_keys, cb) =>
        cb({ ...syncData })
    globalThis.currentBrowser.storage.sync.set = (items, cb) => {
        Object.assign(syncData, items)
        if (cb) cb()
    }
    globalThis.currentBrowser.storage.local.get = (_keys, cb) =>
        cb({ ...localData })
    globalThis.currentBrowser.storage.local.set = (items, cb) => {
        Object.assign(localData, items)
        if (cb) cb()
    }
    ;({ renderSettingsView } = loadExtensionSource('popup.js', [
        'renderSettingsView',
    ]))
})

beforeEach(() => {
    syncData = {}
    localData = {}
    sentMessages = []
    patchResponse = { savingsSyncEnabled: true }
})

function signIn() {
    localData.token = 'tok-ada'
    localData.user = { username: 'ada' }
}

function settingsHtml() {
    return document.getElementById('auth-container').innerHTML
}

/** Lets the toggle's async handler settle. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('the sync row needs an account to sync to', () => {
    it('is hidden from a guest', async () => {
        await renderSettingsView(null, 'www.example.com')
        expect(document.getElementById('syncSavingsToggle')).toBeNull()
        expect(settingsHtml()).not.toContain('Sync my savings')
        // The rest of the settings view still serves guests.
        expect(settingsHtml()).toContain('Checkout prompt')
    })

    it('appears once the shopper is signed in', async () => {
        signIn()
        await renderSettingsView(null, 'www.example.com')
        expect(settingsHtml()).toContain('Sync my savings')
        expect(document.getElementById('syncSavingsToggle')).not.toBeNull()
    })
})

describe('the row starts off, and reflects the stored preference', () => {
    it('renders unchecked for an account that never opted in', async () => {
        signIn()
        await renderSettingsView(null, 'www.example.com')
        expect(document.getElementById('syncSavingsToggle').checked).toBe(false)
    })

    it('renders checked once the preference says so', async () => {
        signIn()
        syncData.caramel_settings = { syncSavings: true }
        await renderSettingsView(null, 'www.example.com')
        expect(document.getElementById('syncSavingsToggle').checked).toBe(true)
    })

    it('is a switch, with a live region to announce the change', async () => {
        signIn()
        await renderSettingsView(null, 'www.example.com')
        const toggle = document.getElementById('syncSavingsToggle')
        // role="switch" makes a screen reader say on/off rather than
        // checked/unchecked — the right vocabulary for a setting.
        expect(toggle.getAttribute('role')).toBe('switch')
        const status = document.getElementById('syncSavingsStatus')
        expect(status.getAttribute('aria-live')).toBe('polite')
    })

    it('adds no new stylesheet classes — it reuses the existing settings row', async () => {
        signIn()
        await renderSettingsView(null, 'www.example.com')
        expect(document.getElementById('syncSavingsToggle').className).toBe(
            'settings-switch',
        )
    })
})

describe('turning the row on writes the account first, the device second', () => {
    it('PATCHes the account through the worker and then caches the result', async () => {
        signIn()
        await renderSettingsView(null, 'www.example.com')

        const toggle = document.getElementById('syncSavingsToggle')
        toggle.checked = true
        toggle.dispatchEvent(new Event('change'))
        await flush()

        expect(sentMessages).toContainEqual({
            action: 'setSavingsSync',
            enabled: true,
        })
        expect(syncData.caramel_settings.syncSavings).toBe(true)
        expect(toggle.checked).toBe(true)
        expect(
            document.getElementById('syncSavingsStatus').textContent,
        ).toContain('on')
    })

    it('turns back off in one tap, with no confirmation to get past', async () => {
        signIn()
        syncData.caramel_settings = { syncSavings: true }
        patchResponse = { savingsSyncEnabled: false }
        await renderSettingsView(null, 'www.example.com')

        const toggle = document.getElementById('syncSavingsToggle')
        toggle.checked = false
        toggle.dispatchEvent(new Event('change'))
        await flush()

        expect(syncData.caramel_settings.syncSavings).toBe(false)
        expect(toggle.checked).toBe(false)
    })

    it('puts the switch back and caches nothing when the account refuses', async () => {
        signIn()
        patchResponse = { error: 'HTTP 503' }
        await renderSettingsView(null, 'www.example.com')

        const toggle = document.getElementById('syncSavingsToggle')
        toggle.checked = true
        toggle.dispatchEvent(new Event('change'))
        await flush()

        // The local flag is what gates every upload, so a device that cached
        // "on" here would start syncing against an account that never agreed.
        expect(syncData.caramel_settings?.syncSavings).not.toBe(true)
        expect(toggle.checked).toBe(false)
    })

    it('trusts the account’s answer over the tap when the two disagree', async () => {
        signIn()
        patchResponse = { savingsSyncEnabled: false }
        await renderSettingsView(null, 'www.example.com')

        const toggle = document.getElementById('syncSavingsToggle')
        toggle.checked = true
        toggle.dispatchEvent(new Event('change'))
        await flush()

        expect(toggle.checked).toBe(false)
        expect(syncData.caramel_settings.syncSavings).toBe(false)
    })
})

describe('the account link points at the savings section', () => {
    it('deep-links to /profile#savings, not the top of the page', async () => {
        signIn()
        await renderSettingsView(null, 'www.example.com')
        const link = document.getElementById('accountLink')
        // Someone tapping this from the sync row is going to the savings
        // settings; landing at the top of a long account page is a dead drop.
        expect(link.getAttribute('href')).toContain('/profile#savings')
    })
})
