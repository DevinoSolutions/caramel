import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { caramelDomainIsSupported } from '../popup-core.js'

// "We have no codes for this store right now" and "we don't cover this store"
// are different facts. The popup used to branch on coupons.length alone, so a
// fully-supported store with an empty coupon list got the unsupported screen —
// heading "No coupons for this site yet", body "see the ones we support", and a
// button sending the user to a list containing the very store they were
// standing on.
//
// Found on huel.com (QA sweep 2026-08-05): supported, complete apply config,
// zero coupons. Sampling 100 supported domains put roughly 1 in 8 in the same
// state. These pin the lookup that tells the two apart.

let chromeStub
let sendMessage

/** Permissive chrome stub — the makeChromeStub/installChromeStub pair the old
 * tests/_load.mjs harness installed around every eval, inlined here now that
 * the sources are ES modules: anything not explicitly set answers with a
 * callable no-op, storage callbacks fire the way the real API does, and
 * runtime.lastError starts UNDEFINED (a permissive proxy would auto-create a
 * truthy callable, which caramel-base.js reads as a closed port). */
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
    // Installed ONCE per suite file — vitest gives each file its own jsdom
    // window, so caramel-base.js's first-run bootstrap latch is still unset and
    // this stub really becomes the realm's currentBrowser.
    initCaramelBase()
    return stub
}

beforeAll(() => {
    chromeStub = installChromeStub()
})

/** Make runtime.sendMessage answer fetchSupportedStores with `resp`. */
function withSupportedStores(resp, { lastError = null } = {}) {
    chromeStub.runtime.lastError = lastError
    sendMessage = vi.fn((_msg, cb) => cb(resp))
    chromeStub.runtime.sendMessage = sendMessage
}

beforeEach(() => {
    chromeStub.runtime.lastError = null
})

describe('caramelDomainIsSupported', () => {
    it('recognises a store we cover, so it can be told apart from one we do not', async () => {
        withSupportedStores({ supported: [{ domain: 'huel.com' }] })
        await expect(caramelDomainIsSupported('huel.com')).resolves.toBe(true)
    })

    it('does not claim to cover a store that is genuinely absent', async () => {
        withSupportedStores({ supported: [{ domain: 'huel.com' }] })
        await expect(
            caramelDomainIsSupported('en.wikipedia.org'),
        ).resolves.toBe(false)
    })

    it('ignores www. and letter case on both sides', async () => {
        // The served list really does carry mixed-case entries (eNasco.com).
        withSupportedStores({ supported: [{ domain: 'eNasco.com' }] })
        await expect(caramelDomainIsSupported('www.enasco.com')).resolves.toBe(
            true,
        )
    })

    it('treats a subdomain as covered by its parent entry', async () => {
        withSupportedStores({ supported: [{ domain: 'bombas.com' }] })
        await expect(caramelDomainIsSupported('shop.bombas.com')).resolves.toBe(
            true,
        )
    })

    it('does not match a domain that merely ends with the same letters', async () => {
        // "notbombas.com" ends with "bombas.com" as a STRING but is a different
        // registrable domain — suffix matching has to respect the dot.
        withSupportedStores({ supported: [{ domain: 'bombas.com' }] })
        await expect(caramelDomainIsSupported('notbombas.com')).resolves.toBe(
            false,
        )
    })

    it('accepts a plain string entry as well as an object', async () => {
        withSupportedStores({ supported: ['huel.com'] })
        await expect(caramelDomainIsSupported('huel.com')).resolves.toBe(true)
    })

    it('asserts nothing when the lookup fails, rather than guessing', async () => {
        // A failed lookup must leave the neutral copy standing — claiming
        // "we cover this store" on a network error would be its own lie.
        withSupportedStores({ error: 'HTTP 500' })
        await expect(caramelDomainIsSupported('huel.com')).resolves.toBe(false)

        withSupportedStores(undefined, {
            lastError: { message: 'no receiver' },
        })
        await expect(caramelDomainIsSupported('huel.com')).resolves.toBe(false)
    })

    it('handles a missing domain without calling out at all', async () => {
        withSupportedStores({ supported: [{ domain: 'huel.com' }] })
        await expect(caramelDomainIsSupported('')).resolves.toBe(false)
        await expect(caramelDomainIsSupported(null)).resolves.toBe(false)
        expect(sendMessage).not.toHaveBeenCalled()
    })
})
