import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import {
    isSafariExtensionRuntime,
    openWebsiteSignIn,
    setAfterLoginRerender,
    signInStrategy,
} from '../popup-core.js'
import { EXT_ROOT } from './_entry-modules.mjs'

// Pins the sign-in strategy per runtime AFTER the Safari nonce/poll shim was
// removed (2026-10). Safari, like Firefox, cannot capture an in-popup OAuth
// redirect, so BOTH take the 'website' strategy: open grabcaramel.com/login
// with the provider preselected, let the user sign in there, and let the
// content-script session relay carry the token back into the extension. The
// session is therefore only ever delivered inside the user's OWN browser.
//
// The removed shim used an unauthenticated server nonce + /poll pair; this
// suite's last describe is a standing guard that the popup client never calls
// that poll endpoint again and the dead client is not reintroduced.

/* Realm stub, lifted from popup-oauth-fallback.test.mjs — permissive Proxy,
 * storage callbacks invoked, lastError undefined outside a failing callback. */
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
    for (const area of ['sync', 'session', 'local']) {
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

let createdTabs = []

beforeAll(() => {
    installChromeStub()
    initCouponConstants()
    initCaramelBase()
    initCouponRunner()
})

/** Safari: no identity API, and the extension origin carries Safari's scheme —
 * the only honest tell, since the Safari artifact IS the chrome-mv3 build put
 * through the converter and every build-time stamp still says "chrome". */
const safariShape = () => {
    globalThis.currentBrowser.identity = undefined
    globalThis.currentBrowser.chrome = undefined
    globalThis.currentBrowser.runtime.getURL = path =>
        `safari-web-extension://ABCD-1234/${path}`
    globalThis.currentBrowser.tabs.create = opts => {
        createdTabs.push(opts)
    }
}

/** Firefox: no identity API either, and a moz-extension origin. */
const firefoxShape = () => {
    globalThis.currentBrowser.identity = undefined
    globalThis.currentBrowser.chrome = undefined
    globalThis.currentBrowser.runtime.getURL = path =>
        `moz-extension://abcd-1234/${path}`
    globalThis.currentBrowser.tabs.create = opts => {
        createdTabs.push(opts)
    }
}

/** Chrome: identity present, so it keeps the in-popup wire. */
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

beforeEach(() => {
    createdTabs = []
    window.close = vi.fn()
    setAfterLoginRerender(() => {})
    globalThis.fetch = vi.fn(async url => {
        throw new Error(`no fetch expected, saw ${String(url)}`)
    })
})

describe('the sign-in strategy each runtime takes', () => {
    it('routes Safari to the website relay, NOT a separate in-popup wire', () => {
        safariShape()
        expect(isSafariExtensionRuntime()).toBe(true)
        expect(signInStrategy()).toBe('website')
    })

    it('routes Firefox to the website relay', () => {
        firefoxShape()
        expect(isSafariExtensionRuntime()).toBe(false)
        expect(signInStrategy()).toBe('website')
    })

    it('keeps Chrome on the in-popup identity wire', () => {
        chromeShape()
        expect(signInStrategy()).toBe('identity')
    })
})

describe('openWebsiteSignIn opens the login page with the provider preselected', () => {
    beforeEach(() => safariShape())

    it('forwards apple as ?provider=apple and closes the popup', () => {
        openWebsiteSignIn('apple')
        expect(createdTabs).toHaveLength(1)
        const url = new URL(createdTabs[0].url)
        expect(url.pathname).toBe('/login')
        expect(url.searchParams.get('provider')).toBe('apple')
        expect(window.close).toHaveBeenCalled()
    })

    it('forwards google as ?provider=google', () => {
        openWebsiteSignIn('google')
        const url = new URL(createdTabs[0].url)
        expect(url.searchParams.get('provider')).toBe('google')
    })

    it('opens the bare login page when no provider is given', () => {
        openWebsiteSignIn()
        const url = new URL(createdTabs[0].url)
        expect(url.pathname).toBe('/login')
        expect(url.searchParams.has('provider')).toBe(false)
    })

    it('drops a junk provider rather than putting it in the URL', () => {
        openWebsiteSignIn('evil')
        const url = new URL(createdTabs[0].url)
        expect(url.searchParams.has('provider')).toBe(false)
    })

    it('never touches an OAuth endpoint — the website relay is the whole flow', () => {
        openWebsiteSignIn('apple')
        expect(globalThis.fetch).not.toHaveBeenCalled()
    })
})

describe('the removed poll shim stays removed (standing guard)', () => {
    const source = readFileSync(join(EXT_ROOT, 'popup-core.js'), 'utf8')

    it('no longer exports the Safari nonce/poll client', async () => {
        const core = await import('../popup-core.js')
        expect(core).not.toHaveProperty('runSafariSocialSignIn')
        expect(core).not.toHaveProperty('resumeSafariOauthIfPending')
    })

    it('never calls the /poll or nonce authorize endpoints from the popup', () => {
        expect(source).not.toContain('/api/extension/oauth/poll')
        expect(source).not.toContain('nonce=')
    })
})
