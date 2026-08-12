// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://grabcaramel.com/"}
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponRunner } from '../coupon-runner.js'

// Pins the website→extension sign-in relay (content-script side), which
// runs only on our own origins (CARAMEL_ALLOWED_ORIGINS):
//   1. session-less extension announces itself: window.postMessage
//      {type:'caramel-ext-hello'} to the page, same-origin target.
//   2. the page (signed in) answers with {token, username, image}; the
//      "message" listener stores it in storage.sync — but ONLY from an
//      allowlisted origin.
// The jsdom URL above puts this realm on https://grabcaramel.com, the one
// production origin in the allowlist.
//
// Load note: the relay reads caramel-base.js's CARAMEL_ALLOWED_ORIGINS from
// coupon-runner.js. Under the old harness that lookup was the fragile part —
// per-file `(0, eval)` did not carry a top-level const across files, so the
// suite had to concatenate the sources into one script. It is an import now,
// and the listener registration it exercises lives in initCouponRunner().
let stored
let posted

/* The realm's chrome. Lifted from tests/_load.mjs, which the ESM port retires:
 * caramel-base and coupon-runner touch more of the API at session time than a
 * hand-enumerated stub would cover, so anything unknown is a callable no-op. */
function installChromeStub() {
    const cache = new WeakMap()
    function wrap(target) {
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
    }
    stub.runtime.lastError = undefined
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
    return stub
}

beforeAll(() => {
    posted = []
    stored = null
    window.postMessage = vi.fn((data, target) => {
        posted.push({ data, target })
    })

    const chromeStub = installChromeStub()
    // The relayed session is stored in storage.LOCAL (it is a full website
    // session token and must not roam via Chrome Sync). Both areas answer an
    // empty read, so the extension still considers itself session-less and
    // sends the hello that starts the relay.
    chromeStub.storage.local.get = (_keys, cb) => cb({})
    chromeStub.storage.sync.get = (_keys, cb) => cb({})
    chromeStub.storage.local.set = (items, cb) => {
        stored = items
        if (cb) cb()
    }

    initCaramelBase()
    initCouponRunner()
})

describe('coupon-runner.js website→extension session relay', () => {
    it('announces itself with caramel-ext-hello on its own origin when no token is stored', () => {
        // The hello fires from the (synchronous, stubbed) storage.sync.get
        // callback during load above.
        const hello = posted.find(p => p.data?.type === 'caramel-ext-hello')
        expect(hello).toBeTruthy()
        expect(hello.target).toBe('https://grabcaramel.com')
    })

    it('stores a token posted from the page (allowlisted origin)', async () => {
        window.dispatchEvent(
            new MessageEvent('message', {
                origin: 'https://grabcaramel.com',
                data: { token: 'relayed-token', username: 'tester', image: '' },
            }),
        )
        await new Promise(r => setTimeout(r, 0))
        expect(stored).toMatchObject({
            token: 'relayed-token',
            user: { username: 'tester' },
        })
    })

    it('ignores a token posted from a foreign origin', async () => {
        stored = null
        window.dispatchEvent(
            new MessageEvent('message', {
                origin: 'https://evil.example.com',
                data: { token: 'stolen-session', username: 'attacker' },
            }),
        )
        await new Promise(r => setTimeout(r, 0))
        expect(stored).toBeNull()
    })
})
