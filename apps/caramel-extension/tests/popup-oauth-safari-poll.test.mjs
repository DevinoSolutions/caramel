import { readFileSync } from 'node:fs'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { caramelGetSession, initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import {
    isSafariExtensionRuntime,
    resumeSafariOauthIfPending,
    runSafariSocialSignIn,
    setAfterLoginRerender,
    signInStrategy,
} from '../popup-core.js'

// Pins the Safari in-popup OAuth client (restored 2026-08-14).
//
// Safari has no identity.launchWebAuthFlow, so it cannot capture an OAuth
// redirect. The shipped 1.3.x build compensated with a poll shim — nonce to
// /authorize, provider returns to OUR /redirect, poll /poll for the minted
// session — whose SERVER half is live and pinned by the app suite
// (apps/caramel-app/tests/unit/extension-oauth-safari-poll-shim.test.ts). The
// client half was lost in the pre-WXT popup rewrite, and 1.4.0 Safari silently
// fell back to openWebsiteSignIn(): a capability disappeared with every gate
// green, which is the regression class this suite exists to close.
//
// So it pins two different things. The BEHAVIOR (a Safari-shaped runtime takes
// the poll route, a success signs the popup in, a failure still leaves a way
// in) and, in the last describe, the STRUCTURE — a standing guard that fails if
// the client is deleted or unwired again, because behavior tests only catch a
// deletion if something still calls the deleted thing.

/* Realm stub, lifted from popup-oauth-fallback.test.mjs — permissive Proxy,
 * storage callbacks invoked, lastError undefined outside a failing callback.
 * The difference here: storage.local really STORES, because the pending nonce
 * surviving a closed popup is the whole point of the flow. */
let storageLocal = {}

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
    const keyList = keys =>
        Array.isArray(keys)
            ? keys
            : typeof keys === 'string'
              ? [keys]
              : Object.keys(keys || {})
    stub.storage.local.get = (keys, cb) => {
        const out = {}
        for (const key of keyList(keys))
            if (key in storageLocal) out[key] = storageLocal[key]
        if (typeof cb === 'function') cb(out)
    }
    stub.storage.local.set = (items, cb) => {
        Object.assign(storageLocal, items)
        if (typeof cb === 'function') cb()
    }
    stub.storage.local.remove = (keys, cb) => {
        for (const key of keyList(keys)) delete storageLocal[key]
        if (typeof cb === 'function') cb()
    }
    stub.runtime.lastError = undefined
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
    return stub
}

let createdTabs = []

beforeAll(() => {
    installChromeStub()
    initCouponConstants()
    initCaramelBase()
    initCouponRunner()
})

/** Safari: no identity API, and the extension origin carries Safari's scheme —
 * the only honest tell, since the Safari artifact IS the chrome-mv3 build put
 * through the converter and every build-time stamp in it still says "chrome". */
const safariShape = () => {
    globalThis.currentBrowser.identity = undefined
    globalThis.currentBrowser.chrome = undefined
    globalThis.currentBrowser.runtime.getURL = path =>
        `safari-web-extension://ABCD-1234/${path}`
    globalThis.currentBrowser.tabs.create = opts => {
        createdTabs.push(opts)
    }
}

/** Firefox: no identity API either, but a moz-extension origin — it must keep
 * the website route, NOT inherit Safari's. */
const firefoxShape = () => {
    globalThis.currentBrowser.identity = undefined
    globalThis.currentBrowser.chrome = undefined
    globalThis.currentBrowser.runtime.getURL = path =>
        `moz-extension://abcd-1234/${path}`
    globalThis.currentBrowser.tabs.create = opts => {
        createdTabs.push(opts)
    }
}

/** Chrome: identity present, so nothing about it may change. */
const chromeShape = () => {
    globalThis.currentBrowser.identity = {
        launchWebAuthFlow: async () => undefined,
        getRedirectURL: () => 'https://ext-id.chromiumapp.org/',
    }
    globalThis.currentBrowser.chrome = undefined
    globalThis.currentBrowser.runtime.getURL = path =>
        `chrome-extension://abcd-1234/${path}`
    globalThis.currentBrowser.tabs.create = opts => {
        createdTabs.push(opts)
    }
}

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/auth?x=1'

/** The session /poll hands back, shaped as the app's poll route returns it. */
const POLL_SESSION = {
    token: 'safari-session-token',
    username: 'Safari Shopper',
    image: 'https://example.com/avatar.png',
}

