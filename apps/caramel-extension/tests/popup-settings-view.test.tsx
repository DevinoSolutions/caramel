import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { App } from '../entrypoints/popup/App'
import { ToastProvider } from '../entrypoints/popup/components/toast'
import type { AppApi } from '../entrypoints/popup/types'
import { SettingsView } from '../entrypoints/popup/views/SettingsView'
import { formatSavingsTotal } from '../popup-core.js'

// Pins the in-popup settings surface (P2-ported 2026-08-13 to
// @testing-library/react): the header gear opens settings for EVERYONE (guests
// included — the checkout-prompt toggle matters most to signed-out users), the
// view persists both toggles through caramelSetSettings (storage.sync
// `caramel_settings`), and the savings banner totals per currency.
//
// P2 reshape — the gear pin was `typeof gear.onclick === 'function'` on a
// guest coupons view; the honest successor is that a guest's gear really
// reaches the settings surface, read off <App/>, which now owns the header.
let syncData: Record<string, any>

/** Permissive chrome stub — the makeChromeStub/installChromeStub pair the old
 * tests/_load.mjs harness installed around every eval: anything not explicitly
 * set answers with a callable no-op, storage callbacks fire the way the real
 * API does, and runtime.lastError starts UNDEFINED (a permissive proxy would
 * auto-create a truthy callable, which caramel-base.js reads as a closed
 * port). */
function installChromeStub() {
    const cache = new WeakMap()
    const wrap = (target: any): any => {
        if (cache.has(target)) return cache.get(target)
        const proxy = new Proxy(target, {
            get(obj: any, prop) {
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
        stub.storage[area].get = (_keys: unknown, cb: any) => {
            if (typeof cb === 'function') cb({})
        }
        stub.storage[area].set = (_items: unknown, cb: any) => {
            if (typeof cb === 'function') cb()
        }
        stub.storage[area].remove = (_keys: unknown, cb: any) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    ;(globalThis as any).chrome = stub
    ;(globalThis as any).browser = undefined
    ;(window as any).chrome = stub
    ;(window as any).browser = undefined
    // Installed ONCE per suite file — vitest gives each file its own jsdom
    // window, so caramel-base.js's first-run bootstrap latch is still unset and
    // this stub really becomes the realm's currentBrowser.
    initCaramelBase()
    return stub
}

const makeApi = (): AppApi => ({
    openSignIn: vi.fn(),
    closeOverlay: vi.fn(),
    refresh: vi.fn(),
})

const renderSettings = (domain?: string) =>
    render(
        <ToastProvider>
            <SettingsView user={null} domain={domain} api={makeApi()} />
        </ToastProvider>,
    )

beforeAll(() => {
    initCouponConstants()
    const chromeStub = installChromeStub()

    chromeStub.runtime.sendMessage = (message: any, cb: any) => {
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
    chromeStub.storage.sync.get = (_keys: unknown, cb: any) =>
        cb({ ...syncData })
    chromeStub.storage.sync.set = (items: Record<string, unknown>, cb: any) => {
        Object.assign(syncData, items)
        if (cb) cb()
    }
    chromeStub.storage.local.get = (_keys: unknown, cb: any) =>
        cb({
            caramel_savings: [
                { domain: 'a.com', code: 'A', amount: 10, currency: 'USD' },
                { domain: 'b.com', code: 'B', amount: 2.5, currency: 'USD' },
            ],
        })
})

beforeEach(() => {
    syncData = {}
})

describe('popup settings gear — guests included', () => {
    it('shows the gear for a GUEST in the coupons view, and it opens the in-popup settings', async () => {
        render(<App />)

        expect(await screen.findByText('Guest')).toBeInTheDocument()
        const gear = await screen.findByRole('button', {
            name: 'Open settings',
        })

        await userEvent.click(gear)

        expect(await screen.findByText('Checkout prompt')).toBeInTheDocument()
    })
})

describe('popup settings view', () => {
    it('renders both toggles and persists changes to caramel_settings', async () => {
        renderSettings('www.example.com')

        expect(await screen.findByText('Checkout prompt')).toBeInTheDocument()
        // www-stripped and lowercased: the label names the site the pause
        // actually covers, not the hostname the tab happened to report.
        expect(screen.getByText('Pause on example.com')).toBeInTheDocument()

        // autoApply defaults ON (absent key reads as enabled), so the first
        // interaction a user has with this row is turning it off.
        const autoApply = screen.getByRole('checkbox', {
            name: /Checkout prompt/,
        })
        expect(autoApply).toBeChecked()
        await userEvent.click(autoApply)
        await waitFor(() =>
            expect(syncData.caramel_settings.autoApply).toBe(false),
        )

        const site = screen.getByRole('checkbox', {
            name: /Pause on example\.com/,
        })
        expect(site).not.toBeChecked()
        await userEvent.click(site)
        await waitFor(() =>
            expect(syncData.caramel_settings.disabledSites).toEqual([
                'example.com',
            ]),
        )
    })

    it('offers no site toggle for a dot-less host', async () => {
        // The popup opened as its own tab/window reports a chrome-extension
        // host, which no store owns — a "Pause on <that>" row would be a
        // control with nothing behind it.
        renderSettings('extension')

        expect(await screen.findByText('Checkout prompt')).toBeInTheDocument()
        expect(screen.queryByText(/^Pause on/)).not.toBeInTheDocument()
    })

    it('reads a paused site back as paused, by exact match or subdomain', async () => {
        syncData.caramel_settings = { disabledSites: ['example.com'] }
        renderSettings('shop.example.com')

        expect(
            await screen.findByRole('checkbox', {
                name: /Pause on shop\.example\.com/,
            }),
        ).toBeChecked()
    })

    it('shows the savings banner with the per-currency total', async () => {
        const { container } = renderSettings(undefined)

        expect(await screen.findByText(/12\.50/)).toBeInTheDocument()
        expect(container.querySelector('.savings-banner')).toBeInTheDocument()
    })
})

describe('formatSavingsTotal', () => {
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
