import { beforeEach, describe, expect, it } from 'vitest'
import {
    backStorageArea,
    getOnMessageListeners,
    loadExtensionSources,
} from './_load.mjs'

// Opt-in cloud savings sync, end to end inside the extension: caramel-base.js
// records and queues, caramelSendMessage crosses into the REAL background.js
// onMessage listener, and background.js makes the fetch. Nothing between the
// money path and the network is stubbed out — only the network itself, by a
// fake that enforces the same UNIQUE(client_event_id) the table does, so
// "retrying doesn't duplicate" is something these tests can actually observe.
//
// The three behaviours worth stating plainly, because each is a promise made
// to the shopper in the UI copy:
//   * OFF by default, and off means NOTHING leaves the device.
//   * Sync starts from when it was turned on — earlier savings stay local.
//   * A saving earned signed OUT belongs to the device, not to whoever signs
//     in next.

let base
let localData
let fetchCalls
/** Stands in for savings_events, unique on client_event_id like the real one. */
let serverRows
let accountSyncEnabled
let serverDown

/* Backs ONE storage area, with ONE data object, on BOTH chrome stubs this
 * realm ends up holding.
 *
 * caramel-base.js pins `window.currentBrowser` on its first load and guards the
 * assignment with `window.__caramel_shared_utils_loaded` — a window flag that
 * survives every reload inside a jsdom file. So from the SECOND test onward
 * caramel-base keeps the stub installed for the first test, while background.js
 * (`const currentBrowser = chrome`) binds the freshly installed one. They are
 * two different objects with two different storages.
 *
 * Backing only the one _load.mjs's helper targets left the other reading empty
 * storage, and the symptom was pointed: settings and history worked, while the
 * worker's getStoredToken() found no token and sent every request unauthorized —
 * a signed-in fixture producing signed-out traffic, only when the file ran as a
 * whole. Sharing one data object between both stubs is also what a real browser
 * has: one storage, many references. */
function backStorageEverywhere(area, data) {
    const pinned = globalThis.currentBrowser
    const fresh = globalThis.chrome
    backStorageArea(area, data)
    if (fresh && fresh !== pinned) {
        globalThis.currentBrowser = fresh
        backStorageArea(area, data)
        globalThis.currentBrowser = pinned
    }
    return data
}

function loadRealm() {
    base = loadExtensionSources(
        ['caramel-base.js', 'background.js'],
        [
            'caramelGetSettings',
            'caramelSetSettings',
            'caramelGetSavings',
            'caramelRecordSaving',
            'caramelSyncSavings',
        ],
    )
    // Real Chrome leaves this undefined on success; the permissive stub would
    // auto-create a truthy callable that caramelSendMessage reads as a dead port.
    globalThis.chrome.runtime.lastError = undefined
    globalThis.currentBrowser.runtime.lastError = undefined

    localData = backStorageEverywhere('local', {})
    // Settings live here; the tests drive them through caramelSetSettings
    // rather than by poking the object, so the handle is not kept.
    backStorageEverywhere('sync', {})

    // The real transport: content script / popup → service worker.
    globalThis.currentBrowser.runtime.sendMessage = (message, callback) => {
        let answered = false
        for (const listener of getOnMessageListeners()) {
            listener(message, {}, response => {
                if (answered) return
                answered = true
                callback(response)
            })
        }
    }
}

function installFakeServer() {
    fetchCalls = []
    serverRows = []
    // The ACCOUNT-side consent column, and the ingest route enforces it (a
    // device setting is a cache, not a gate). Defaults to consented because
    // that is the state every other test in this file is implicitly in: the
    // real popup switch PATCHes the account before it writes the device
    // setting, so "device on, account off" is a stale-device anomaly, not the
    // normal path. The describe that cares flips it deliberately.
    accountSyncEnabled = true
    serverDown = false

    globalThis.fetch = async (url, opts = {}) => {
        const href = String(url)
        fetchCalls.push({ url: href, opts })

        if (serverDown) {
            return { ok: false, status: 503, json: async () => ({}) }
        }

        // Checked BEFORE the ingest path: '/api/account/savings-sync' also
        // contains '/api/account/savings'.
        if (href.includes('/api/account/savings-sync')) {
            accountSyncEnabled = !!JSON.parse(opts.body).enabled
            return {
                ok: true,
                status: 200,
                json: async () => ({ savingsSyncEnabled: accountSyncEnabled }),
            }
        }

        if (href.includes('/api/account/savings')) {
            // Consent is checked server-side, per request, before a single
            // event is looked at — same as the real route.
            if (!accountSyncEnabled) {
                return {
                    ok: false,
                    status: 403,
                    json: async () => ({ error: 'savings_sync_disabled' }),
                }
            }
            const { events } = JSON.parse(opts.body)
            const storedIds = []
            const rejected = []
            let accepted = 0
            events.forEach((event, index) => {
                if (!(event.amountCents > 0)) {
                    rejected.push({
                        index,
                        clientEventId: event.clientEventId,
                        reason: 'amountCents: too small',
                    })
                    return
                }
                const already = serverRows.some(
                    row => row.clientEventId === event.clientEventId,
                )
                if (!already) {
                    serverRows.push(event)
                    accepted++
                }
                storedIds.push(event.clientEventId)
            })
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    accepted,
                    duplicates: storedIds.length - accepted,
                    stored: storedIds,
                    rejected,
                }),
            }
        }

        return { ok: true, status: 200, json: async () => ({}) }
    }
}

