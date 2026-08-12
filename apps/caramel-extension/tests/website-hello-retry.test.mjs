import { beforeEach, describe, expect, it, vi } from 'vitest'
import { caramelAnnounceToWebsite } from '../coupon-runner.js'

// Signing in on grabcaramel.com is supposed to sign you in in the extension too.
// Whether it did came down to a race nobody could see.
//
// The handshake is: the content script says "caramel-ext-hello" on our own
// origin, and a signed-in page answers with a freshly minted token. But the
// page's side is a React component (ExtensionSessionRelay), so its `message`
// listener only exists once React has hydrated — and a content script running at
// document_idle regularly beats hydration on a cold load, a slow connection, or
// simply a heavy page. One hello, sent before anyone was listening, is a hello
// nobody answers: the visitor signs in on the website, goes shopping, and the
// extension still believes they are signed out.
//
// The page already covers the mirror case (it replays a hello it heard before
// its session query resolved). This covers ours, from the side that can actually
// tell whether it worked: the token landing in storage IS the acknowledgement.
//
// Bounded on purpose. This is a courtesy handshake on our own origin, not
// something worth spending a page's life retrying.

let posted
let sleeps
let sessionToken
let caramelGetSessionImpl

// The two collaborators the handshake reads: replaced in caramel-base, where
// coupon-runner imports them from (the old globalThis stubs). Both delegate to
// per-test state because vi.mock is hoisted.
vi.mock('../caramel-base.js', async importOriginal => ({
    ...(await importOriginal()),
    sleep: async ms => {
        sleeps.push(ms)
    },
    caramelGetSession: (...args) => caramelGetSessionImpl(...args),
}))

beforeEach(() => {
    posted = []
    sleeps = []
    sessionToken = null
    caramelGetSessionImpl = async () => ({ token: sessionToken })
    window.postMessage = (msg, origin) => posted.push({ msg, origin })
})

describe('announcing ourselves to the website', () => {
    it('says hello on our own origin', async () => {
        await caramelAnnounceToWebsite()

        expect(posted[0].msg).toEqual({ type: 'caramel-ext-hello' })
        expect(posted[0].origin).toBe(location.origin)
    })

    it('says it again, because the page may not be listening yet', async () => {
        // The whole defect: hydration had not happened when we spoke.
        await caramelAnnounceToWebsite()

        expect(posted.length).toBeGreaterThan(1)
    })

    it('gives up rather than shouting forever', async () => {
        await caramelAnnounceToWebsite()

        expect(posted).toHaveLength(5)
    })

    it('waits between tries instead of firing them in one tick', async () => {
        // Five messages in the same task would land before hydration too.
        await caramelAnnounceToWebsite()

        expect(sleeps).toEqual([600, 600, 600, 600])
    })

    it('stops the moment the page answers', async () => {
        // The token landing in storage is the acknowledgement — the message
        // listener writes it as soon as the page replies.
        let calls = 0
        caramelGetSessionImpl = async () => {
            calls++
            return { token: calls > 2 ? 'tok_abc' : null }
        }

        await caramelAnnounceToWebsite()

        expect(posted).toHaveLength(2)
    })

    it('says nothing at all when we are already signed in', async () => {
        sessionToken = 'tok_abc'

        await caramelAnnounceToWebsite()

        expect(posted).toEqual([])
    })

    it('stays quiet when storage cannot tell us either way', async () => {
        // Without a readable session we could never know whether it worked, so
        // retrying would just be noise on the page.
        caramelGetSessionImpl = async () => {
            throw new Error('storage unavailable')
        }

        await caramelAnnounceToWebsite()

        expect(posted).toEqual([])
    })
})
