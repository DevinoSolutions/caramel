import { screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The popup half of the daily-active ping: opening the popup is the one
// qualifying use. Boots the REAL popup entrypoint (entrypoints/popup/main.tsx)
// and watches what it sends the worker. Pins:
//   - Google Chrome sends ONE `recordExtensionActivity`, guest or signed in;
//   - Edge, Safari (the converted Chrome build), the Firefox build and any
//     browser without the Chrome brand send nothing;
//   - the popup paints without waiting for the worker's answer.
// The worker half is tests/extension-activity.test.mjs.

type Msg = { action: string }
type Reply = (resp: unknown) => void

let sent: Msg[]
let session: Record<string, unknown>
let extensionBase: string
let answerActivity: boolean

/* One permissive chrome stub for the whole file: caramel-base.js latches the
 * first currentBrowser it sees on the (per-file) jsdom window, so each test
 * reconfigures this object instead of installing a new one. */
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
        stub.storage[area].get = (_keys: unknown, cb: any) =>
            cb?.(area === 'local' ? session : {})
        stub.storage[area].set = (_items: unknown, cb: any) => cb?.()
        stub.storage[area].remove = (_keys: unknown, cb: any) => cb?.()
    }
    stub.runtime.lastError = undefined
    stub.runtime.getURL = (path: string) => extensionBase + path
    stub.runtime.sendMessage = (msg: Msg, cb: Reply) => {
        sent.push(msg)
        if (msg.action === 'recordExtensionActivity') {
            // Never answering models a worker that is still delivering.
            if (answerActivity) cb({ outcome: 'recorded' })
            return
        }
        // No active tab: the popup resolves its "unsupported" view.
        cb({ domainRecord: null, url: null })
    }
    ;(globalThis as any).chrome = stub
    ;(window as any).chrome = stub
    ;(globalThis as any).browser = undefined
    ;(window as any).browser = undefined
}
installChromeStub()

function setBrands(names: string[] | null) {
    Object.defineProperty(navigator, 'userAgentData', {
        configurable: true,
        value: names
            ? { brands: names.map(brand => ({ brand, version: '130' })) }
            : undefined,
    })
}

async function openPopup() {
    document.body.innerHTML = '<div id="root"></div>'
    vi.resetModules()
    await act(async () => {
        await import('../entrypoints/popup/main')
    })
}

const activityMessages = () =>
    sent.filter(m => m.action === 'recordExtensionActivity')

beforeEach(() => {
    sent = []
    session = {}
    extensionBase = 'chrome-extension://caramel-test-id/'
    answerActivity = true
    vi.stubEnv('BROWSER', 'chrome')
    setBrands(['Chromium', 'Google Chrome', 'Not?A_Brand'])
})

afterEach(() => {
    vi.unstubAllEnvs()
})

describe('popup open → daily-active ping', () => {
    it('Google Chrome, guest: one recordExtensionActivity message', async () => {
        await openPopup()

        await waitFor(() => expect(activityMessages()).toHaveLength(1))
    })

    it('Google Chrome, signed in: the same single message (sign-in state is the server’s to derive)', async () => {
        session = { token: 'tok-123', user: { username: 'sam' } }

        await openPopup()

        await waitFor(() => expect(activityMessages()).toHaveLength(1))
        expect(activityMessages()[0]).toEqual({
            action: 'recordExtensionActivity',
        })
    })

    it('the popup paints without waiting on the worker’s answer', async () => {
        answerActivity = false

        await openPopup()

        await waitFor(() =>
            expect(
                screen.getByRole('img', { name: 'Caramel Logo' }),
            ).toBeInTheDocument(),
        )
        expect(activityMessages()).toHaveLength(1)
    })

    it.each([
        ['Microsoft Edge', ['Chromium', 'Microsoft Edge', 'Not?A_Brand']],
        ['Opera', ['Chromium', 'Opera', 'Not?A_Brand']],
        ['Brave', ['Chromium', 'Brave', 'Not?A_Brand']],
        ['a browser without userAgentData', null],
    ])('%s: nothing is sent', async (_label, brands) => {
        setBrands(brands)

        await openPopup()

        // The boot's own messages prove the popup ran.
        await waitFor(() => expect(sent.length).toBeGreaterThan(0))
        expect(activityMessages()).toEqual([])
    })

    it('Safari (the converted Chrome build): nothing is sent', async () => {
        extensionBase = 'safari-web-extension://caramel-test-id/'

        await openPopup()

        await waitFor(() => expect(sent.length).toBeGreaterThan(0))
        expect(activityMessages()).toEqual([])
    })

    it('the Firefox build: nothing is sent', async () => {
        vi.stubEnv('BROWSER', 'firefox')

        await openPopup()

        await waitFor(() => expect(sent.length).toBeGreaterThan(0))
        expect(activityMessages()).toEqual([])
    })
})
