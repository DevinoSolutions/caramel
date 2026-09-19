import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    CARAMEL_PRESENCE_ATTRIBUTE,
    caramelStampPresence,
} from '../coupon-runner.js'

// The website must never say "get the extension" to a browser that is
// running it (fleet growth-prompts spec §A). The sign-in hello could not
// carry that job: it only fires while the extension has NO session, so the
// signed-in extension user — the most common one — looked exactly like a
// visitor without it. This stamp is unconditional.

let posted
let manifestImpl

vi.mock('../caramel-base.js', async importOriginal => ({
    ...(await importOriginal()),
    currentBrowser: {
        runtime: {
            getManifest: () => manifestImpl(),
        },
    },
    logError: () => {},
}))

beforeEach(() => {
    posted = []
    manifestImpl = () => ({ version: '1.4.1' })
    window.postMessage = (msg, origin) => posted.push({ msg, origin })
    document.documentElement.removeAttribute(CARAMEL_PRESENCE_ATTRIBUTE)
})

afterEach(() => {
    document.documentElement.removeAttribute(CARAMEL_PRESENCE_ATTRIBUTE)
})

describe('stamping our presence on the website', () => {
    it('marks <html> with the installed version', () => {
        caramelStampPresence()

        expect(
            document.documentElement.getAttribute(CARAMEL_PRESENCE_ATTRIBUTE),
        ).toBe('1.4.1')
    })

    it('tells the page too, on our own origin only', () => {
        caramelStampPresence()

        expect(posted).toEqual([
            {
                msg: { type: 'caramel-ext-present', version: '1.4.1' },
                origin: location.origin,
            },
        ])
    })

    it('still stamps when the manifest cannot be read', () => {
        // Presence is the fact the site needs; the version is a nicety.
        manifestImpl = () => {
            throw new Error('runtime gone')
        }

        caramelStampPresence()

        expect(
            document.documentElement.hasAttribute(CARAMEL_PRESENCE_ATTRIBUTE),
        ).toBe(true)
        expect(posted[0].msg.type).toBe('caramel-ext-present')
    })
})