/** Signs in, or out when passed null. */
function setSession(username) {
    if (username) {
        localData.token = 'tok-' + username
        localData.user = { username }
    } else {
        delete localData.token
        delete localData.user
    }
}

function ingestCalls() {
    return fetchCalls.filter(
        call =>
            call.url.includes('/api/account/savings') &&
            !call.url.includes('savings-sync'),
    )
}

/** The events one ingest request carried. */
function pushedEvents(index = 0) {
    return JSON.parse(ingestCalls()[index].opts.body).events
}

async function stored() {
    return await base.caramelGetSavings({ all: true })
}

/* Records a saving and settles the push it triggers.
 *
 * caramelRecordSaving deliberately does NOT await the upload — the money path
 * must never wait on a network round-trip to show a shopper their result — so
 * a test that asserted straight after it would be racing the request. It does
 * fire the push synchronously before returning, and caramelSyncSavings hands
 * back the in-flight promise rather than starting a second one, so awaiting it
 * here settles that same push instead of inventing a new one. */
async function record(entry) {
    await base.caramelRecordSaving(entry)
    await base.caramelSyncSavings()
}

beforeEach(() => {
    loadRealm()
    installFakeServer()
})

describe('savings sync is off until the shopper turns it on', () => {
    it('defaults the device setting to off', async () => {
        expect((await base.caramelGetSettings()).syncSavings).toBe(false)
    })

    it('uploads nothing while it is off, even for a signed-in shopper', async () => {
        setSession('ada')
        await record({
            domain: 'shop.com',
            code: 'TEN',
            amount: 10,
        })

        expect(ingestCalls()).toHaveLength(0)
        const list = await stored()
        expect(list).toHaveLength(1)
        expect(list[0].syncPending).toBeUndefined()
        expect(list[0].synced).toBeUndefined()
    })

    it('an explicit sweep while off still uploads nothing', async () => {
        setSession('ada')
        await record({
            domain: 'shop.com',
            code: 'TEN',
            amount: 10,
        })

        expect(await base.caramelSyncSavings()).toMatchObject({
            skipped: 'sync-off',
        })
        expect(ingestCalls()).toHaveLength(0)
    })
})

describe('a signed-out shopper behaves exactly as before', () => {
    beforeEach(async () => {
        await base.caramelSetSettings({ syncSavings: true })
        setSession(null)
    })

    it('records the saving locally and uploads nothing', async () => {
        await record({
            domain: 'shop.com',
            code: 'GUEST5',
            amount: 5,
        })

        expect(ingestCalls()).toHaveLength(0)
        const list = await stored()
        expect(list).toHaveLength(1)
        expect(list[0].u).toBeUndefined()
        expect(list[0].syncPending).toBeUndefined()
    })

    it('still shows the guest their own savings', async () => {
        await record({
            domain: 'shop.com',
            code: 'GUEST5',
            amount: 5,
        })
        expect((await base.caramelGetSavings()).map(e => e.code)).toEqual([
            'GUEST5',
        ])
    })

    it('never uploads that guest saving once someone signs in afterwards', async () => {
        await record({
            domain: 'shop.com',
            code: 'GUEST5',
            amount: 5,
        })
        setSession('ada')

        await base.caramelSyncSavings()
        expect(ingestCalls()).toHaveLength(0)
        expect(serverRows).toHaveLength(0)
    })
})

