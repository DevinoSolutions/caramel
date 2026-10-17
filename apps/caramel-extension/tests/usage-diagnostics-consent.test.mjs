import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    deleteTelemetryId,
    parseUsageDiagnosticsConsent,
    readTelemetryId,
    readUsageDiagnosticsConsent,
    requestUsageDiagnosticsPermission,
    resolveUsageDiagnostics,
    USAGE_DIAGNOSTICS_CONSENT_KEY,
    USAGE_DIAGNOSTICS_ID_KEY,
    usageDiagnosticsAccepted,
    usageDiagnosticsBrowserPermitted,
    usageDiagnosticsPromptVersion,
    withdrawUsageDiagnosticsPermission,
    writeUsageDiagnosticsConsent,
} from '../usage-diagnostics-consent.js'

/**
 * usage-diagnostics-consent.js — the opt-in record behind anonymous usage
 * diagnostics (device-local, never synced), the telemetry id that lives only
 * while the consent stands and is minted only on the accept path, and the Firefox data-collection grant that must back it.
 * Absent / malformed / declined / old-version all mean NO.
 */

let syncData
let localData
let runtimeUrl
let browser

const record = (choice, extra = {}) => ({
    choice,
    at: '2026-10-15T12:00:00.000Z',
    promptVersion: 1,
    ...extra,
})

function makeBrowser() {
    const area = data => ({
        get: (keys, cb) =>
            cb(Object.fromEntries([].concat(keys).map(k => [k, data()[k]]))),
        set: (items, cb) => {
            Object.assign(data(), items)
            cb()
        },
        remove: (keys, cb) => {
            for (const k of [].concat(keys)) delete data()[k]
            cb()
        },
    })
    return {
        runtime: { lastError: undefined, getURL: () => runtimeUrl },
        storage: { sync: area(() => syncData), local: area(() => localData) },
    }
}

beforeEach(() => {
    syncData = {}
    localData = {}
    runtimeUrl = 'chrome-extension://abc/'
    browser = makeBrowser()
})

afterEach(() => {
    delete globalThis.browser
    delete globalThis.chrome
})

describe('parseUsageDiagnosticsConsent', () => {
    it('accepts exactly a valid record', () => {
        expect(parseUsageDiagnosticsConsent(record('accepted'))).toEqual(
            record('accepted'),
        )
        expect(parseUsageDiagnosticsConsent(record('declined'))).toEqual(
            record('declined'),
        )
    })

    it.each([
        ['absent', undefined],
        ['null', null],
        ['a string', 'accepted'],
        ['an unknown choice', record('maybe')],
        ['another prompt version', record('accepted', { promptVersion: 2 })],
        [
            'a missing prompt version',
            { choice: 'accepted', at: record('accepted').at },
        ],
        ['an unparsable date', record('accepted', { at: 'yesterday' })],
        ['a missing date', { choice: 'accepted', promptVersion: 1 }],
    ])('%s parses to null (= no telemetry)', (_label, raw) => {
        expect(parseUsageDiagnosticsConsent(raw)).toBeNull()
    })

    it('only "accepted" is a yes', () => {
        expect(usageDiagnosticsAccepted(record('accepted'))).toBe(true)
        expect(usageDiagnosticsAccepted(record('declined'))).toBe(false)
        expect(usageDiagnosticsAccepted(null)).toBe(false)
    })

    it('is a separate record from the code-sharing consent (a yes to one is not a yes to the other)', () => {
        expect(USAGE_DIAGNOSTICS_CONSENT_KEY).toBe('usageDiagnosticsConsent')
        expect(USAGE_DIAGNOSTICS_CONSENT_KEY).not.toBe(
            'checkoutCodeSharingConsent',
        )
    })
})

