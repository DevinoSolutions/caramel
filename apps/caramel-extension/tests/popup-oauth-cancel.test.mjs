import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import { runSocialSignIn } from '../popup-core.js'

// Pins the cancel-vs-failure mapping of the popup OAuth flow (P2-ported
// 2026-08-13 to runSocialSignIn): closing the provider window is a CANCEL,
// not a failure. Chrome REJECTS launchWebAuthFlow with its own third-person
// wording ("The user did not approve access.") — that must reach the user as
// 'Sign-in was cancelled.', while a genuine failure keeps its real reason.
//
// The button-state halves of the old suite (both providers disabled in
// flight, only the clicked one reading 'Redirecting...', both re-enabled
// after a cancel) are VIEW behavior now — the React SignInView suite pins
// them through the onPending/onError callbacks this suite drives directly.

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
    globalThis.currentBrowser.tabs.create = () => {}
    window.close = vi.fn()
})

const withIdentity = launchWebAuthFlow => {
    globalThis.currentBrowser.identity = {
        launchWebAuthFlow,
        getRedirectURL: () => 'https://ext-id.chromiumapp.org/',
    }
    globalThis.currentBrowser.chrome = undefined
}

const stubAuthorizeEndpoint = () => {
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        }),
    })
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
    stubAuthorizeEndpoint()
})

describe('popup OAuth — closing the provider window', () => {
    it('calls a cancel a cancel, not a failure, when Chrome rejects with its own wording', async () => {
        withIdentity(async () => {
            throw new Error('The user did not approve access.')
        })
        const ui = makeUi()

        await runSocialSignIn('google', ui)

        expect(ui.rec.errors).toEqual(['Sign-in was cancelled.'])
        expect(ui.rec.errors[0]).not.toMatch(/failed/i)
        expect(ui.rec.errors[0]).not.toMatch(/did not approve/i)
    })

    it('still reports a GENUINE failure as a failure', async () => {
        withIdentity(async () => {
            throw new Error('Network request failed')
        })
        const ui = makeUi()

        await runSocialSignIn('google', ui)

        expect(ui.rec.errors[0]).toMatch(/OAuth sign-in failed/)
        expect(ui.rec.errors[0]).toMatch(/Network request failed/)
    })

    it('a cancel settles the flow through onError — the view re-enables both providers there', async () => {
        // The DOM half (both buttons re-enabled, labels restored) is pinned in
        // the React SignInView suite; what the wire owes it is exactly one
        // onPending at the start and exactly one onError on the cancel — no
        // path that leaves the flow neither settled nor erred.
        withIdentity(async () => {
            throw new Error('cancelled')
        })
        const ui = makeUi()

        await runSocialSignIn('apple', ui)

        expect(ui.rec.pending).toBe(1)
        expect(ui.rec.errors).toEqual(['Sign-in was cancelled.'])
    })

    it('an in-flight flow has fired onPending and nothing else', async () => {
        // Models a provider window sitting open: the view keeps both buttons
        // disabled until onError settles it (pinned there); the wire's half is
        // that onPending fired once and NO error arrived while pending.
        withIdentity(() => new Promise(() => {}))
        const ui = makeUi()

        runSocialSignIn('google', ui)
        await new Promise(r => setTimeout(r, 0))
        await new Promise(r => setTimeout(r, 0))

        expect(ui.rec.pending).toBe(1)
        expect(ui.rec.errors).toEqual([])
    })
})