/**
 * A fetch that answers /authorize once and then walks /poll through a scripted
 * sequence of responses, repeating the last one forever (a poll loop asks more
 * times than a script can enumerate).
 */
function installFetch(pollScript, { authorize = { ok: true } } = {}) {
    const calls = []
    let pollIndex = 0
    globalThis.fetch = vi.fn(async url => {
        const href = String(url)
        calls.push(href)
        if (href.includes('/api/extension/oauth/authorize')) {
            if (!authorize.ok) {
                return {
                    ok: false,
                    status: authorize.status ?? 500,
                    json: async () => ({ error: authorize.error }),
                }
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ authorizationUrl: AUTHORIZATION_URL }),
            }
        }
        if (href.includes('/api/extension/oauth/poll')) {
            const step = pollScript[Math.min(pollIndex, pollScript.length - 1)]
            pollIndex += 1
            return step
        }
        throw new Error(`unexpected fetch to ${href}`)
    })
    return { calls, pollCount: () => pollIndex }
}

/** 204 — the code that keeps the client polling. */
const PENDING = { ok: false, status: 204, json: async () => ({}) }
/** 200 + a minted session. */
const DONE = { ok: true, status: 200, json: async () => POLL_SESSION }
/** 400 — the sentinel /redirect stores when the provider refuses. */
const REFUSED = {
    ok: false,
    status: 400,
    json: async () => ({ error: 'OAuth sign-in failed' }),
}

const noopUi = () => ({
    onPending: vi.fn(),
    onError: vi.fn(),
    onNotice: vi.fn(),
})

beforeEach(() => {
    createdTabs = []
    storageLocal = {}
    window.close = vi.fn()
    setAfterLoginRerender(() => {})
    vi.useRealTimers()
})

describe('the sign-in strategy each runtime takes', () => {
    it('routes Safari to the poll shim — NOT to the website redirect', () => {
        // The 1.4.0 regression in one assertion: Safari and Firefox both lack
        // launchWebAuthFlow, so a capability check alone collapses them onto
        // the website fallback and in-popup OAuth quietly disappears.
        safariShape()
        expect(isSafariExtensionRuntime()).toBe(true)
        expect(signInStrategy()).toBe('safari-poll')
        expect(signInStrategy()).not.toBe('website')
    })

    it('leaves Firefox on the website route and Chrome on the identity route', () => {
        firefoxShape()
        expect(isSafariExtensionRuntime()).toBe(false)
        expect(signInStrategy()).toBe('website')

        chromeShape()
        expect(isSafariExtensionRuntime()).toBe(false)
        expect(signInStrategy()).toBe('identity')
    })
})

describe('the Safari sign-in, from click to session', () => {
    it('carries a nonce to authorize, opens the provider in a TAB, and stores the nonce first', async () => {
        safariShape()
        const { calls } = installFetch([DONE])
        const ui = noopUi()

        await runSafariSocialSignIn('google', ui)

        const authorize = new URL(calls.find(c => c.includes('/authorize')))
        expect(authorize.searchParams.get('provider')).toBe('google')
        // redirect_uri is OURS — Safari cannot receive an extension callback.
        expect(authorize.searchParams.get('redirect_uri')).toBe(
            'https://grabcaramel.com/api/extension/oauth/redirect',
        )
        const nonce = authorize.searchParams.get('nonce')
        // 36 chars: the crypto.randomUUID() shape /poll validates.
        expect(nonce).toHaveLength(36)

        // The provider opens in a real tab, not launchWebAuthFlow.
        expect(createdTabs).toHaveLength(1)
        expect(createdTabs[0].url).toBe(AUTHORIZATION_URL)

        // The same nonce goes to /poll.
        const polled = new URL(calls.find(c => c.includes('/poll')))
        expect(polled.searchParams.get('nonce')).toBe(nonce)

        expect(ui.onNotice).toHaveBeenCalledWith(
            expect.stringContaining('new tab'),
        )
    })

    it('signs the popup in when poll returns the token, and re-renders', async () => {
        safariShape()
        installFetch([PENDING, DONE])
        const rerender = vi.fn()
        setAfterLoginRerender(rerender)
        const ui = noopUi()

        vi.useFakeTimers()
        const run = runSafariSocialSignIn('google', ui)
        // One 204, one 2s gap, then the token.
        await vi.advanceTimersByTimeAsync(2500)
        const result = await run
        vi.useRealTimers()

        expect(result.status).toBe('ok')
        const session = await caramelGetSession()
        expect(session.token).toBe(POLL_SESSION.token)
        expect(session.user).toEqual({
            username: POLL_SESSION.username,
            image: POLL_SESSION.image,
        })
        expect(rerender).toHaveBeenCalled()
        expect(ui.onError).not.toHaveBeenCalled()

        // The spent nonce is gone — nothing left for a later boot to resume.
        expect(storageLocal.pendingOauthNonce).toBeUndefined()
    })

    it('persists the pending nonce BEFORE opening the tab, so a popup Safari closes can resume', async () => {
        safariShape()
        // Never completes while the popup is open: the real Safari case, where
        // the tab takes focus and the popup dies mid-poll.
        installFetch([PENDING])
        const ui = noopUi()

        vi.useFakeTimers()
        void runSafariSocialSignIn('apple', ui)
        await vi.advanceTimersByTimeAsync(3000)

        expect(storageLocal.pendingOauthNonce).toHaveLength(36)
        expect(storageLocal.pendingOauthProvider).toBe('apple')
        expect(storageLocal.pendingOauthExpiresAt).toBeGreaterThan(Date.now())
        vi.useRealTimers()
    })
})

