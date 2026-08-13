import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { ToastProvider } from '../entrypoints/popup/components/toast'
import type { AppApi } from '../entrypoints/popup/types'
import { SettingsView } from '../entrypoints/popup/views/SettingsView'

// The "Sync my savings" row in the popup settings view (P2-ported 2026-08-13
// to @testing-library/react).
//
// The row is a consent control, so the tests below are mostly about what it
// must NOT do: appear for someone with no account to sync to, arrive already
// switched on, or claim a change the account never accepted.
//
// The service worker's own handler is covered in savings-sync.test.mjs; here it
// is stubbed so a failing PATCH can be produced on demand.

let syncData: Record<string, any>
let localData: Record<string, any>
let sentMessages: any[]
/** What the stubbed worker answers `setSavingsSync` with. */
let patchResponse: any

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

const renderSettings = () =>
    render(
        <ToastProvider>
            <SettingsView
                user={null}
                domain="www.example.com"
                api={makeApi()}
            />
        </ToastProvider>,
    )

beforeAll(() => {
    initCouponConstants()
    const chromeStub = installChromeStub()

    chromeStub.runtime.sendMessage = (message: any, cb: any) => {
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
    chromeStub.storage.sync.get = (_keys: unknown, cb: any) =>
        cb({ ...syncData })
    chromeStub.storage.sync.set = (items: Record<string, unknown>, cb: any) => {
        Object.assign(syncData, items)
        if (cb) cb()
    }
    chromeStub.storage.local.get = (_keys: unknown, cb: any) =>
        cb({ ...localData })
    chromeStub.storage.local.set = (
        items: Record<string, unknown>,
        cb: any,
    ) => {
        Object.assign(localData, items)
        if (cb) cb()
    }
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

/** The row, once the view has read settings and session. */
const syncRow = () => screen.findByRole('switch')

describe('the sync row needs an account to sync to', () => {
    it('is hidden from a guest', async () => {
        renderSettings()

        // The rest of the settings view still serves guests, and it is what
        // proves the view finished loading before the absence is asserted.
        expect(await screen.findByText('Checkout prompt')).toBeInTheDocument()
        expect(screen.queryByRole('switch')).not.toBeInTheDocument()
        expect(screen.queryByText('Sync my savings')).not.toBeInTheDocument()
    })

    it('appears once the shopper is signed in', async () => {
        signIn()
        renderSettings()

        expect(await screen.findByText('Sync my savings')).toBeInTheDocument()
        expect(await syncRow()).toBeInTheDocument()
    })
})

describe('the row starts off, and reflects the stored preference', () => {
    it('renders unchecked for an account that never opted in', async () => {
        signIn()
        renderSettings()

        // syncSavings is consent to upload a shopping record: an absent key
        // must read as "has not opted in", never as silence-means-yes.
        expect(await syncRow()).not.toBeChecked()
    })

    it('renders checked once the preference says so', async () => {
        signIn()
        syncData.caramel_settings = { syncSavings: true }
        renderSettings()

        expect(await syncRow()).toBeChecked()
    })

    it('is a switch, with a live region to announce the change', async () => {
        signIn()
        renderSettings()

        // role="switch" makes a screen reader say on/off rather than
        // checked/unchecked — the right vocabulary for a setting.
        await syncRow()
        expect(screen.getByRole('status')).toHaveAttribute(
            'aria-live',
            'polite',
        )
    })

    it('adds no new stylesheet classes — it reuses the existing settings row', async () => {
        signIn()
        renderSettings()

        expect((await syncRow()).className).toBe('settings-switch')
    })
})

describe('turning the row on writes the account first, the device second', () => {
    it('PATCHes the account through the worker and then caches the result', async () => {
        signIn()
        renderSettings()

        await userEvent.click(await syncRow())

        await waitFor(() =>
            expect(sentMessages).toContainEqual({
                action: 'setSavingsSync',
                enabled: true,
            }),
        )
        await waitFor(() =>
            expect(syncData.caramel_settings.syncSavings).toBe(true),
        )
        expect(await syncRow()).toBeChecked()
        expect(screen.getByRole('status')).toHaveTextContent('on')
    })

    it('turns back off in one tap, with no confirmation to get past', async () => {
        signIn()
        syncData.caramel_settings = { syncSavings: true }
        patchResponse = { savingsSyncEnabled: false }
        renderSettings()

        await userEvent.click(await syncRow())

        await waitFor(() =>
            expect(syncData.caramel_settings.syncSavings).toBe(false),
        )
        expect(await syncRow()).not.toBeChecked()
    })

    it('puts the switch back and caches nothing when the account refuses', async () => {
        signIn()
        patchResponse = { error: 'HTTP 503' }
        const { container } = renderSettings()

        await userEvent.click(await syncRow())

        // The local flag is what gates every upload, so a device that cached
        // "on" here would start syncing against an account that never agreed.
        await waitFor(() =>
            expect(screen.getByRole('switch')).not.toBeChecked(),
        )
        expect(syncData.caramel_settings?.syncSavings).not.toBe(true)
        // Silently snapping back would read as a broken switch; the failure is
        // announced to the screen reader AND shown.
        expect(screen.getByRole('status')).toHaveTextContent(
            'Couldn’t change that setting. Please try again.',
        )
        expect(container.querySelector('.copy-toast')).toHaveTextContent(
            'Couldn’t change that setting. Please try again.',
        )
    })

    it('trusts the account’s answer over the tap when the two disagree', async () => {
        signIn()
        patchResponse = { savingsSyncEnabled: false }
        renderSettings()

        await userEvent.click(await syncRow())

        await waitFor(() =>
            expect(syncData.caramel_settings.syncSavings).toBe(false),
        )
        expect(await syncRow()).not.toBeChecked()
    })
})

describe('the account link points at the savings section', () => {
    it('deep-links to /profile#savings, not the top of the page', async () => {
        signIn()
        renderSettings()

        // Someone tapping this from the sync row is going to the savings
        // settings; landing at the top of a long account page is a dead drop.
        const link = await screen.findByRole('link', {
            name: /Manage account/,
        })
        expect(link.getAttribute('href')).toContain('/profile#savings')
    })

    it('is not offered to a guest, who has no account page to manage', async () => {
        renderSettings()

        expect(await screen.findByText('Checkout prompt')).toBeInTheDocument()
        expect(
            screen.queryByRole('link', { name: /Manage account/ }),
        ).not.toBeInTheDocument()
    })
})