describe('with sync on and an account, a win is pushed as it happens', () => {
    beforeEach(async () => {
        await base.caramelSetSettings({ syncSavings: true })
        setSession('ada')
    })

    it('sends one event carrying everything the account record needs', async () => {
        await record({
            domain: 'shop.com',
            code: 'TEN',
            amount: 12.5,
            currency: 'GBP',
            couponId: 'coupon-99',
            t: Date.parse('2026-08-09T10:30:00.000Z'),
        })

        expect(ingestCalls()).toHaveLength(1)
        const events = pushedEvents()
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
            store: 'shop.com',
            code: 'TEN',
            couponId: 'coupon-99',
            // Integer minor units on the wire — a lifetime total is not summed
            // from 2-decimal floats.
            amountCents: 1250,
            currency: 'GBP',
            occurredAt: '2026-08-09T10:30:00.000Z',
        })
        expect(typeof events[0].clientEventId).toBe('string')
        expect(events[0].clientEventId.length).toBeGreaterThan(8)
    })

    it('goes out with the account bearer, through the service worker', async () => {
        await record({
            domain: 'shop.com',
            code: 'TEN',
            amount: 10,
        })
        expect(ingestCalls()[0].opts.headers.Authorization).toBe(
            'Bearer tok-ada',
        )
        expect(ingestCalls()[0].opts.method).toBe('POST')
    })

    it('marks the entry synced only after the server confirms it', async () => {
        await record({
            domain: 'shop.com',
            code: 'TEN',
            amount: 10,
        })
        const list = await stored()
        expect(list[0].synced).toBe(true)
        expect(serverRows).toHaveLength(1)
    })

    it('sends a code-less automatic discount as an empty code, not a dropped event', async () => {
        await record({
            domain: 'shop.com',
            code: '',
            amount: 4,
        })
        expect(pushedEvents()[0].code).toBe('')
        expect(serverRows).toHaveLength(1)
    })

    it('does not upload another account’s queued entries', async () => {
        await record({
            domain: 'shop.com',
            code: 'ADA',
            amount: 10,
        })
        setSession('grace')
        await record({
            domain: 'shop.com',
            code: 'GRACE',
            amount: 20,
        })

        const graceBatch = pushedEvents(1)
        expect(graceBatch.map(e => e.code)).toEqual(['GRACE'])
    })
})

describe('a failed push is retried, and the retry cannot duplicate', () => {
    beforeEach(async () => {
        await base.caramelSetSettings({ syncSavings: true })
        setSession('ada')
    })

    it('leaves the entry queued when the server is unreachable', async () => {
        serverDown = true
        await record({
            domain: 'shop.com',
            code: 'TEN',
            amount: 10,
        })

        const list = await stored()
        expect(list[0].synced).toBeUndefined()
        expect(list[0].syncPending).toBe(true)
        expect(serverRows).toHaveLength(0)
    })

    it('retries the SAME clientEventId, so the row is written exactly once', async () => {
        serverDown = true
        await record({
            domain: 'shop.com',
            code: 'TEN',
            amount: 10,
        })
        const idAtFirstAttempt = (await stored())[0].clientEventId

        serverDown = false
        await base.caramelSyncSavings()
        // A third attempt, as a popup catch-up sweep would make.
        await base.caramelSyncSavings()

        const idAfterRetries = (await stored())[0].clientEventId
        expect(idAfterRetries).toBe(idAtFirstAttempt)
        // The id is what makes the replay safe — regenerating it per attempt
        // would write one row per retry.
        expect(serverRows).toHaveLength(1)
        expect(serverRows[0].clientEventId).toBe(idAtFirstAttempt)
        expect((await stored())[0].synced).toBe(true)
    })

    it('a sweep with nothing queued makes no request at all', async () => {
        await record({
            domain: 'shop.com',
            code: 'TEN',
            amount: 10,
        })
        const before = ingestCalls().length

        expect(await base.caramelSyncSavings()).toMatchObject({
            skipped: 'nothing-queued',
        })
        expect(ingestCalls()).toHaveLength(before)
    })

    it('pushes a backlog of queued savings in one request when the server returns', async () => {
        serverDown = true
        for (const code of ['A', 'B', 'C']) {
            await record({
                domain: 'shop.com',
                code,
                amount: 5,
            })
        }
        serverDown = false

        await base.caramelSyncSavings()
        expect(serverRows).toHaveLength(3)
        expect((await stored()).every(e => e.synced)).toBe(true)
    })
})

