import { describe, expect, it } from 'vitest'
import {
    FIRST_TOUCH_COOKIE_NAME,
    FIRST_TOUCH_PARAMS,
    parseFirstTouchCookieValue,
    serializeFirstTouchCookieValue,
} from '../../caramel-app/src/lib/analytics/firstTouchRecord.ts'
import { INSTALL_ID_PATTERN } from '../../caramel-app/src/lib/extensionInstall.ts'
import {
    INSTALL_ATTRIBUTION_KEY,
    installAttributionFields,
    readFirstTouchCookie,
    recordWelcomeFirstTouch,
    saveInstallId,
    welcomeInstallId,
} from '../install-attribution.js'

// install-attribution.js is plain JS in the extension and cannot import the
// website's zod schema, so it carries its own reader of the `cm_ft` cookie.
// The FIRST describe pins that reader to the app's real definitions (imported
// here, not copied): same cookie name, same field set, same limits, same
// verdict on every record the site can write and on the malformed ones. A
// field added on the website side that the extension would drop fails here.
// The rest is the module's behaviour over a storage double.

const IID = '3f2b8c1e-5a47-4d6b-9e10-7c2d4a8b9f01'
const OTHER_IID = '9a1c7e22-84d3-4f0b-8b66-2e5d7f3a1c90'
const ORIGINS = new Set(['https://grabcaramel.com'])
const WELCOME = `https://grabcaramel.com/welcome?src=ext&store=chrome&v=1.4.6&iid=${IID}`

const fullRecord = {
    utm_source: 'reddit',
    utm_medium: 'social',
    utm_campaign: 'launch',
    utm_term: 'honey',
    utm_content: 'post-1',
    ref: 'friend',
    gclid: 'g1',
    gbraid: 'g2',
    wbraid: 'g3',
    fbclid: 'f1',
    msclkid: 'm1',
    ttclid: 't1',
    referrer_domain: 'reddit.com',
    landing_path: '/honey-extension',
    captured_at: '2026-10-01T12:00:00.000Z',
}

const cookieOf = record =>
    `${FIRST_TOUCH_COOKIE_NAME}=${serializeFirstTouchCookieValue(record)}`

