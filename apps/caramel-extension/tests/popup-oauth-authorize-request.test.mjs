import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { CARAMEL_ENV } from '../caramel-env.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import { runSocialSignIn, setAfterLoginRerender } from '../popup-core.js'

// WXT-migration P0 characterization pins (2026-08-12; P2-ported 2026-08-13 to
// runSocialSignIn — the wire flow extracted from the vanilla
// handleSocialSignIn, DOM replaced by the {onPending,onError} ui callbacks):
// the REQUEST half of the popup OAuth flow. popup-oauth-success/cancel pin
// the response half; what THIS suite pins is what we SEND — the authorize
// URL's shape, that the redirect_uri is identity.getRedirectURL()'s output
// (encoded), that the provider window is launched interactive and with the
// backend's own authorizationUrl — plus the authorize-hop failure branches,
// the resolve-undefined cancel, the session-write lastError path, and the
// visibility gate on re-render. Button enable/disable states moved to the
// React SignInView suite (it consumes onPending/onError).

/* caramelSetSession is the one collaborator a test swaps (the lastError
 * path); the factory delegates to whatever `stubs.caramelSetSession` holds
 * and falls back to the real writer — every other test starts real. */
const stubs = vi.hoisted(() => ({
    caramelSetSession: null,
}))

vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        // `currentBrowser` is a live binding that initCaramelBase() assigns;
        // a plain spread would freeze its pre-init `undefined`.
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelSetSession: (...args) =>
            (stubs.caramelSetSession ?? actual.caramelSetSession)(...args),
    }
})

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

/** The React app's registered re-resolve, observed instead of performed. */
const rerender = vi.fn()

beforeAll(() => {
    installChromeStub()
    initCouponConstants()
    initCaramelBase()
    initCouponRunner()

    globalThis.currentBrowser.tabs.create = () => {}
    window.close = vi.fn()
    setAfterLoginRerender(rerender)
})

const REDIRECT = 'https://ext-id.chromiumapp.org/'

/** identity present; launchWebAuthFlow behaviour injected, calls recorded. */
const withIdentity = launchWebAuthFlow => {
    const launches = []
    globalThis.currentBrowser.identity = {
        launchWebAuthFlow: args => {
            launches.push(args)
            return launchWebAuthFlow(args)
        },
        getRedirectURL: () => REDIRECT,
    }
    globalThis.currentBrowser.chrome = undefined
    return launches
}

/** Recording fetch: authorize GET then (optionally) the exchange POST. */
const recordFetch = ({
    authorize = {
        ok: true,
        json: async () => ({
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        }),
    },
    exchange = {
        ok: true,
        json: async () => ({ token: 'tok', username: 'ada', image: null }),
    },
} = {}) => {
    const calls = []
    globalThis.fetch = async (url, opts) => {
        calls.push({ url: String(url), opts })
        return String(url).includes('/api/extension/oauth/authorize')
            ? authorize
            : exchange
    }
    return calls
}

/** Recording ui half — what the React SignInView hands runSocialSignIn. */
const makeUi = () => {
    const rec = { pending: 0, errors: [] }
    return {
        rec,
        onPending: () => {
            rec.pending += 1
        },
        onError: message => {
            rec.errors.push(message)
        },
    }
}

beforeEach(() => {
    stubs.caramelSetSession = null
    rerender.mockClear()
    recordFetch()
})

describe('popup OAuth — the authorize request we send', () => {
    it('builds the authorize URL from the env base, the clicked provider, and the ENCODED getRedirectURL() output, then launches the backend-issued URL interactively', async () => {
        const calls = recordFetch()
        // Provider window stays open: the request half is fully observable
        // without ever settling the flow.
        const launches = withIdentity(() => new Promise(() => {}))
        const ui = makeUi()

        runSocialSignIn('google', ui)
        await new Promise(r => setTimeout(r, 0))
        await new Promise(r => setTimeout(r, 0))

        expect(ui.rec.pending).toBe(1)
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe(
            `${CARAMEL_ENV.baseUrl}/api/extension/oauth/authorize?provider=google&redirect_uri=${encodeURIComponent(REDIRECT)}`,
        )
        expect(launches).toEqual([
            {
                url: 'https://accounts.google.com/o/oauth2/v2/auth',
                interactive: true,
            },
        ])
    })

    it('sends provider=apple for the Apple button, same URL grammar', async () => {
        const calls = recordFetch()
        withIdentity(() => new Promise(() => {}))

        runSocialSignIn('apple', makeUi())
        await new Promise(r => setTimeout(r, 0))
        await new Promise(r => setTimeout(r, 0))

        expect(calls[0].url).toBe(
            `${CARAMEL_ENV.baseUrl}/api/extension/oauth/authorize?provider=apple&redirect_uri=${encodeURIComponent(REDIRECT)}`,
        )
    })

    it("surfaces the backend's own error when the authorize hop answers non-ok, and never launches a window", async () => {
        recordFetch({
            authorize: {
                ok: false,
                status: 503,
                json: async () => ({ error: 'OAuth backend down' }),
            },
        })
        const launches = withIdentity(() => new Promise(() => {}))
        const ui = makeUi()

        await runSocialSignIn('google', ui)

        expect(ui.rec.errors).toEqual([
            'OAuth sign-in failed: OAuth backend down',
        ])
        expect(launches).toEqual([])
    })

    it('treats a 200 with no authorizationUrl as a failure, not a launch of `undefined`', async () => {
        recordFetch({ authorize: { ok: true, json: async () => ({}) } })
        const launches = withIdentity(() => new Promise(() => {}))
        const ui = makeUi()

        await runSocialSignIn('google', ui)

        expect(ui.rec.errors[0]).toMatch(
            /Failed to get OAuth authorization URL/,
        )
        expect(launches).toEqual([])
    })
})

describe('popup OAuth — settle paths the response suites never reach', () => {
    it('an engine that RESOLVES undefined on window-close still reads as a cancel', async () => {
        // Chrome rejects instead (pinned in popup-oauth-cancel.test.mjs); the
        // !finalCallbackUrl guard covers engines that resolve undefined.
        withIdentity(async () => undefined)
        const ui = makeUi()

        await runSocialSignIn('google', ui)

        expect(ui.rec.errors).toEqual(['Sign-in was cancelled.'])
    })

    it('a session write that fails via chrome.runtime.lastError surfaces the reason and stays signed out', async () => {
        withIdentity(async () => `${REDIRECT}?code=CODE123&state=S1`)
        // Real chrome semantics: lastError is set only inside the failing
        // callback.
        stubs.caramelSetSession = (_session, cb) => {
            globalThis.chrome.runtime.lastError = { message: 'disk full' }
            cb()
            globalThis.chrome.runtime.lastError = undefined
        }
        const ui = makeUi()

        await runSocialSignIn('google', ui)

        expect(ui.rec.errors).toEqual(['OAuth sign-in failed: disk full'])
        expect(rerender).not.toHaveBeenCalled()
    })

    it('a popup already hidden (no caller) banks the session but does not re-render', async () => {
        withIdentity(async () => `${REDIRECT}?code=CODE123&state=S1`)
        const local = backStorageArea('local', {})
        backStorageArea('sync', {})
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'hidden',
        })

        try {
            await runSocialSignIn('google', makeUi())
            await vi.waitFor(() => expect(local.token).toBe('tok'))
            // The 100ms settle delay has already elapsed once the token is
            // visible; the visibility gate must have skipped the re-render.
            expect(rerender).not.toHaveBeenCalled()
        } finally {
            delete document.visibilityState
        }
    })
})
