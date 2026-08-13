import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import { resolvePopupState } from '../popup-core.js'

// Pins the popup's session validation: a stored token is no longer trusted
// forever. resolvePopupState() (P2 successor to initPopup — it returns the
// view instead of painting it) fires GET /api/extension/me with the bearer IN
// PARALLEL with the coupon fetch — a real 401 clears token+user from storage
// and invokes the onSessionInvalid callback (the React app's re-resolve; the
// logged-out REPAINT half of the old pin lives with the React shell's own
// suite); a 200 keeps the signed-in state (and refreshes the stored user when
// the profile changed). Network errors are NOT a logout — offline must never
// sign the user out.
//
// Harness: the popup realm's own inits in entrypoints/popup/main.tsx order,
// one shared chrome stub, only the messaging transport + storage + fetch
// stubbed.
let syncData
let meResponse
let meInit

const flush = async () => {
    for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 0))
    }
}

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
 * tests/_load.mjs). */
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

    // The realm's effects, in entrypoints/popup/main.ts order — the successor
    // to the <script> list this suite used to eval.
    installChromeStub()
    initCouponConstants()
    initCaramelBase()
    initCouponRunner()

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
})

beforeEach(() => {
    // The session lives in storage.LOCAL; sync gets its own empty object so
    // the pre-migration sweep inside caramelSetSession/ClearSession cannot
    // delete out of the same store the session was just written to.
    syncData = { token: 'tok-1', user: { username: 'caramel-fan', image: '' } }
    backStorageArea('local', syncData)
    backStorageArea('sync', {})
    meInit = null
    // Only the /me probe goes through fetch here (coupons ride the
    // sendMessage transport above); each test sets meResponse.
    globalThis.fetch = async (url, init) => {
        expect(String(url)).toContain('/api/extension/me')
        meInit = init ?? {}
        return meResponse
    }
})

const onSessionInvalid = vi.fn()

describe('popup-core resolvePopupState — stored-token validation via /api/extension/me', () => {
    beforeEach(() => {
        onSessionInvalid.mockClear()
    })

    // /api/extension/me is declared `auth: 'session'`, and better-auth's
    // session gate accepts a website COOKIE as readily as a bearer token. That
    // is only harmless because this probe never sends one: the popup runs on a
    // chrome-extension:// origin and fetch defaults to credentials:'same-origin',
    // so a signed-in website session is not attached to a cross-origin call.
    //
    // Verified in a real browser (2026-08-05): with a session cookie present on
    // the API domain, the outgoing request carried the bearer and no Cookie
    // header, and a 401 still signed the user out.
    //
    // Adding credentials:'include' here would silently break that — a revoked
    // extension token would keep passing on the website's cookie and the popup
    // could never sign anyone out. So pin the absence.
    it('authenticates with the bearer token ALONE and never opts into sending cookies', async () => {
        meResponse = { ok: true, status: 200, json: async () => ({}) }

        await resolvePopupState(onSessionInvalid)
        await flush()

        expect(meInit, 'the /me probe was made').not.toBeNull()
        expect(meInit.headers?.Authorization).toBe('Bearer tok-1')
        expect(meInit.credentials).toBeUndefined()
    })

    it('a token the backend 401s clears token+user from storage and fires the re-resolve', async () => {
        meResponse = { ok: false, status: 401 }
        await resolvePopupState(onSessionInvalid)
        await flush()
        expect(syncData.token).toBeUndefined()
        expect(syncData.user).toBeUndefined()
        // The React app registers its re-resolve here — this callback firing
        // IS what repaints the logged-out variant (the paint itself is the
        // React shell suite's pin).
        expect(onSessionInvalid).toHaveBeenCalledTimes(1)
    })

    it('a token the backend accepts (200) keeps the signed-in state and the stored token', async () => {
        meResponse = {
            ok: true,
            status: 200,
            json: async () => ({ username: 'caramel-fan', image: '' }),
        }
        const state = await resolvePopupState(onSessionInvalid)
        await flush()
        expect(syncData.token).toBe('tok-1')
        expect(state.view).toBe('coupons')
        expect(state.user).toEqual({ username: 'caramel-fan', image: '' })
        expect(onSessionInvalid).not.toHaveBeenCalled()
    })

    it('a 200 with a changed profile refreshes the stored user', async () => {
        meResponse = {
            ok: true,
            status: 200,
            json: async () => ({ username: 'renamed', image: 'pic.png' }),
        }
        await resolvePopupState(onSessionInvalid)
        await flush()
        expect(syncData.user).toEqual({ username: 'renamed', image: 'pic.png' })
        expect(syncData.token).toBe('tok-1')
    })

    it('a network failure is NOT a logout — offline keeps the stored session', async () => {
        globalThis.fetch = async () => {
            throw new TypeError('Failed to fetch')
        }
        const state = await resolvePopupState(onSessionInvalid)
        await flush()
        expect(syncData.token).toBe('tok-1')
        expect(state.view).toBe('coupons')
        expect(state.user).toEqual({ username: 'caramel-fan', image: '' })
        expect(onSessionInvalid).not.toHaveBeenCalled()
    })
})