describe('a Safari sign-in that fails is never a dead end', () => {
    it('falls back to the website sign-in when the provider refuses', async () => {
        safariShape()
        installFetch([REFUSED])
        const ui = noopUi()

        const result = await runSafariSocialSignIn('google', ui)

        expect(result.status).toBe('error')
        expect(ui.onError).toHaveBeenCalledWith(
            expect.stringContaining('OAuth sign-in failed'),
        )
        // The user still gets a route in: the website login tab.
        const login = createdTabs.find(t => t.url.includes('/login'))
        expect(login).toBeDefined()
        expect(window.close).toHaveBeenCalled()
        // A dead nonce is not left behind for the next boot to poll.
        expect(storageLocal.pendingOauthNonce).toBeUndefined()
    })

    it('falls back when authorize itself fails, without opening a provider tab', async () => {
        safariShape()
        installFetch([], {
            authorize: { ok: false, status: 500, error: 'authorize exploded' },
        })
        const ui = noopUi()

        const result = await runSafariSocialSignIn('google', ui)

        expect(result.status).toBe('error')
        expect(createdTabs.map(t => t.url)).not.toContain(AUTHORIZATION_URL)
        expect(createdTabs.some(t => t.url.includes('/login'))).toBe(true)
    })

    it('falls back when the whole nonce TTL elapses with no answer', async () => {
        safariShape()
        installFetch([PENDING])
        const ui = noopUi()

        vi.useFakeTimers()
        const run = runSafariSocialSignIn('google', ui)
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 5000)
        const result = await run
        vi.useRealTimers()

        expect(result.status).toBe('error')
        expect(ui.onError).toHaveBeenCalled()
        expect(createdTabs.some(t => t.url.includes('/login'))).toBe(true)
        expect(storageLocal.pendingOauthNonce).toBeUndefined()
    })

    it('treats a thrown fetch as pending, not as a failure', async () => {
        // Safari drops connections while a tab takes focus. Reading that blip
        // as an error would abandon a sign-in that is still alive server-side.
        safariShape()
        let first = true
        globalThis.fetch = vi.fn(async url => {
            const href = String(url)
            if (href.includes('/authorize'))
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ authorizationUrl: AUTHORIZATION_URL }),
                }
            if (first) {
                first = false
                throw new TypeError('Load failed')
            }
            return DONE
        })
        const ui = noopUi()

        vi.useFakeTimers()
        const run = runSafariSocialSignIn('google', ui)
        await vi.advanceTimersByTimeAsync(2500)
        const result = await run
        vi.useRealTimers()

        expect(result.status).toBe('ok')
        expect(ui.onError).not.toHaveBeenCalled()
    })
})

