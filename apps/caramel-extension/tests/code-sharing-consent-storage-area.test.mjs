import { describe, expect, it } from 'vitest'
import {
    CODE_SHARING_CONSENT_KEY,
    readCodeSharingConsent,
    writeCodeSharingConsent,
} from '../code-sharing-consent.js'

// The checkout code-sharing consent record is in storage.SYNC on purpose (owner
// rule 2026-11-12, T-17452): the shopper's choice follows their browser profile,
// and the consent card, the popup toggle and the privacy policy tell them so.
// The session token went the other way (storage.local, see
// session-storage-area.test.mjs) because a credential must not roam.
//
// This pins the area. If it fails because the record moved to local, the
// shopper-facing wording is now false: change the wording and the owner-approved
// privacy item together, do not just update this test.

// A browser handle whose two areas record every call, so "never touched local"
// is asserted, not assumed.
const makeBrowser = () => {
    const data = { sync: {}, local: {} }
    const calls = { sync: [], local: [] }
    const area = name => ({
        get: (keys, cb) => {
            calls[name].push(['get', keys])
            const out = {}
            for (const key of keys)
                if (key in data[name]) out[key] = data[name][key]
            cb(out)
        },
        set: (items, cb) => {
            calls[name].push(['set', Object.keys(items)])
            Object.assign(data[name], items)
            cb()
        },
    })
    return {
        data,
        calls,
        runtime: { lastError: undefined },
        storage: { sync: area('sync'), local: area('local') },
    }
}

describe('code-sharing consent lives in storage.sync, never storage.local', () => {
    it('write persists the record to sync and leaves local untouched', async () => {
        const browser = makeBrowser()
        const record = await writeCodeSharingConsent(browser, 'accepted')
        expect(browser.calls.sync).toEqual([
            ['set', [CODE_SHARING_CONSENT_KEY]],
        ])
        expect(browser.calls.local).toEqual([])
        expect(browser.data.sync[CODE_SHARING_CONSENT_KEY]).toEqual(record)
        expect(Object.keys(record).toSorted()).toEqual([
            'at',
            'choice',
            'promptVersion',
        ])
    })

    it('read comes from sync: a record in local is ignored, a record in sync is found', async () => {
        const browser = makeBrowser()
        const record = {
            choice: 'declined',
            at: '2026-11-12T12:00:00.000Z',
            promptVersion: 1,
        }
        browser.data.local[CODE_SHARING_CONSENT_KEY] = {
            ...record,
            choice: 'accepted',
        }
        expect(await readCodeSharingConsent(browser)).toBeNull()

        browser.data.sync[CODE_SHARING_CONSENT_KEY] = record
        expect(await readCodeSharingConsent(browser)).toEqual(record)
        expect(browser.calls.local).toEqual([])
    })
})