describe('the extension reader agrees with the website schema', () => {
    it('uses the same cookie name', () => {
        expect(FIRST_TOUCH_COOKIE_NAME).toBe('cm_ft')
        expect(readFirstTouchCookie(cookieOf(fullRecord)).record).not.toBeNull()
    })

    it('covers every attribution param the website records (a new one would be dropped here otherwise)', () => {
        for (const param of FIRST_TOUCH_PARAMS) {
            const record = { [param]: 'v', captured_at: 'now' }
            expect(readFirstTouchCookie(cookieOf(record)).record).toEqual(
                record,
            )
        }
    })

    it.each([
        ['a full record', fullRecord],
        ['the minimum (captured_at only)', { captured_at: 'now' }],
        [
            'an organic landing',
            { landing_path: '/', captured_at: '2026-10-01T12:00:00.000Z' },
        ],
        [
            'values at the 255 cap',
            { utm_source: 'x'.repeat(255), captured_at: 'now' },
        ],
    ])('returns the same record the schema does: %s', (_, record) => {
        const raw = serializeFirstTouchCookieValue(record)
        const website = parseFirstTouchCookieValue(raw)
        expect(website.ok).toBe(true)
        expect(
            readFirstTouchCookie(`${FIRST_TOUCH_COOKIE_NAME}=${raw}`),
        ).toEqual({ record: website.record, invalid: [] })
    })

    it.each([
        [
            'an over-long label',
            { utm_source: 'x'.repeat(256), captured_at: 'n' },
        ],
        ['a wrong-typed label', { ref: 5, captured_at: 'n' }],
        ['no captured_at', { utm_source: 'reddit' }],
        ['an empty captured_at', { captured_at: '' }],
        ['a captured_at over 64', { captured_at: 'x'.repeat(65) }],
        ['an array', ['a']],
        ['null', null],
    ])('rejects what the schema rejects: %s', (_, value) => {
        const raw = encodeURIComponent(JSON.stringify(value))
        expect(parseFirstTouchCookieValue(raw).ok).toBe(false)
        const read = readFirstTouchCookie(`${FIRST_TOUCH_COOKIE_NAME}=${raw}`)
        expect(read.record).toBeNull()
        expect(read.invalid).toHaveLength(1)
    })

    it('drops unknown keys, as the schema does', () => {
        const raw = encodeURIComponent(
            JSON.stringify({ ...fullRecord, injected: 'x' }),
        )
        expect(parseFirstTouchCookieValue(raw).record).toEqual(fullRecord)
        expect(readFirstTouchCookie(`cm_ft=${raw}`).record).toEqual(fullRecord)
    })

    it('reports a cookie that is not URL-encoded JSON instead of hiding it', () => {
        const read = readFirstTouchCookie('cm_ft=%7Bbroken')
        expect(read.record).toBeNull()
        expect(read.invalid[0]).toMatch(/not URL-encoded JSON/)
    })

    it('finds the cookie among others, and takes the first VALID one when two coexist', () => {
        const cookie = `a=1; cm_ft=%7Bbroken; ${cookieOf(fullRecord)}; b=2`
        const read = readFirstTouchCookie(cookie)
        expect(read.record).toEqual(fullRecord)
        expect(read.invalid).toHaveLength(1)
        expect(readFirstTouchCookie('a=1; b=2')).toEqual({
            record: null,
            invalid: [],
        })
        expect(readFirstTouchCookie('')).toEqual({ record: null, invalid: [] })
    })

    it('accepts and rejects the same install ids as the server pattern', () => {
        for (const id of [
            IID,
            IID.toUpperCase(),
            'not-a-uuid',
            `${IID}x`,
            '',
            '3f2b8c1e-5a47-0d6b-9e10-7c2d4a8b9f01', // version nibble 0
        ]) {
            const href = `https://grabcaramel.com/welcome?src=ext&iid=${id}`
            expect(welcomeInstallId(href, ORIGINS) !== null).toBe(
                INSTALL_ID_PATTERN.test(id),
            )
        }
    })
})

describe('welcomeInstallId', () => {
    it.each([
        ['the extension-opened welcome page', WELCOME, IID],
        [
            'another path',
            `https://grabcaramel.com/pricing?src=ext&iid=${IID}`,
            null,
        ],
        ['no src=ext', `https://grabcaramel.com/welcome?iid=${IID}`, null],
        ['no iid', 'https://grabcaramel.com/welcome?src=ext', null],
        [
            'a foreign origin',
            `https://evil.example/welcome?src=ext&iid=${IID}`,
            null,
        ],
        ['not a URL', 'nope', null],
    ])('%s', (_, href, expected) => {
        expect(welcomeInstallId(href, ORIGINS)).toBe(expected)
    })
})

/** storage.local over a plain object, callback style like the real API. */
function fakeApi(initial = {}, { failSet = false } = {}) {
    const data = { ...initial }
    const api = {
        runtime: { lastError: undefined },
        storage: {
            local: {
                get: (keys, cb) => {
                    const out = {}
                    for (const k of keys) if (k in data) out[k] = data[k]
                    cb(out)
                },
                set: (items, cb) => {
                    if (failSet) api.runtime.lastError = new Error('quota')
                    else Object.assign(data, items)
                    cb()
                    api.runtime.lastError = undefined
                },
            },
        },
    }
    return { api, data }
}

describe('saveInstallId (background, on install)', () => {
    it('stores the id under the one key', async () => {
        const { api, data } = fakeApi()
        await saveInstallId(api, IID)
        expect(data[INSTALL_ATTRIBUTION_KEY]).toEqual({ iid: IID })
    })

    it('a reinstall replaces the earlier record, first touch included', async () => {
        const { api, data } = fakeApi({
            [INSTALL_ATTRIBUTION_KEY]: {
                iid: OTHER_IID,
                firstTouch: fullRecord,
            },
        })
        await saveInstallId(api, IID)
        expect(data[INSTALL_ATTRIBUTION_KEY]).toEqual({ iid: IID })
    })

    it('rejects when storage refuses, so the caller can report it', async () => {
        const { api } = fakeApi({}, { failSet: true })
        await expect(saveInstallId(api, IID)).rejects.toThrow('quota')
    })
})

