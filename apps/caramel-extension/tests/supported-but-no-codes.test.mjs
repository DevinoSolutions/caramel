import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

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

let caramelDomainIsSupported
let sendMessage

beforeAll(() => {
    ;({ caramelDomainIsSupported } = loadExtensionSources(
        ['caramel-base.js', 'popup.js'],
        ['caramelDomainIsSupported'],
    ))
})

/** Make runtime.sendMessage answer fetchSupportedStores with `resp`. */
function withSupportedStores(resp, { lastError = null } = {}) {
    const target = globalThis.currentBrowser ?? globalThis.chrome
    target.runtime.lastError = lastError
    sendMessage = vi.fn((_msg, cb) => cb(resp))
    target.runtime.sendMessage = sendMessage
}

beforeEach(() => {
    const target = globalThis.currentBrowser ?? globalThis.chrome
    target.runtime.lastError = null
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
