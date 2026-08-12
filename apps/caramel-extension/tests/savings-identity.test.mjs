import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    caramelGetSavings,
    caramelRecordSaving,
    initCaramelBase,
} from '../caramel-base.js'

// The savings history is a shopping record: store names, codes, amounts. It was
// one device-wide list, so logging out and handing the laptop to someone else
// showed them your last fifty purchases in the popup. Nobody signs out
// expecting that.
//
// Entries earned while signed in now belong to that account and come back only
// for it. Entries earned signed OUT stay visible to whoever is using the
// browser — they were earned with nobody logged in, and hiding them would make
// a guest's own savings disappear for no reason they could name.
//
// Nothing is ever deleted, which is the other half of the design: signing in
// keeps the history you built as a guest, and signing out only puts your
// account's entries away.

let storage
let chromeStub

/* Chrome, plus the storage-backing helper both lifted out of tests/_load.mjs,
 * which the ESM port retires.
 *
 * backStorageArea backs one area with a REAL object, so a test can assert on
 * what the code actually stored instead of on which API it called. Worth
 * keeping: the session (token + user) moved from storage.sync to storage.LOCAL
 * so the credential stops roaming via Chrome Sync, and every suite that had
 * hand-stubbed `sync` went red at once. Pass the SAME object for 'local' and
 * 'sync' when a test wants one merged view of storage. */
function installChromeStub() {
    const cache = new WeakMap()
    function wrap(target) {
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
    stub.runtime.lastError = undefined
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
    return stub
}

function backStorageArea(area, data = {}) {
    const store = chromeStub.storage[area]
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

beforeAll(() => {
    chromeStub = installChromeStub()
    initCaramelBase()
})

/** Signs in as `username`, or out when passed null. */
function setSession(username) {
    if (username) {
        storage.token = 'tok-' + username
        storage.user = { username }
    } else {
        delete storage.token
        delete storage.user
    }
}

beforeEach(() => {
    storage = backStorageArea('local', {})
    // caramelGetSession falls back to sync for the pre-migration adopt path.
    backStorageArea('sync', storage)
    setSession(null)
})

describe('savings history belongs to whoever earned it', () => {
    it('shows a signed-in shopper their own savings', async () => {
        setSession('ada')
        await caramelRecordSaving({
            domain: 'shop.com',
            code: 'TEN',
            amount: 10,
        })

        const list = await caramelGetSavings()
        expect(list.map(e => e.code)).toEqual(['TEN'])
    })

    it('does not show them to the next person after a sign-out', async () => {
        setSession('ada')
        await caramelRecordSaving({
            domain: 'shop.com',
            code: 'TEN',
            amount: 10,
        })
        setSession(null)

        expect(await caramelGetSavings()).toEqual([])
    })

    it('does not show one account another account’s savings', async () => {
        setSession('ada')
        await caramelRecordSaving({
            domain: 'shop.com',
            code: 'TEN',
            amount: 10,
        })
        setSession('grace')

        expect(await caramelGetSavings()).toEqual([])
    })

    it('keeps a guest’s own savings visible to that guest', async () => {
        await caramelRecordSaving({
            domain: 'shop.com',
            code: 'GUEST5',
            amount: 5,
        })

        const list = await caramelGetSavings()
        expect(list.map(e => e.code)).toEqual(['GUEST5'])
    })

    it('does not lose the history a shopper built before signing in', async () => {
        // The regression this design exists to avoid: sign in, and the running
        // total you had been watching drops to zero.
        await caramelRecordSaving({
            domain: 'shop.com',
            code: 'GUEST5',
            amount: 5,
        })
        setSession('ada')
        await caramelRecordSaving({
            domain: 'shop.com',
            code: 'TEN',
            amount: 10,
        })

        const list = await caramelGetSavings()
        expect(list.map(e => e.code).sort()).toEqual(['GUEST5', 'TEN'])
    })

    it('deletes nothing — a hidden entry is still there for its owner', async () => {
        setSession('ada')
        await caramelRecordSaving({
            domain: 'shop.com',
            code: 'TEN',
            amount: 10,
        })
        setSession('grace')
        await caramelRecordSaving({
            domain: 'shop.com',
            code: 'TWENTY',
            amount: 20,
        })
        setSession('ada')

        expect((await caramelGetSavings()).map(e => e.code)).toEqual(['TEN'])
        expect(
            (await caramelGetSavings({ all: true })).map(e => e.code),
        ).toEqual(['TWENTY', 'TEN'])
    })

    it('does not drop another account’s entries when writing a new one', async () => {
        // caramelRecordSaving reads the list before rewriting it. Reading
        // through the identity filter would quietly erase everyone else.
        setSession('ada')
        await caramelRecordSaving({
            domain: 'shop.com',
            code: 'TEN',
            amount: 10,
        })
        setSession('grace')
        await caramelRecordSaving({
            domain: 'shop.com',
            code: 'TWENTY',
            amount: 20,
        })

        const all = await caramelGetSavings({ all: true })
        expect(all.map(e => e.code).sort()).toEqual(['TEN', 'TWENTY'])
    })

    it('still refuses to record a saving that was never measured', async () => {
        setSession('ada')
        await caramelRecordSaving({
            domain: 'shop.com',
            code: 'ZERO',
            amount: 0,
        })

        expect(await caramelGetSavings({ all: true })).toEqual([])
    })
})
