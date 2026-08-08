import { beforeAll, describe, expect, it } from 'vitest'
import { loadExtensionSource, loadExtensionSources } from './_load.mjs'

// Pins the in-popup settings surface: the header gear now opens
// renderSettingsView() for EVERYONE (guests included — the checkout-prompt
// toggle matters most to signed-out users), the view persists both
// toggles through caramelSetSettings (storage.sync `caramel_settings`),
// and the savings banner totals per currency.
//
// Harness mirrors popup-settings-icon.test.mjs: real load order, one
// shared chrome stub, only the messaging transport + storage stubbed.
let initPopup
let renderSettingsView
let formatSavingsTotal
let syncData

beforeAll(() => {
    document.body.innerHTML =
        '<div id="loading-container"></div>' +
        '<button id="settingsIcon" style="display:none"></button>' +
        '<div id="auth-container"></div>'

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

    syncData = {}
    globalThis.currentBrowser.runtime.sendMessage = (message, cb) => {
        if (message?.action === 'getActiveTabDomainRecord') {
            cb({ url: 'https://www.example.com/cart' })
        } else if (message?.action === 'fetchCoupons') {
            cb({
                coupons: [{ code: 'SAVE10', title: 'Save', status: 'valid' }],
            })
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
        cb({
            caramel_savings: [
                { domain: 'a.com', code: 'A', amount: 10, currency: 'USD' },
                { domain: 'b.com', code: 'B', amount: 2.5, currency: 'USD' },
            ],
        })
    ;({ initPopup, renderSettingsView, formatSavingsTotal } =
        loadExtensionSource('popup.js', [
            'initPopup',
            'renderSettingsView',
            'formatSavingsTotal',
        ]))
})

describe('popup.js settings gear — guests included', () => {
    it('shows #settingsIcon for a GUEST in the coupons view, wired to the in-popup settings', async () => {
        await initPopup()
        expect(document.getElementById('auth-container').innerHTML).toContain(
            'Guest',
        )
        const gear = document.getElementById('settingsIcon')
        expect(gear.style.display).toBe('block')
        expect(typeof gear.onclick).toBe('function')
    })
})

describe('popup.js renderSettingsView', () => {
    it('renders both toggles and persists changes to caramel_settings', async () => {
        await renderSettingsView(null, 'www.example.com')
        const container = document.getElementById('auth-container')
        expect(container.innerHTML).toContain('Checkout prompt')
        expect(container.innerHTML).toContain('Pause on example.com')

        const autoApply = document.getElementById('autoApplyToggle')
        expect(autoApply.checked).toBe(true)
        autoApply.checked = false
        autoApply.dispatchEvent(new Event('change'))
        await new Promise(r => setTimeout(r, 0))
        expect(syncData.caramel_settings.autoApply).toBe(false)

        const site = document.getElementById('siteToggle')
        site.checked = true
        site.dispatchEvent(new Event('change'))
        await new Promise(r => setTimeout(r, 0))
        expect(syncData.caramel_settings.disabledSites).toEqual(['example.com'])
    })

    it('shows the savings banner with the per-currency total', async () => {
        await renderSettingsView(null, null)
        await new Promise(r => setTimeout(r, 0))
        const html = document.getElementById('auth-container').innerHTML
        expect(html).toContain('savings-banner')
        expect(html).toContain('12.50')
    })
})

describe('popup.js formatSavingsTotal', () => {
    it('sums per currency and never mixes them', () => {
        const out = formatSavingsTotal([
            { amount: 10, currency: 'USD' },
            { amount: 5, currency: 'EUR' },
            { amount: 2.5, currency: 'USD' },
        ])
        expect(out).toContain('12.5')
        expect(out).toContain('5')
        expect(out).toContain(' + ')
    })

    it('returns empty for no measurable savings', () => {
        expect(formatSavingsTotal([])).toBe('')
        expect(formatSavingsTotal([{ amount: 0, currency: 'USD' }])).toBe('')
    })
})