describe('an event the server permanently refuses is not retried forever', () => {
    it('marks it rejected, keeps it locally, and stops pushing it', async () => {
        await base.caramelSetSettings({ syncSavings: true })
        setSession('ada')

        // caramelRecordSaving refuses a non-positive amount outright, so drive
        // the poison payload the way a corrupted stored entry would: queue a
        // good one, then blank its amount before the sweep.
        serverDown = true
        await record({
            domain: 'shop.com',
            code: 'BAD',
            amount: 10,
        })
        const list = await stored()
        list[0].amount = 0
        await new Promise(resolve =>
            globalThis.currentBrowser.storage.local.set(
                { caramel_savings: list },
                resolve,
            ),
        )

        serverDown = false
        await base.caramelSyncSavings()

        const afterFirst = await stored()
        expect(afterFirst[0].synced).toBeUndefined()
        expect(afterFirst[0].syncRejected).toContain('amountCents')
        expect(serverRows).toHaveLength(0)

        const callsSoFar = ingestCalls().length
        await base.caramelSyncSavings()
        // A rejection is deterministic: re-sending it would be a poison pill
        // parked at the head of the queue forever.
        expect(ingestCalls()).toHaveLength(callsSoFar)
    })
})

describe('sync starts from when it was turned on', () => {
    it('does not retroactively upload savings earned while it was off', async () => {
        setSession('ada')
        await record({
            domain: 'shop.com',
            code: 'BEFORE',
            amount: 10,
        })

        await base.caramelSetSettings({ syncSavings: true })
        await base.caramelSyncSavings()

        expect(ingestCalls()).toHaveLength(0)
        expect(serverRows).toHaveLength(0)
    })

    it('uploads the savings earned after it was turned on', async () => {
        setSession('ada')
        await record({
            domain: 'shop.com',
            code: 'BEFORE',
            amount: 10,
        })
        await base.caramelSetSettings({ syncSavings: true })
        await record({
            domain: 'shop.com',
            code: 'AFTER',
            amount: 20,
        })

        expect(serverRows.map(row => row.code)).toEqual(['AFTER'])
    })

    it('turning sync back off stops new uploads and keeps what was already sent', async () => {
        await base.caramelSetSettings({ syncSavings: true })
        setSession('ada')
        await record({
            domain: 'shop.com',
            code: 'SENT',
            amount: 10,
        })

        await base.caramelSetSettings({ syncSavings: false })
        await record({
            domain: 'shop.com',
            code: 'AFTER_OFF',
            amount: 20,
        })

        expect(serverRows.map(row => row.code)).toEqual(['SENT'])
        // Off means stop sending, not erase — the local history is intact and
        // the server keeps what it already has.
        expect((await stored()).map(e => e.code)).toEqual(['AFTER_OFF', 'SENT'])
    })
})

describe('the 50-entry cap evicts a synced entry before an unsynced one', () => {
    /** A history one entry short of the cap, newest first. */
    function seed({ oldestUnsynced }) {
        const list = []
        for (let i = 0; i < 50; i++) {
            list.push({
                domain: 'shop.com',
                code: `C${i}`,
                amount: 1,
                currency: 'USD',
                t: Date.now() - i * 1000,
                clientEventId: `id-${i}`,
                u: 'ada',
                syncPending: true,
                // Index 49 is the oldest. Making it the one that never reached
                // the server is what the blind newest-50 trim would delete.
                synced: !(oldestUnsynced && i === 49),
            })
        }
        localData.caramel_savings = list
    }

    beforeEach(() => {
        setSession('ada')
    })

    it('keeps the unsynced straggler and drops a synced entry instead', async () => {
        seed({ oldestUnsynced: true })
        await record({
            domain: 'shop.com',
            code: 'NEW',
            amount: 3,
        })

        const list = await stored()
        expect(list).toHaveLength(50)
        expect(list[0].code).toBe('NEW')
        // The entry that exists ONLY here survived.
        expect(list.some(e => e.code === 'C49')).toBe(true)
        // A synced entry — safe on the account — made room for it.
        expect(list.some(e => e.code === 'C48')).toBe(false)
    })

    it('falls back to dropping the oldest when every entry is unsynced', async () => {
        seed({ oldestUnsynced: false })
        const list = localData.caramel_savings
        for (const entry of list) entry.synced = false

        await record({
            domain: 'shop.com',
            code: 'NEW',
            amount: 3,
        })

        const after = await stored()
        expect(after).toHaveLength(50)
        expect(after[0].code).toBe('NEW')
        expect(after.some(e => e.code === 'C49')).toBe(false)
    })
})

