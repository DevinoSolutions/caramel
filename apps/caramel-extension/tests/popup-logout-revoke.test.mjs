import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import { initPopup } from '../popup.js'

// "Log out" used to be `storage.sync.remove(['token','user'])` and nothing
// else, in all three places it appears. The bearer it forgot locally stayed
// valid server-side for the rest of its 7-day life, so a token captured before
// logout still authenticated afterwards — and no endpoint existed that could
// have revoked it. DELETE /api/extension/session is that endpoint; this pins
// that the popup actually calls it.
//
// The second half matters as much as the first: logging out must still work
// when the revoke cannot be delivered. Someone offline who presses "log out"
// has to end up logged out on this device, so the local clear is unconditional
// — but it must not be reordered ahead of the revoke, or the token needed to
// authenticate the revoke would already be gone.
let syncData
let requests
let revokeResponse

const flush = async () => {
    for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0))
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
    // The session lives in storage.LOCAL, so that is the area whose removal
    // marks "the user is signed out on this device" — instrument it, and let
    // sync (which only ever holds a pre-migration leftover) stay empty and
    // silent so it cannot pollute the ordering assertions below.
    globalThis.currentBrowser.storage.local.get = (_keys, cb) =>
        cb({ ...syncData })
    globalThis.currentBrowser.storage.local.set = (items, cb) => {
        Object.assign(syncData, items)
        if (cb) cb()
    }
    globalThis.currentBrowser.storage.local.remove = (keys, cb) => {
        requests.push({ removedAt: requests.length, keys: [].concat(keys) })
        for (const key of [].concat(keys)) delete syncData[key]
        if (cb) cb()
    }
})

beforeEach(() => {
    syncData = { token: 'live-token', user: { username: 'fan', image: '' } }
    requests = []
    revokeResponse = { ok: true, status: 200, json: async () => ({}) }
    globalThis.fetch = async (url, init) => {
        const href = String(url)
        if (href.includes('/api/extension/session')) {
            requests.push({
                revoke: { method: init?.method, headers: init?.headers },
            })
            if (revokeResponse instanceof Error) throw revokeResponse
            return revokeResponse
        }
        // the /me probe initPopup fires in parallel
        return { ok: true, status: 200, json: async () => ({}) }
    }
})

/** Renders the signed-in popup and presses its Log out button. */
const logOut = async () => {
    await initPopup()
    await flush()
    const btn = document.getElementById('logoutBtn')
    expect(btn, 'the signed-in popup rendered a logout button').toBeTruthy()
    btn.click()
    await flush()
}

const revokeCall = () => requests.find(r => r.revoke)?.revoke
const removal = () => requests.find(r => r.keys)

describe('popup logout — revoking the session, not just forgetting it', () => {
    it('sends DELETE to /api/extension/session with the stored bearer', async () => {
        await logOut()

        expect(revokeCall(), 'a revoke request was sent').toBeTruthy()
        expect(revokeCall().method).toBe('DELETE')
        expect(revokeCall().headers.Authorization).toBe('Bearer live-token')
    })

    it('revokes BEFORE clearing storage, so the token is still there to authenticate with', async () => {
        await logOut()

        const revokeIndex = requests.findIndex(r => r.revoke)
        const removeIndex = requests.findIndex(r => r.keys)
        expect(revokeIndex).toBeGreaterThanOrEqual(0)
        expect(removeIndex).toBeGreaterThanOrEqual(0)
        expect(revokeIndex).toBeLessThan(removeIndex)
    })

    it('clears the local session once the revoke completes', async () => {
        await logOut()

        expect(removal().keys).toEqual(['token', 'user'])
        expect(syncData.token).toBeUndefined()
        expect(syncData.user).toBeUndefined()
    })

    it('still logs the user out on this device when the revoke is unreachable', async () => {
        revokeResponse = new Error('Failed to fetch')

        await logOut()

        expect(revokeCall(), 'the revoke was attempted').toBeTruthy()
        expect(
            syncData.token,
            'offline must not trap the user signed in',
        ).toBeUndefined()
    })

    it('still logs the user out when the backend rejects the revoke', async () => {
        revokeResponse = { ok: false, status: 500, json: async () => ({}) }

        await logOut()

        expect(syncData.token).toBeUndefined()
    })

    // The popup renders THREE different signed-in views, each with its own
    // logout button, and the tests above can only drive one of them. All three
    // used to clear storage directly; they now share signOutAndRevoke(). A
    // future edit that inlines the storage clear back into one of them would
    // silently restore the un-revokable session for that view alone, and no
    // behavioural test here would notice — so guard it at the source.
    it('leaves no logout path that clears the session without revoking it', () => {
        const src = readFileSync(
            join(dirname(fileURLToPath(import.meta.url)), '..', 'popup.js'),
            'utf8',
        )
        // Every token-clearing site in the popup now goes through
        // caramelClearSession(), which owns BOTH storage areas (local for the
        // session, sync only to sweep a pre-migration leftover). A raw
        // storage.*.remove of 'token' back in here would mean some path
        // re-implemented the clear — and so also skipped the revoke, or left
        // the roaming copy behind in sync.
        expect(
            src.match(/storage\.(sync|local)\.remove\(\s*\[\s*'token'/g),
            'a logout path clears the session directly instead of via caramelClearSession',
        ).toBeNull()
        expect(src).toContain('function signOutAndRevoke(')
        expect(src).toContain('caramelClearSession(')
    })
})