describe('recordWelcomeFirstTouch (content script, on /welcome)', () => {
    const args = (extra = {}) => ({
        href: WELCOME,
        cookie: cookieOf(fullRecord),
        trustedOrigins: ORIGINS,
        ...extra,
    })

    it('adds the page record next to the stored install id', async () => {
        const { api, data } = fakeApi({
            [INSTALL_ATTRIBUTION_KEY]: { iid: IID },
        })
        const result = await recordWelcomeFirstTouch(api, args())
        expect(result).toEqual({ status: 'saved', invalid: [] })
        expect(data[INSTALL_ATTRIBUTION_KEY]).toEqual({
            iid: IID,
            firstTouch: fullRecord,
        })
    })

    it('still works when the background never stored the id (the URL carries it)', async () => {
        const { api, data } = fakeApi()
        expect((await recordWelcomeFirstTouch(api, args())).status).toBe(
            'saved',
        )
        expect(data[INSTALL_ATTRIBUTION_KEY].iid).toBe(IID)
    })

    it('does nothing off the welcome page', async () => {
        const { api, data } = fakeApi({
            [INSTALL_ATTRIBUTION_KEY]: { iid: IID },
        })
        const result = await recordWelcomeFirstTouch(
            api,
            args({ href: 'https://grabcaramel.com/pricing' }),
        )
        expect(result.status).toBe('not-welcome')
        expect(data[INSTALL_ATTRIBUTION_KEY]).toEqual({ iid: IID })
    })

    it('ignores a stale welcome tab from a previous install', async () => {
        const { api, data } = fakeApi({
            [INSTALL_ATTRIBUTION_KEY]: { iid: OTHER_IID },
        })
        const result = await recordWelcomeFirstTouch(api, args())
        expect(result.status).toBe('other-install')
        expect(data[INSTALL_ATTRIBUTION_KEY]).toEqual({ iid: OTHER_IID })
    })

    it('never overwrites a record already saved', async () => {
        const earlier = { captured_at: 'earlier', utm_source: 'first' }
        const { api, data } = fakeApi({
            [INSTALL_ATTRIBUTION_KEY]: { iid: IID, firstTouch: earlier },
        })
        const result = await recordWelcomeFirstTouch(api, args())
        expect(result.status).toBe('already')
        expect(data[INSTALL_ATTRIBUTION_KEY].firstTouch).toEqual(earlier)
    })

    it('reports no-cookie, and what was wrong with a cookie that was there', async () => {
        const { api, data } = fakeApi({
            [INSTALL_ATTRIBUTION_KEY]: { iid: IID },
        })
        expect(
            await recordWelcomeFirstTouch(api, args({ cookie: '' })),
        ).toEqual({ status: 'no-cookie', invalid: [] })
        const bad = await recordWelcomeFirstTouch(
            api,
            args({ cookie: 'cm_ft=%7Bbroken' }),
        )
        expect(bad.status).toBe('no-cookie')
        expect(bad.invalid).toHaveLength(1)
        expect(data[INSTALL_ATTRIBUTION_KEY]).toEqual({ iid: IID })
    })
})

describe('installAttributionFields (popup, at sign-in)', () => {
    it('id and record', async () => {
        const { api } = fakeApi({
            [INSTALL_ATTRIBUTION_KEY]: { iid: IID, firstTouch: fullRecord },
        })
        expect(await installAttributionFields(api)).toEqual({
            iid: IID,
            firstTouch: fullRecord,
        })
    })

    it('id only, and nothing at all for an older install', async () => {
        expect(
            await installAttributionFields(
                fakeApi({ [INSTALL_ATTRIBUTION_KEY]: { iid: IID } }).api,
            ),
        ).toEqual({ iid: IID })
        expect(await installAttributionFields(fakeApi().api)).toEqual({})
    })
})