describe('the popup switch writes the account flag, not just the device', () => {
    it('PATCHes the account and reports the persisted value back', async () => {
        setSession('ada')
        const response = await new Promise(resolve =>
            globalThis.currentBrowser.runtime.sendMessage(
                { action: 'setSavingsSync', enabled: true },
                resolve,
            ),
        )

        expect(response).toEqual({ savingsSyncEnabled: true })
        const patch = fetchCalls.find(call =>
            call.url.includes('/api/account/savings-sync'),
        )
        expect(patch.opts.method).toBe('PATCH')
        expect(JSON.parse(patch.opts.body)).toEqual({ enabled: true })
        expect(patch.opts.headers.Authorization).toBe('Bearer tok-ada')
    })

    it('surfaces a failure instead of reporting success', async () => {
        setSession('ada')
        serverDown = true
        const response = await new Promise(resolve =>
            globalThis.currentBrowser.runtime.sendMessage(
                { action: 'setSavingsSync', enabled: true },
                resolve,
            ),
        )
        expect(response).toEqual({ error: 'HTTP 503' })
    })
})

// A device can hold syncSavings=true while the ACCOUNT says no: the user turned
// sync off on another device or in /profile, and this extension never heard.
// The server refuses those pushes (403 savings_sync_disabled). What matters
// here is what the sweep does NEXT — because the sweep's rule for every other
// failure is "leave it queued and try again on the next popup open", and
// applying that rule to a permanent refusal is an infinite retry loop.
describe('a refusal from the account is an answer, not a failure to retry', () => {
    beforeEach(async () => {
        await base.caramelSetSettings({ syncSavings: true })
        setSession('ada')
        accountSyncEnabled = false
    })

    // Positive control: the same fixture WITH consent stores the event, so the
    // absence-shaped assertions below mean "the refusal was handled" and not
    // "this fixture never syncs anything".
    it('stores the very same event once the account consents', async () => {
        accountSyncEnabled = true
        await record({ domain: 'shop.com', code: 'TEN', amount: 10 })

        expect(serverRows).toHaveLength(1)
        expect((await stored())[0].synced).toBe(true)
    })

    it('stops sweeping instead of retrying the refusal forever', async () => {
        await record({ domain: 'shop.com', code: 'TEN', amount: 10 })
        expect(ingestCalls()).toHaveLength(1)

        // Three more sweeps, as three popup opens would make.
        await base.caramelSyncSavings()
        await base.caramelSyncSavings()
        await base.caramelSyncSavings()

        expect(ingestCalls()).toHaveLength(1)
    })

    it('marks nothing synced — the server stored nothing', async () => {
        await record({ domain: 'shop.com', code: 'TEN', amount: 10 })

        const list = await stored()
        expect(list).toHaveLength(1)
        expect(list[0].synced).toBeUndefined()
        expect(serverRows).toHaveLength(0)
    })

    it('does not mark the event rejected — the event was fine, the permission was missing', async () => {
        await record({ domain: 'shop.com', code: 'TEN', amount: 10 })
        expect((await stored())[0].syncRejected).toBeUndefined()
    })

    it('un-queues the batch so it stays device-local', async () => {
        await record({ domain: 'shop.com', code: 'TEN', amount: 10 })
        expect((await stored())[0].syncPending).toBeUndefined()
    })

    it('reconciles the device setting to the account, so the next sweep short-circuits', async () => {
        await record({ domain: 'shop.com', code: 'TEN', amount: 10 })

        expect((await base.caramelGetSettings()).syncSavings).toBe(false)
        expect(await base.caramelSyncSavings()).toEqual({
            pushed: 0,
            skipped: 'sync-off',
        })
    })

    it('keeps the saving visible in the shopper local history', async () => {
        await record({ domain: 'shop.com', code: 'TEN', amount: 10 })

        const list = await stored()
        expect(list[0].domain).toBe('shop.com')
        expect(list[0].amount).toBe(10)
    })

    it('does not upload a backlog if the shopper later turns sync back on', async () => {
        await record({ domain: 'shop.com', code: 'TEN', amount: 10 })

        // Consent granted afterwards. "Sync starts from here" — the refused
        // event was recorded while the account said no and stays local.
        accountSyncEnabled = true
        await base.caramelSetSettings({ syncSavings: true })
        await base.caramelSyncSavings()

        expect(serverRows).toHaveLength(0)

        // ...and a saving earned AFTER does upload, so the sweep is alive.
        await record({ domain: 'shop.com', code: 'LATER', amount: 4 })
        expect(serverRows.map(row => row.code)).toEqual(['LATER'])
    })

    it('a transport failure is still retried — only the refusal stops the sweep', async () => {
        accountSyncEnabled = true
        serverDown = true
        await record({ domain: 'shop.com', code: 'TEN', amount: 10 })
        expect(ingestCalls()).toHaveLength(1)

        await base.caramelSyncSavings()
        expect(ingestCalls()).toHaveLength(2)
        expect((await stored())[0].syncPending).toBe(true)
        expect((await base.caramelGetSettings()).syncSavings).toBe(true)
    })
})
