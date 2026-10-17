import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import { INSTALL_ATTRIBUTION_KEY } from '../install-attribution.js'
import { runSocialSignIn, setAfterLoginRerender } from '../popup-core.js'

// A sign-in from the extension used to reach the server with no idea where the
// install came from. The sign-in now hands over what the install stored
// (install-attribution.js): { iid, firstTouch } in the code-exchange body.
// Safari and Firefox sign in on the website instead (popup-core.js
// openWebsiteSignIn), where /welcome already tied the install to that
// browser's PostHog person. Old installs (nothing stored) send exactly what
// they always did.

const IID = '3f2b8c1e-5a47-4d6b-9e10-7c2d4a8b9f01'
const FIRST_TOUCH = {
    utm_source: 'reddit',
    referrer_domain: 'reddit.com',
    landing_path: '/',
    captured_at: '2026-10-01T12:00:00.000Z',
}

let storageLocal
let lastExchange

const keyList = keys =>
    Array.isArray(keys)
        ? keys
        : typeof keys === 'string'
          ? [keys]
          : Object.keys(keys || {})

/* Realm stub, same shape as popup-oauth-safari-website.test.mjs: permissive
 * Proxy, callbacks invoked, storage.local really stores. */
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
    for (const area of ['sync', 'session']) {
        stub.storage[area].get = (_keys, cb) => cb?.({})
        stub.storage[area].set = (_items, cb) => cb?.()
        stub.storage[area].remove = (_keys, cb) => cb?.()
    }
    stub.storage.local.get = (keys, cb) => {
        const out = {}
        for (const key of keyList(keys))
            if (key in storageLocal) out[key] = storageLocal[key]
        cb?.(out)
    }
    stub.storage.local.set = (items, cb) => {
        Object.assign(storageLocal, items)
        cb?.()
    }
    stub.storage.local.remove = (keys, cb) => {
        for (const key of keyList(keys)) delete storageLocal[key]
        cb?.()
    }
    stub.runtime.lastError = undefined
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
    return stub
}

beforeAll(() => {
    installChromeStub()
    initCouponConstants()
    initCaramelBase()
    initCouponRunner()
    window.close = vi.fn()
})

beforeEach(() => {
    storageLocal = {}
    lastExchange = null
    setAfterLoginRerender(() => {})
})

const chromeShape = () => {
    globalThis.currentBrowser.identity = {
        launchWebAuthFlow: async () =>
            'https://ext-id.chromiumapp.org/?code=AUTH_CODE&state=SIGNED_STATE',
        getRedirectURL: () => 'https://ext-id.chromiumapp.org/',
    }
    globalThis.currentBrowser.chrome = undefined
    globalThis.currentBrowser.runtime.getURL = path =>
        `chrome-extension://abcd-1234/${path}`
    globalThis.currentBrowser.tabs.create = () => {}
}

const installFetch = () => {
    globalThis.fetch = vi.fn(async (url, init) => {
        const href = String(url)
        if (href.includes('/api/extension/oauth/authorize')) {
            return {
                ok: true,
                json: async () => ({
                    authorizationUrl: 'https://accounts.google.com/o/oauth2',
                }),
            }
        }
        if (href.endsWith('/api/extension/oauth')) {
            lastExchange = JSON.parse(init.body)
            return {
                ok: true,
                json: async () => ({ token: 't', username: 'u', image: null }),
            }
        }
        throw new Error(`unexpected fetch to ${href}`)
    })
}

const noUi = () => ({ onPending: vi.fn(), onError: vi.fn(), onNotice: vi.fn() })

describe('the code exchange (Chrome, Edge)', () => {
    it('carries the install id and the first-touch record the install stored', async () => {
        chromeShape()
        installFetch()
        storageLocal[INSTALL_ATTRIBUTION_KEY] = {
            iid: IID,
            firstTouch: FIRST_TOUCH,
        }

        await runSocialSignIn('google', noUi())

        expect(lastExchange).toEqual({
            provider: 'google',
            code: 'AUTH_CODE',
            state: 'SIGNED_STATE',
            redirectUri: 'https://ext-id.chromiumapp.org/',
            iid: IID,
            firstTouch: FIRST_TOUCH,
        })
    })

    it('an install that only has its id (never reached /welcome) sends just that', async () => {
        chromeShape()
        installFetch()
        storageLocal[INSTALL_ATTRIBUTION_KEY] = { iid: IID }

        await runSocialSignIn('google', noUi())

        expect(lastExchange.iid).toBe(IID)
        expect(lastExchange).not.toHaveProperty('firstTouch')
    })

    it('an older install (nothing stored) sends exactly the body it always did', async () => {
        chromeShape()
        installFetch()

        await runSocialSignIn('google', noUi())

        expect(lastExchange).toEqual({
            provider: 'google',
            code: 'AUTH_CODE',
            state: 'SIGNED_STATE',
            redirectUri: 'https://ext-id.chromiumapp.org/',
        })
    })

    it('unreadable storage does not stop the sign-in: it goes ahead without attribution, and says so', async () => {
        chromeShape()
        installFetch()
        const realGet = globalThis.currentBrowser.storage.local.get
        globalThis.currentBrowser.storage.local.get = (_keys, cb) => {
            globalThis.currentBrowser.runtime.lastError = new Error('boom')
            cb({})
            globalThis.currentBrowser.runtime.lastError = undefined
        }
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        const ui = noUi()
        try {
            await runSocialSignIn('google', ui)
        } finally {
            globalThis.currentBrowser.storage.local.get = realGet
        }

        expect(ui.onError).not.toHaveBeenCalled()
        expect(lastExchange).not.toHaveProperty('iid')
        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining('Install attribution unreadable'),
            expect.anything(),
        )
        consoleError.mockRestore()
    })
})
