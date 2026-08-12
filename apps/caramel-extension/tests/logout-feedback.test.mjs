import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { signOutAndRevoke } from '../popup.js'

// Logging out revokes the session server-side — a real network round-trip. The
// popup showed nothing while it ran: the button stayed live, the view didn't
// change, so on a slow connection the natural thing to do is press "Log out"
// again. That fires a second revoke of a token the first call is already
// killing, and the user still has no idea whether anything happened.
//
// The revoke itself is not what's under test here (session-revoke is pinned
// elsewhere). This is about the seconds the user spends waiting.

let resolveRevoke
let revokeCalls

/* Realm stub, lifted from tests/_load.mjs (installChromeStub), which the ESM
 * port retires. Permissive Proxy: any unknown property materializes as a
 * callable no-op, so a source file touching an API this suite doesn't care
 * about cannot abort it. Two deliberate exceptions, exactly as _load.mjs had
 * them — storage.*.get/set/remove invoke their callbacks like the real API
 * (empty storage), and runtime.lastError stays UNDEFINED outside a failing
 * callback, because the proxy would otherwise auto-create a truthy callable
 * that caramelSendMessage reads as a closed port. */
function installChromeStub() {
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
    for (const area of ['sync', 'local', 'session']) {
        stub.storage[area].get = (_keys, cb) => {
            if (typeof cb === 'function') cb({})
        }
        stub.storage[area].set = (_items, cb) => {
            if (typeof cb === 'function') cb()
        }
        stub.storage[area].remove = (_keys, cb) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
    return stub
}

/** Backs one storage area with a real object, so a test can assert on what the
 * code actually stored instead of on which API it called (lifted from
 * tests/_load.mjs). Pass the SAME object for 'local' and 'sync' when a test
 * wants one merged view of storage. */
function backStorageArea(area, data = {}) {
    const store = (globalThis.currentBrowser ?? globalThis.chrome).storage[area]
    store.get = (_keys, cb) => {
        if (typeof cb === 'function') cb({ ...data })
    }
    store.set = (items, cb) => {
        Object.assign(data, items)
        if (typeof cb === 'function') cb()
    }
    store.remove = (keys, cb) => {
        for (const key of [].concat(keys)) delete data[key]
        if (typeof cb === 'function') cb()
    }
    return data
}

beforeAll(() => {
    document.body.innerHTML =
        '<div id="loading-container"></div>' +
        '<button id="settingsIcon" style="display:none"></button>' +
        '<div id="auth-container"></div>'

    // signOutAndRevoke only needs the base realm up — currentBrowser for the
    // session storage it clears (the old load list was caramel-base.js alone).
    installChromeStub()
    initCaramelBase()
    window.close = vi.fn() // jsdom's real close() tears down the environment
})

beforeEach(() => {
    const stored = backStorageArea('local', { token: 'tok', user: null })
    backStorageArea('sync', stored)
    revokeCalls = 0
    globalThis.fetch = () => {
        revokeCalls++
        // Deliberately left hanging: this IS the slow connection.
        return new Promise(resolve => {
            resolveRevoke = () => resolve({ ok: true, status: 200 })
        })
    }
})

/** Lets queued promise callbacks run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('popup.js signOutAndRevoke — the wait is visible', () => {
    it('tells the user it is signing them out', async () => {
        const button = document.createElement('button')
        button.textContent = 'Log out'

        signOutAndRevoke(() => {}, button)
        await settle()

        expect(button.textContent).toMatch(/signing out/i)
    })

    it('stops taking presses while the revoke is in flight', async () => {
        const button = document.createElement('button')
        button.textContent = 'Log out'

        signOutAndRevoke(() => {}, button)
        await settle()
        expect(revokeCalls).toBe(1)

        // The impatient second press.
        signOutAndRevoke(() => {}, button)
        await settle()

        expect(button.disabled).toBe(true)
        expect(revokeCalls).toBe(1)
    })

    it('still finishes the sign-out once the revoke returns', async () => {
        const button = document.createElement('button')
        let done = false

        signOutAndRevoke(() => {
            done = true
        }, button)
        await settle()
        expect(done).toBe(false)

        resolveRevoke()
        await settle()
        await settle()

        expect(done).toBe(true)
    })

    it('works when no button is passed', async () => {
        // Not every caller has one, and a missing button must not break the
        // one thing this function must always do.
        let done = false

        signOutAndRevoke(() => {
            done = true
        })
        await settle()
        resolveRevoke()
        await settle()
        await settle()

        expect(done).toBe(true)
    })
})
