import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    caramelClearSession,
    caramelGetSession,
    caramelGetSettings,
    caramelSetSession,
    caramelSetSettings,
    initCaramelBase,
} from '../caramel-base.js'

// The extension's bearer is a FULL website session token, not an
// extension-scoped one. It used to live in chrome.storage.sync, which Chrome
// Sync replicates to Google's servers and back down to every Chrome profile
// signed into the same Google account — so the credential roamed far past the
// machine that signed in, and a second machine sharing the Chrome profile
// inherited a live session it never authenticated for.
//
// It now lives in storage.LOCAL. Settings deliberately stay in sync: a
// preference SHOULD roam, a credential should not.
//
// The migration is the risky half of that change — done wrong it silently
// signs out every existing user, or leaves the roaming copy behind while
// looking fixed. It is lazy and self-healing: the first read adopts whatever
// sync still holds and deletes it there.
let local
let synced

const backAreas = () => {
    for (const [area, data] of [
        ['local', local],
        ['sync', synced],
    ]) {
        const store = globalThis.currentBrowser.storage[area]
        store.get = (_keys, cb) => cb({ ...data })
        store.set = (items, cb) => {
            Object.assign(data, items)
            if (cb) cb()
        }
        store.remove = (keys, cb) => {
            for (const key of [].concat(keys)) delete data[key]
            if (cb) cb()
        }
    }
}

// initCaramelBase() publishes the resolved browser object as
// window.currentBrowser, which is the seam backAreas() writes through. It runs
// once: the bootstrap's double-load guard makes a second call keep the FIRST
// browser object, so per-test freshness comes from new local/synced maps.
beforeAll(() => {
    globalThis.chrome = { storage: { local: {}, sync: {} } }
    initCaramelBase()
})

beforeEach(() => {
    local = {}
    synced = {}
    backAreas()
})

describe('session storage — local, never Chrome Sync', () => {
    it('writes a new session to local and leaves nothing in sync', async () => {
        await new Promise(resolve =>
            caramelSetSession(
                { token: 'tok', user: { username: 'a', image: null } },
                resolve,
            ),
        )

        expect(local.token).toBe('tok')
        expect(
            synced.token,
            'a credential in sync is replicated to every profile on the account',
        ).toBeUndefined()
    })

    it('reads back what it stored', async () => {
        await new Promise(resolve =>
            caramelSetSession(
                { token: 'tok', user: { username: 'a', image: null } },
                resolve,
            ),
        )

        expect(await caramelGetSession()).toEqual({
            token: 'tok',
            user: { username: 'a', image: null },
        })
    })

    describe('users who installed BEFORE the move', () => {
        beforeEach(() => {
            // Exactly the old shape: session in sync, nothing in local.
            synced.token = 'legacy-tok'
            synced.user = { username: 'legacy', image: null }
        })

        it('adopts the synced session instead of signing the user out', async () => {
            const session = await caramelGetSession()

            expect(
                session.token,
                'an upgrade must not log existing users out',
            ).toBe('legacy-tok')
            expect(session.user).toEqual({ username: 'legacy', image: null })
            expect(local.token).toBe('legacy-tok')
        })

        it('stops the roaming copy replicating, by deleting it from sync', async () => {
            await caramelGetSession()

            expect(
                synced.token,
                'leaving it in sync means the credential keeps roaming',
            ).toBeUndefined()
            expect(synced.user).toBeUndefined()
        })

        it('is idempotent — a second read serves local and finds sync already clean', async () => {
            await caramelGetSession()
            const again = await caramelGetSession()

            expect(again.token).toBe('legacy-tok')
            expect(synced.token).toBeUndefined()
        })

        it('a fresh login sweeps the stale synced credential away', async () => {
            // Someone who signs in again before ever triggering a read must not
            // be left with the old token still roaming.
            await new Promise(resolve =>
                caramelSetSession(
                    { token: 'new-tok', user: { username: 'a', image: null } },
                    resolve,
                ),
            )

            expect(local.token).toBe('new-tok')
            expect(synced.token).toBeUndefined()
        })
    })

    it('signing out clears BOTH areas, so no copy survives anywhere', async () => {
        local.token = 'tok'
        local.user = { username: 'a', image: null }
        synced.token = 'legacy-tok'
        synced.user = { username: 'legacy', image: null }

        await new Promise(resolve => caramelClearSession(resolve))

        expect(local.token).toBeUndefined()
        expect(synced.token).toBeUndefined()
        expect(await caramelGetSession()).toEqual({ token: null, user: null })
    })

    it('reports a signed-out user rather than throwing when storage is empty', async () => {
        expect(await caramelGetSession()).toEqual({ token: null, user: null })
    })

    it('leaves user SETTINGS roaming in sync, which is the whole point of the split', async () => {
        await caramelSetSettings({ autoApply: false })

        expect(
            Object.keys(synced),
            'preferences should still follow the user between machines',
        ).toContain('caramel_settings')
        expect((await caramelGetSettings()).autoApply).toBe(false)
    })
})
