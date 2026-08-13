import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import { signOutAndRevoke } from '../popup-core.js'

// Pins the popup logout: revoking the session, not just forgetting it
// (P2-ported 2026-08-13 — the suite drives signOutAndRevoke directly; the
// vanilla render it used to click through died with popup.js, and every
// React view's Log out button calls exactly this function, which the
// source-scan pin at the bottom keeps true). Logout used to be storage-only,
// so the bearer it forgot kept authenticating for the rest of its 7-day life.
// The revoke goes out FIRST with the stored bearer; the local clear runs
// whether or not the revoke succeeded — offline must still sign this device
// out.

let syncData
let requests
let revokeResponse

const flush = async () => {
    for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 0))
    }
}

/* Realm stub, lifted from tests/_load.mjs (installChromeStub), which the ESM
 * port retires — permissive Proxy, storage callbacks invoked, lastError
 * undefined outside a failing callback (see popup-oauth-success.test.mjs for
 * the rationale block). */
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
    installChromeStub()
    initCouponConstants()
    initCaramelBase()
    initCouponRunner()

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
        return { ok: true, status: 200, json: async () => ({}) }
    }
})

/** Presses "Log out" the way every React view does: signOutAndRevoke with a
 * real button element (the busy-latch contract is pinned separately in
 * logout-feedback.test.mjs). */
const logOut = async () => {
    const button = document.createElement('button')
    button.textContent = 'Log out'
    signOutAndRevoke(() => {}, button)
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
    // logout button, and the tests above can only drive the shared function.
    // All three used to clear storage directly; they now share
    // signOutAndRevoke(). A future edit that inlines the storage clear back
    // into the logic module would silently restore the un-revokable session,
    // and no behavioural test here would notice — so guard it at the source.
    // (The React views' buttons calling signOutAndRevoke is pinned by their
    // own testing-library suites.)
    it('leaves no logout path that clears the session without revoking it', () => {
        const src = readFileSync(
            join(
                dirname(fileURLToPath(import.meta.url)),
                '..',
                'popup-core.js',
            ),
            'utf8',
        )
        // Every token-clearing site in the popup logic goes through
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
