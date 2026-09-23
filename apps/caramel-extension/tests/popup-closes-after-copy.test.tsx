import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { initBackground } from '../background.js'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { App } from '../entrypoints/popup/App'
import { CLOSE_AFTER_COPY_MS } from '../entrypoints/popup/views/CouponsView'

// Issue #249 (2026-09-17): "After copying a code, the Caramel UI stays open and
// needs to be closed manually." The popup exists to hand the shopper a code;
// once the code is on the clipboard the popup is standing between them and the
// checkout page they want to paste into. So a SUCCESSFUL copy closes the popup
// by itself, after a beat long enough for the "Copied" toast to register.
//
// The other half is the one that matters for correctness: a FAILED copy must
// NOT close, because the failure toast's text is the code itself — closing
// would take the only fallback the shopper has away with it.
//
// Same harness shape as popup-coupon-paging.test.tsx: the REAL App boots
// against the REAL background handler; only the HTTP catalog, the clipboard
// and window.close (jsdom's real close() tears the environment down) are
// stubbed at their boundaries.

const SITE = 'ebay.com'
const CATALOG = [1, 2, 3].map(n => ({
    id: String(n),
    code: `SAVE${String(n).padStart(2, '0')}`,
    title: `Deal number ${n}`,
    description: `Description ${n}`,
    status: 'valid',
}))

let chromeStub: any
let backgroundHandler: any

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
    const listeners: any[] = []
    stub.runtime.onMessage.addListener = (fn: any) => listeners.push(fn)
    stub.runtime.onMessage.removeListener = (fn: any) => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
    }
    stub.runtime.onMessage.hasListener = (fn: any) => listeners.includes(fn)
    ;(globalThis as any).chrome = stub
    ;(globalThis as any).browser = undefined
    ;(window as any).chrome = stub
    ;(window as any).browser = undefined
    initCaramelBase()
    return { stub, listeners }
}

function installCatalogFetch() {
    globalThis.fetch = (async (url: unknown) => {
        const parsed = new URL(String(url))
        if (parsed.pathname === '/api/extension/me') {
            return {
                ok: true,
                status: 200,
                json: async () => ({ username: 'tester', image: '' }),
            }
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({
                coupons: CATALOG,
                page: 1,
                limit: 20,
                total: CATALOG.length,
                hasMore: false,
            }),
        }
    }) as any
}

/** The clipboard boundary the REAL caramelCopyText reaches for first. `ok`
 *  false makes writeText reject; jsdom has no execCommand either, so the
 *  fallback fails too and caramelCopyText answers false — the failed-copy
 *  path, reached through the real function rather than a mocked one. */
function installClipboard(ok: boolean) {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
            writeText: async (text: string) => {
                if (!ok) throw new Error('clipboard blocked')
                written.push(text)
            },
        },
    })
    return written
}

/** What the toast container showed at the instant window.close was called. */
let toastAtClose: string | null = null

function installWindowClose() {
    toastAtClose = null
    const close = vi.fn(() => {
        const toast = document.querySelector('.copy-toast')
        toastAtClose = toast
            ? `${toast.textContent}${toast.classList.contains('fade-out') ? ' [fading]' : ''}`
            : null
    })
    window.close = close as any
    return close
}

async function bootPopup() {
    installCatalogFetch()
    chromeStub.runtime.sendMessage = (message: any, cb: any) => {
        if (message?.action === 'getActiveTabDomainRecord') {
            cb({ url: `https://www.${SITE}/cart` })
            return
        }
        if (message?.action === 'fetchCoupons') {
            backgroundHandler(message, {}, cb)
            return
        }
        cb(undefined)
    }
    chromeStub.storage.sync.get = (_keys: unknown, cb: any) => cb({})
    const local: Record<string, unknown> = {
        token: 'tok_close_after_copy_suite',
        user: { username: 'tester', image: '' },
    }
    chromeStub.storage.local.get = (_keys: unknown, cb: any) => cb({ ...local })
    chromeStub.storage.local.set = (
        items: Record<string, unknown>,
        cb: any,
    ) => {
        Object.assign(local, items)
        if (typeof cb === 'function') cb()
    }
    delete (globalThis as any).IntersectionObserver

    render(<App />)
    await screen.findAllByRole('button', { name: / — copy code / })
}

const card = (code: string) =>
    screen.getByRole('button', { name: new RegExp(` — copy code ${code}$`) })

beforeAll(() => {
    const installed = installChromeStub()
    chromeStub = installed.stub
    initCouponConstants()
    initBackground()
    ;[backgroundHandler] = installed.listeners
})

let closeSpy: ReturnType<typeof vi.fn>
beforeEach(() => {
    closeSpy = installWindowClose()
})
afterEach(() => {
    cleanup()
})

describe('issue #249 — the popup gets out of the way once a code is copied', () => {
    it('closes itself after a SUCCESSFUL copy, and only after the "Copied" toast had time to register', async () => {
        const written = installClipboard(true)
        await bootPopup()

        const before = Date.now()
        await userEvent.click(card('SAVE01'))

        // The code really reached the clipboard and the shopper was told so.
        await waitFor(() => expect(written).toEqual(['SAVE01']))
        await screen.findByText('Copied "SAVE01" to clipboard!')
        // ...and the popup did NOT vanish under the toast.
        expect(closeSpy).not.toHaveBeenCalled()

        await waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1), {
            timeout: CLOSE_AFTER_COPY_MS + 2000,
        })
        // The close waited its beat, and the toast was still on screen
        // (not yet fading — the fade starts at 2000ms) when it fired.
        expect(Date.now() - before).toBeGreaterThanOrEqual(CLOSE_AFTER_COPY_MS)
        expect(toastAtClose).toBe('Copied "SAVE01" to clipboard!')
    })

    it("stays OPEN when the copy FAILED, because the failure toast is the shopper's only copy of the code", async () => {
        installClipboard(false)
        await bootPopup()

        await userEvent.click(card('SAVE02'))

        await screen.findByText("Couldn't copy — code is SAVE02")
        // Wait past the success delay: a close scheduled by mistake would
        // have fired by now.
        await new Promise(resolve =>
            setTimeout(resolve, CLOSE_AFTER_COPY_MS + 400),
        )
        expect(closeSpy).not.toHaveBeenCalled()
        expect(screen.getByText("Couldn't copy — code is SAVE02")).toBeTruthy()
    })

    it('the delay is a real beat, not zero — a popup that closes before the toast paints tells the shopper nothing', () => {
        expect(CLOSE_AFTER_COPY_MS).toBeGreaterThanOrEqual(500)
        // ...and shorter than the toast's own 2000ms fade-start, so the
        // shopper leaves with the confirmation still on screen.
        expect(CLOSE_AFTER_COPY_MS).toBeLessThan(2000)
    })
})