describe('resuming a sign-in the user finished while the popup was closed', () => {
    it('is a silent no-op with nothing pending — every non-Safari boot', async () => {
        chromeShape()
        globalThis.fetch = vi.fn()

        expect(await resumeSafariOauthIfPending()).toEqual({ status: 'idle' })
        expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('collects the token stashed while the popup was gone', async () => {
        safariShape()
        storageLocal = {
            pendingOauthNonce: '3f2b1c7a-9d41-4e2f-8a55-0b6c9d1e2f30',
            pendingOauthExpiresAt: Date.now() + 4 * 60 * 1000,
            pendingOauthProvider: 'google',
        }
        const { calls } = installFetch([DONE])

        const result = await resumeSafariOauthIfPending()

        expect(result.status).toBe('ok')
        expect(calls[0]).toContain('3f2b1c7a-9d41-4e2f-8a55-0b6c9d1e2f30')
        expect((await caramelGetSession()).token).toBe(POLL_SESSION.token)
        expect(storageLocal.pendingOauthNonce).toBeUndefined()
    })

    it('KEEPS the nonce when the flow is still running, so the next open resumes it', async () => {
        // The resume budget (30s) is shorter than the TTL (5min) on purpose:
        // the popup must not hang. Clearing here would strand a live sign-in.
        safariShape()
        storageLocal = {
            pendingOauthNonce: '3f2b1c7a-9d41-4e2f-8a55-0b6c9d1e2f30',
            pendingOauthExpiresAt: Date.now() + 4 * 60 * 1000,
            pendingOauthProvider: 'google',
        }
        installFetch([PENDING])

        vi.useFakeTimers()
        const run = resumeSafariOauthIfPending()
        await vi.advanceTimersByTimeAsync(35 * 1000)
        const result = await run
        vi.useRealTimers()

        expect(result.status).toBe('pending')
        expect(storageLocal.pendingOauthNonce).toBe(
            '3f2b1c7a-9d41-4e2f-8a55-0b6c9d1e2f30',
        )
    })

    it('drops an expired nonce without polling a corpse', async () => {
        safariShape()
        storageLocal = {
            pendingOauthNonce: '3f2b1c7a-9d41-4e2f-8a55-0b6c9d1e2f30',
            pendingOauthExpiresAt: Date.now() - 1,
            pendingOauthProvider: 'google',
        }
        globalThis.fetch = vi.fn()

        expect(await resumeSafariOauthIfPending()).toEqual({
            status: 'expired',
        })
        expect(globalThis.fetch).not.toHaveBeenCalled()
        expect(storageLocal.pendingOauthNonce).toBeUndefined()
    })
})

describe('SAFARI-AWARENESS GUARD — the client cannot vanish silently again', () => {
    // Behavior suites only catch a deletion if something still calls the
    // deleted code. This capability was lost precisely because nothing did:
    // the popup rewrite dropped the client, every gate stayed green, and
    // Safari degraded to the website redirect for a full release. These
    // assertions fail on the DELETION itself.
    const read = relative =>
        readFileSync(new URL(relative, import.meta.url), 'utf8')

    it('popup-core still speaks the poll protocol the app server half pins', () => {
        const source = read('../popup-core.js')
        expect(source).toContain('/api/extension/oauth/poll')
        expect(source).toContain('/api/extension/oauth/authorize')
        expect(source).toContain('/api/extension/oauth/redirect')
        // The two exports the popup consumes.
        expect(source).toContain('export async function runSafariSocialSignIn')
        expect(source).toContain(
            'export async function resumeSafariOauthIfPending',
        )
    })

    it('the sign-in view still ROUTES Safari to it', () => {
        // Wiring, not just existence: an unreferenced client is the same
        // outage with extra code.
        const source = read('../entrypoints/popup/views/SignInView.tsx')
        expect(source).toContain('runSafariSocialSignIn')
        expect(source).toContain('signInStrategy')
    })

    it('the popup still resumes a pending sign-in at boot', () => {
        const source = read('../entrypoints/popup/App.tsx')
        expect(source).toContain('resumeSafariOauthIfPending')
    })

    it('every strategy the router can return has a live branch in the view', () => {
        // Three strategies, three routes. A fourth added without wiring it —
        // or a branch quietly deleted — fails here.
        const core = read('../popup-core.js')
        const view = read('../entrypoints/popup/views/SignInView.tsx')
        const returned = [...core.matchAll(/return '([a-z-]+)'/g)]
            .map(m => m[1])
            .filter(s => ['identity', 'safari-poll', 'website'].includes(s))
        expect(new Set(returned)).toEqual(
            new Set(['identity', 'safari-poll', 'website']),
        )
        expect(view).toContain("=== 'website'")
        expect(view).toContain("=== 'safari-poll'")
        expect(view).toContain('runSocialSignIn')
    })
})
