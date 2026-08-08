import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    backStorageArea,
    loadExtensionSource,
    loadExtensionSources,
} from './_load.mjs'

// Logging out revokes the session server-side — a real network round-trip. The
// popup showed nothing while it ran: the button stayed live, the view didn't
// change, so on a slow connection the natural thing to do is press "Log out"
// again. That fires a second revoke of a token the first call is already
// killing, and the user still has no idea whether anything happened.
//
// The revoke itself is not what's under test here (session-revoke is pinned
// elsewhere). This is about the seconds the user spends waiting.

let signOutAndRevoke
let resolveRevoke
let revokeCalls

beforeAll(() => {
    document.body.innerHTML =
        '<div id="loading-container"></div>' +
        '<button id="settingsIcon" style="display:none"></button>' +
        '<div id="auth-container"></div>'

    loadExtensionSource('coupon-constants.generated.js', [])
    loadExtensionSources(['caramel-base.js'], [])
    window.close = vi.fn() // jsdom's real close() tears down the environment
    ;({ signOutAndRevoke } = loadExtensionSource('popup.js', [
        'signOutAndRevoke',
    ]))
})

beforeEach(() => {
    const stored = backStorageArea('local', { token: 'tok', user: null })
    backStorageArea('sync', stored)
    revokeCalls = 0
    globalThis.fetch = () => {
        revokeCalls++
        // Deliberately left hanging: this IS the slow connection.
        return new Promise(resolve => {
            resolveRevoke = () => resolve({ ok: true, status: 200 })
        })
    }
})

/** Lets queued promise callbacks run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('popup.js signOutAndRevoke — the wait is visible', () => {
    it('tells the user it is signing them out', async () => {
        const button = document.createElement('button')
        button.textContent = 'Log out'

        signOutAndRevoke(() => {}, button)
        await settle()

        expect(button.textContent).toMatch(/signing out/i)
    })

    it('stops taking presses while the revoke is in flight', async () => {
        const button = document.createElement('button')
        button.textContent = 'Log out'

        signOutAndRevoke(() => {}, button)
        await settle()
        expect(revokeCalls).toBe(1)

        // The impatient second press.
        signOutAndRevoke(() => {}, button)
        await settle()

        expect(button.disabled).toBe(true)
        expect(revokeCalls).toBe(1)
    })

    it('still finishes the sign-out once the revoke returns', async () => {
        const button = document.createElement('button')
        let done = false

        signOutAndRevoke(() => {
            done = true
        }, button)
        await settle()
        expect(done).toBe(false)

        resolveRevoke()
        await settle()
        await settle()

        expect(done).toBe(true)
    })

    it('works when no button is passed', async () => {
        // Not every caller has one, and a missing button must not break the
        // one thing this function must always do.
        let done = false

        signOutAndRevoke(() => {
            done = true
        })
        await settle()
        resolveRevoke()
        await settle()
        await settle()

        expect(done).toBe(true)
    })
})
