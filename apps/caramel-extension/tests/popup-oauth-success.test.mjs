import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import { runSocialSignIn } from '../popup-core.js'

// Pins the popup OAuth SUCCESS path (P2-ported 2026-08-13 to runSocialSignIn
// — the wire flow extracted from the vanilla handleSocialSignIn): the
// provider code is exchanged with the state and redirectUri the backend needs
// to verify it, the returned session is persisted, a provider error means no
// exchange and no session, and the backend's own refusal reasons reach the
// user verbatim through ui.onError. Apple's half is pinned separately below —
// its server leg is genuinely different (form_post hop, JWT identity, no
// avatar ever) and had NO success-path coverage before P0.

let lastExchange
let syncData

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
    installChromeStub()
    initCouponConstants()
    initCaramelBase()
    initCouponRunner()

    globalThis.currentBrowser.tabs.create = () => {}
    window.close = vi.fn()
})

const withIdentity = callbackUrl => {
    globalThis.currentBrowser.identity = {
        launchWebAuthFlow: async () => callbackUrl,
        getRedirectURL: () => 'https://ext-id.chromiumapp.org/',
    }
    globalThis.currentBrowser.chrome = undefined
}

/** authorize → { authorizationUrl }; POST /api/extension/oauth → exchange. */
const stubBackend = (exchange = { ok: true, body: {} }) => {
    globalThis.fetch = async (url, init) => {
        if (String(url).includes('/api/extension/oauth/authorize')) {
            return {
                ok: true,
                json: async () => ({
                    authorizationUrl: 'https://accounts.google.com/o/oauth2',
                }),
            }
        }
        if (String(url).includes('/api/extension/oauth')) {
            lastExchange = {
                url: String(url),
                method: init?.method,
                body: JSON.parse(init?.body || '{}'),
            }
            return { ok: exchange.ok, json: async () => exchange.body }
        }
        return { ok: true, json: async () => ({}) }
    }
}

/** Recording ui half — what the React SignInView hands runSocialSignIn. */
const makeUi = () => {
    const rec = { errors: [] }
    return {
        rec,
        onPending: () => {},
        onError: message => {
            rec.errors.push(message)
        },
    }
}

const signIn = async (provider, ui = makeUi()) => {
    await runSocialSignIn(provider, ui)
    return ui
}

beforeEach(() => {
    lastExchange = null
    // The session is written to storage.LOCAL now, and the write also sweeps
    // the same keys out of sync to retire any pre-migration roaming copy. The
    // two areas therefore need SEPARATE backing objects — sharing one lets
    // that sweep delete the token the write just stored.
    syncData = {}
    backStorageArea('local', syncData)
    backStorageArea('sync', {})
})

describe('popup OAuth — the success path', () => {
    it('exchanges the provider code, with the state and redirect the backend needs to verify it', async () => {
        withIdentity(
            'https://ext-id.chromiumapp.org/?code=AUTH_CODE_123&state=SIGNED_STATE',
        )
        stubBackend({
            ok: true,
            body: { token: 'sess-token', username: 'aladdin', image: null },
        })

        await signIn('google')

        expect(lastExchange, 'the exchange request was made').not.toBeNull()
        expect(lastExchange.method).toBe('POST')
        expect(lastExchange.url).toMatch(/\/api\/extension\/oauth$/)
        expect(lastExchange.body).toMatchObject({
            provider: 'google',
            code: 'AUTH_CODE_123',
            // Dropping either of these silently disables the backend's ability
            // to bind the callback to the request that started it.
            state: 'SIGNED_STATE',
            redirectUri: 'https://ext-id.chromiumapp.org/',
        })
    })

    it('persists the returned session so the popup comes back signed in', async () => {
        withIdentity('https://ext-id.chromiumapp.org/?code=C&state=S')
        stubBackend({
            ok: true,
            body: { token: 'sess-token', username: 'aladdin', image: null },
        })

        await signIn('google')

        expect(syncData.token).toBe('sess-token')
        expect(syncData.user).toEqual({ username: 'aladdin', image: null })
    })

    it('never banks a session when the provider returns an error instead of a code', async () => {
        withIdentity(
            'https://ext-id.chromiumapp.org/?error=access_denied&state=S',
        )
        stubBackend()

        const ui = await signIn('google')

        expect(lastExchange, 'no code means no exchange attempt').toBeNull()
        expect(syncData.token).toBeUndefined()
        expect(ui.rec.errors[0]).toMatch(/access_denied/)
    })

    // Apple had NO success-path coverage at all — only cancel and the website
    // fallback. Its server half is genuinely different from Google's (an
    // intermediate form_post hop, a base64 {r,s} state envelope, identity read
    // out of a JWT instead of a userinfo call), and the live leg cannot be
    // driven here because no Apple ID is available. What the EXTENSION owes
    // that flow is still pinnable, and it is what these cover.
    it('sends provider=apple, so the backend picks the Apple exchange and not Google', async () => {
        withIdentity('https://ext-id.chromiumapp.org/?code=APPLE_CODE&state=S')
        stubBackend({
            ok: true,
            body: {
                token: 'apple-token',
                username: 'a@example.com',
                image: null,
            },
        })

        await signIn('apple')

        expect(lastExchange, 'the exchange request was made').not.toBeNull()
        expect(lastExchange.body).toMatchObject({
            provider: 'apple',
            code: 'APPLE_CODE',
            state: 'S',
            redirectUri: 'https://ext-id.chromiumapp.org/',
        })
    })

    it('persists an Apple session even though Apple never returns an avatar', async () => {
        // Apple is requested with scope=email only, so the server sets name to
        // null and there is no picture claim — image is ALWAYS null here. The
        // popup must store that cleanly rather than treating it as a failure.
        withIdentity('https://ext-id.chromiumapp.org/?code=C&state=S')
        stubBackend({
            ok: true,
            body: {
                token: 'apple-token',
                username: 'relay@privaterelay.appleid.com',
                image: null,
            },
        })

        await signIn('apple')

        expect(syncData.token).toBe('apple-token')
        expect(syncData.user).toEqual({
            username: 'relay@privaterelay.appleid.com',
            image: null,
        })
    })

    it("surfaces Apple's unverified-email refusal instead of a generic failure", async () => {
        // The server refuses to mint a session when Apple does not vouch for
        // the email (403). That reason is actionable, so it must reach the
        // user verbatim rather than becoming "please try again".
        withIdentity('https://ext-id.chromiumapp.org/?code=C&state=S')
        stubBackend({
            ok: false,
            body: {
                error: 'Your Apple email address is not verified. Please verify it with Apple and try again.',
            },
        })

        const ui = await signIn('apple')

        expect(syncData.token).toBeUndefined()
        expect(ui.rec.errors[0]).toMatch(/not verified/i)
    })

    it("surfaces the backend's own reason when the exchange is rejected, and stays signed out", async () => {
        withIdentity('https://ext-id.chromiumapp.org/?code=C&state=S')
        stubBackend({ ok: false, body: { error: 'Invalid OAuth state' } })

        const ui = await signIn('google')

        expect(syncData.token).toBeUndefined()
        expect(ui.rec.errors[0]).toMatch(/Invalid OAuth state/)
    })
})
