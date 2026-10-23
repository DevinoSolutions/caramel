import { screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The popup half of the daily-active event: opening the popup is the one
// qualifying use. Boots the REAL popup entrypoint (entrypoints/popup/main.tsx)
// and watches what it sends the worker. Pins:
//   - one `recordExtensionActivity` per open, the same bare message for a
//     guest and a signed-in shopper (the popup decides nothing; Google Chrome,
//     the server flag, consent and once-a-day are the worker's, pinned in
//     tests/background-daily-active.test.mjs);
//   - the popup paints without waiting for the worker's answer.

type Msg = { action: string }
type Reply = (resp: unknown) => void

let sent: Msg[]
let session: Record<string, unknown>
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
    stub.runtime.getURL = (path: string) =>
        'chrome-extension://caramel-test-id/' + path
    stub.runtime.sendMessage = (msg: Msg, cb: Reply) => {
        sent.push(msg)
        if (msg.action === 'recordExtensionActivity') {
            // Never answering models a worker that is still delivering.
            if (answerActivity) cb({ sent: true })
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
    answerActivity = true
})

describe('popup open → daily-active event', () => {
    it('guest and signed in: the same single bare message', async () => {
        await openPopup()
        await waitFor(() => expect(activityMessages()).toHaveLength(1))
        const guest = activityMessages()[0]

        sent = []
        session = { token: 'tok-123', user: { username: 'sam' } }
        await openPopup()
        await waitFor(() => expect(activityMessages()).toHaveLength(1))

        expect(activityMessages()[0]).toEqual(guest)
        expect(guest).toEqual({ action: 'recordExtensionActivity' })
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
})