describe('writeUsageDiagnosticsConsent and the telemetry id', () => {
    it('accepting stores the record and mints a random per-device UUID in storage.local', async () => {
        const written = await writeUsageDiagnosticsConsent(browser, 'accepted')

        expect(written.choice).toBe('accepted')
        expect(written.promptVersion).toBe(usageDiagnosticsPromptVersion())
        expect(await readUsageDiagnosticsConsent(browser)).toEqual(written)
        const id = localData[USAGE_DIAGNOSTICS_ID_KEY]
        expect(id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        )
        // Local only: neither the record nor the id ever roams through sync.
        expect(syncData).toEqual({})
        expect(localData[USAGE_DIAGNOSTICS_CONSENT_KEY]).toEqual(written)
    })

    it('the id is NOT the install-attribution id (separate key, separate value)', async () => {
        localData.caramel_install_attribution = {
            iid: '11111111-1111-4111-8111-111111111111',
        }
        await writeUsageDiagnosticsConsent(browser, 'accepted')

        expect(USAGE_DIAGNOSTICS_ID_KEY).not.toBe('caramel_install_attribution')
        expect(localData[USAGE_DIAGNOSTICS_ID_KEY]).not.toBe(
            localData.caramel_install_attribution.iid,
        )
        expect(localData.caramel_install_attribution.iid).toBe(
            '11111111-1111-4111-8111-111111111111',
        )
    })

    it('accepting again keeps the same id', async () => {
        await writeUsageDiagnosticsConsent(browser, 'accepted')
        const first = localData[USAGE_DIAGNOSTICS_ID_KEY]
        await writeUsageDiagnosticsConsent(browser, 'accepted')

        expect(localData[USAGE_DIAGNOSTICS_ID_KEY]).toBe(first)
    })

    it('withdrawing records the decline and DELETES the id; a later opt-in gets a new, unlinked one', async () => {
        await writeUsageDiagnosticsConsent(browser, 'accepted')
        const first = localData[USAGE_DIAGNOSTICS_ID_KEY]

        await writeUsageDiagnosticsConsent(browser, 'declined')
        expect(await readTelemetryId(browser)).toBeNull()
        expect(USAGE_DIAGNOSTICS_ID_KEY in localData).toBe(false)
        expect(
            usageDiagnosticsAccepted(
                await readUsageDiagnosticsConsent(browser),
            ),
        ).toBe(false)

        await writeUsageDiagnosticsConsent(browser, 'accepted')
        expect(localData[USAGE_DIAGNOSTICS_ID_KEY]).not.toBe(first)
    })

    it('a decline whose id delete fails rejects loudly, and the leftover id is never reused by the next accept', async () => {
        await writeUsageDiagnosticsConsent(browser, 'accepted')
        const first = localData[USAGE_DIAGNOSTICS_ID_KEY]

        const realRemove = browser.storage.local.remove
        browser.storage.local.remove = (keys, cb) => {
            browser.runtime.lastError = { message: 'quota busy' }
            cb()
            browser.runtime.lastError = undefined
        }
        await expect(
            writeUsageDiagnosticsConsent(browser, 'declined'),
        ).rejects.toThrow(/usage-diagnostics id delete failed: quota busy/)
        expect(localData[USAGE_DIAGNOSTICS_ID_KEY]).toBe(first)
        browser.storage.local.remove = realRemove

        await writeUsageDiagnosticsConsent(browser, 'accepted')
        expect(localData[USAGE_DIAGNOSTICS_ID_KEY]).not.toBe(first)
    })

    it('declining with no id stored is fine', async () => {
        await writeUsageDiagnosticsConsent(browser, 'declined')
        expect(await readTelemetryId(browser)).toBeNull()
    })

    it('deleteTelemetryId removes it on its own', async () => {
        localData[USAGE_DIAGNOSTICS_ID_KEY] = 'some-id'
        await deleteTelemetryId(browser)
        expect(await readTelemetryId(browser)).toBeNull()
    })

    it('rejects an unknown choice and writes nothing', async () => {
        await expect(
            writeUsageDiagnosticsConsent(browser, 'sure'),
        ).rejects.toThrow(/unknown choice/)
        expect(syncData).toEqual({})
        expect(localData).toEqual({})
    })

    it('REJECTS when storage refuses the record: no consent is recorded, so nothing can send (the id left behind is inert and overwritten by a fresh one on the next accept)', async () => {
        browser.storage.local.set = (_items, cb) => {
            browser.runtime.lastError = { message: 'quota exceeded' }
            cb()
            browser.runtime.lastError = undefined
        }

        await expect(
            writeUsageDiagnosticsConsent(browser, 'accepted'),
        ).rejects.toThrow(/quota exceeded/)
        expect(USAGE_DIAGNOSTICS_CONSENT_KEY in localData).toBe(false)
        expect(await resolveUsageDiagnostics(browser)).toBeNull()
    })

    it('a record an earlier build left in storage.sync is never read (consent does not roam)', async () => {
        syncData[USAGE_DIAGNOSTICS_CONSENT_KEY] = record('accepted')

        expect(await readUsageDiagnosticsConsent(browser)).toBeNull()
        expect(await resolveUsageDiagnostics(browser)).toBeNull()
    })

    it('the id is only ever minted by the accept path: nothing else in the module exports a minter', async () => {
        const mod = await import('../usage-diagnostics-consent.js')
        expect(Object.keys(mod)).not.toContain('ensureTelemetryId')
        await writeUsageDiagnosticsConsent(browser, 'declined')
        expect(USAGE_DIAGNOSTICS_ID_KEY in localData).toBe(false)
    })

    it('a read failure rejects loudly instead of looking like "no consent"', async () => {
        browser.storage.local.get = (_keys, cb) => {
            browser.runtime.lastError = { message: 'storage unavailable' }
            cb()
            browser.runtime.lastError = undefined
        }

        await expect(readUsageDiagnosticsConsent(browser)).rejects.toThrow(
            /storage unavailable/,
        )
    })
})

describe('the Firefox data-collection grant', () => {
    const FIREFOX_URL = 'moz-extension://abc/'
    let permissions

    beforeEach(() => {
        permissions = {
            contains: vi.fn(async () => true),
            request: vi.fn(async () => true),
        }
    })

    const asFirefox = () => {
        runtimeUrl = FIREFOX_URL
        globalThis.browser = { permissions }
    }

    it('off Firefox there is no such permission: request resolves true without asking the browser', async () => {
        globalThis.browser = { permissions }

        expect(await requestUsageDiagnosticsPermission(browser)).toBe(true)
        expect(permissions.request).not.toHaveBeenCalled()
        expect(await usageDiagnosticsBrowserPermitted(browser)).toBe(true)
    })

    it('on Firefox it asks for exactly technicalAndInteraction under data_collection', async () => {
        asFirefox()

        expect(await requestUsageDiagnosticsPermission(browser)).toBe(true)
        expect(permissions.request).toHaveBeenCalledWith({
            data_collection: ['technicalAndInteraction'],
        })
    })

    it('the request is issued synchronously (no await first), as a user gesture requires', () => {
        asFirefox()

        // Not awaited: the call must already have reached the browser.
        void requestUsageDiagnosticsPermission(browser)
        expect(permissions.request).toHaveBeenCalledTimes(1)
    })

    it('a refused browser prompt resolves false (the caller records nothing)', async () => {
        asFirefox()
        permissions.request.mockResolvedValue(false)

        expect(await requestUsageDiagnosticsPermission(browser)).toBe(false)
    })

    it('a Firefox that does not know data_collection rejects (the caller says so)', async () => {
        asFirefox()
        permissions.request.mockRejectedValue(
            new TypeError('Unexpected property'),
        )

        await expect(
            requestUsageDiagnosticsPermission(browser),
        ).rejects.toThrow(/Unexpected property/)
    })

    it('resolveUsageDiagnostics: accepted consent but the grant revoked in about:addons => NOT allowed', async () => {
        asFirefox()
        localData[USAGE_DIAGNOSTICS_CONSENT_KEY] = record('accepted')
        permissions.contains.mockResolvedValue(false)

        expect(await resolveUsageDiagnostics(browser)).toBeNull()
        expect(permissions.contains).toHaveBeenCalledWith({
            data_collection: ['technicalAndInteraction'],
        })
    })

    it('resolveUsageDiagnostics: accepted consent and the grant held => allowed', async () => {
        asFirefox()
        localData[USAGE_DIAGNOSTICS_CONSENT_KEY] = record('accepted')

        expect(await resolveUsageDiagnostics(browser)).toEqual(
            record('accepted'),
        )
    })

    it('resolveUsageDiagnostics fails closed and loud when the browser cannot say', async () => {
        asFirefox()
        localData[USAGE_DIAGNOSTICS_CONSENT_KEY] = record('accepted')
        permissions.contains.mockResolvedValue(undefined)

        await expect(resolveUsageDiagnostics(browser)).rejects.toThrow(
            /no boolean/,
        )
    })
})

describe('withdrawUsageDiagnosticsPermission (Firefox hands the grant back)', () => {
    let permissions
    beforeEach(() => {
        permissions = {
            contains: vi.fn(async () => true),
            request: vi.fn(),
            remove: vi.fn(async () => true),
        }
        runtimeUrl = 'moz-extension://abc/'
        globalThis.browser = { permissions }
    })

    it('removes exactly technicalAndInteraction under data_collection', async () => {
        await withdrawUsageDiagnosticsPermission(browser)

        expect(permissions.remove).toHaveBeenCalledWith({
            data_collection: ['technicalAndInteraction'],
        })
    })

    it('does nothing when the grant is not held', async () => {
        permissions.contains.mockResolvedValue(false)

        await withdrawUsageDiagnosticsPermission(browser)

        expect(permissions.remove).not.toHaveBeenCalled()
    })

    it('REJECTS when the browser says it did not remove a held grant', async () => {
        permissions.remove.mockResolvedValue(false)

        await expect(
            withdrawUsageDiagnosticsPermission(browser),
        ).rejects.toThrow(/did not remove/)
    })

    it('REJECTS when the permissions call itself fails', async () => {
        permissions.remove.mockRejectedValue(new Error('remove blew up'))

        await expect(
            withdrawUsageDiagnosticsPermission(browser),
        ).rejects.toThrow(/remove blew up/)
    })

    it('off Firefox it is a no-op that never touches the permissions API', async () => {
        runtimeUrl = 'chrome-extension://abc/'

        await withdrawUsageDiagnosticsPermission(browser)

        expect(permissions.contains).not.toHaveBeenCalled()
        expect(permissions.remove).not.toHaveBeenCalled()
    })
})

describe('resolveUsageDiagnostics off Firefox: the consent record is the whole gate', () => {
    it('accepted => the record', async () => {
        localData[USAGE_DIAGNOSTICS_CONSENT_KEY] = record('accepted')
        expect(await resolveUsageDiagnostics(browser)).toEqual(
            record('accepted'),
        )
    })

    it.each([
        ['declined', record('declined')],
        ['absent', undefined],
        ['malformed', { choice: 'accepted' }],
        ['another prompt version', record('accepted', { promptVersion: 9 })],
    ])('%s => null', async (_label, stored) => {
        if (stored !== undefined)
            localData[USAGE_DIAGNOSTICS_CONSENT_KEY] = stored
        expect(await resolveUsageDiagnostics(browser)).toBeNull()
    })
})
