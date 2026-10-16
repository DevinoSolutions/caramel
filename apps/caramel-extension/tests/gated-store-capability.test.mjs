import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { fetchCouponsPage } from '../coupon-fetch.js'
import {
    CARAMEL_CAPABILITY_MARKERS,
    caramelCapabilityHeld,
    caramelHeldCapabilities,
} from '../extension-capabilities.js'
import {
    caramelStoreWithheld,
    getDomainRecord,
    isCheckout,
} from '../store-detect.js'

// porkbun.com's apply config reaches the extension in the server's `gated`
// bucket (apps/caramel-app/src/lib/extensionCapabilityGates.ts), tagged with
// the capability it requires. It must become a normal record ONLY on a page
// where the page-world helper has stamped its marker; everywhere else the
// store reads as having no config, which is exactly what a build that predates
// the bucket sees. See extension-capabilities.js.

const PORKBUN_ROW = {
    domain: 'porkbun.com',
    couponInput: '#cartCouponCode',
    couponSubmit: '#modal_applyCouponCode .btn-porkbun',
    requires: 'alertShim',
}
const PORKBUN_ROW_UNGATED = { ...PORKBUN_ROW, requires: undefined }
const PLAIN_ROW = { domain: 'example.com', couponInput: '#promo' }

let storedEntry
let apiResponse
let setCalls

beforeAll(() => {
    const chromeStub = {
        storage: {
            local: {
                get: (_keys, cb) =>
                    cb(
                        storedEntry
                            ? { caramel_supported_stores: storedEntry }
                            : {},
                    ),
                set: items => setCalls.push(items),
            },
            session: { get: (_k, cb) => cb({}), set: () => {} },
        },
        runtime: {
            lastError: undefined,
            sendMessage: (message, cb) => {
                if (message?.action === 'fetchSupportedStores') cb(apiResponse)
                else cb(undefined)
            },
            onMessage: { addListener: () => {} },
            getManifest: () => ({ version: '0.0.0' }),
        },
    }
    globalThis.chrome = chromeStub
    globalThis.browser = undefined
    window.chrome = chromeStub
    window.browser = undefined
    initCaramelBase()
})

beforeEach(() => {
    getDomainRecord.cache = null
    getDomainRecord.gated = []
    storedEntry = null
    setCalls = []
    apiResponse = { supported: [PLAIN_ROW], gated: [PORKBUN_ROW] }
    document.documentElement.removeAttribute(
        CARAMEL_CAPABILITY_MARKERS.alertShim,
    )
})

afterEach(() => {
    document.documentElement.removeAttribute(
        CARAMEL_CAPABILITY_MARKERS.alertShim,
    )
})

const stamp = () =>
    document.documentElement.setAttribute(
        CARAMEL_CAPABILITY_MARKERS.alertShim,
        '1',
    )

describe('caramelCapabilityHeld', () => {
    it('is false until the page-world helper stamps its marker', () => {
        expect(caramelCapabilityHeld('alertShim')).toBe(false)
        stamp()
        expect(caramelCapabilityHeld('alertShim')).toBe(true)
    })

    it('only the exact "1" counts', () => {
        document.documentElement.setAttribute(
            CARAMEL_CAPABILITY_MARKERS.alertShim,
            'true',
        )
        expect(caramelCapabilityHeld('alertShim')).toBe(false)
    })

    it('fails closed on a capability this build does not know', () => {
        stamp()
        expect(caramelCapabilityHeld('somethingNew')).toBe(false)
        expect(caramelCapabilityHeld(undefined)).toBe(false)
    })
})

describe('caramelHeldCapabilities', () => {
    it('lists exactly the capabilities whose marker this page carries', () => {
        expect(caramelHeldCapabilities()).toEqual([])
        stamp()
        expect(caramelHeldCapabilities()).toEqual(['alertShim'])
    })

    it('is empty, not a throw, where there is no document', () => {
        expect(caramelHeldCapabilities(undefined)).toEqual([])
    })
})

describe('fetchCouponsPage proof', () => {
    // Builds that predate this file send nothing and are withheld by the
    // server; this build must say what its page proves, or it is withheld too.
    async function sentMessage() {
        const sent = []
        const real = globalThis.chrome.runtime.sendMessage
        globalThis.chrome.runtime.sendMessage = (message, cb) => {
            sent.push(message)
            cb({ coupons: [] })
        }
        try {
            await fetchCouponsPage('porkbun.com', '', '', 1)
        } finally {
            globalThis.chrome.runtime.sendMessage = real
        }
        return sent[0]
    }

    it('carries no capability until the page proves one', async () => {
        expect((await sentMessage()).capabilities).toEqual([])
    })

    it('carries alertShim once the marker is stamped', async () => {
        stamp()
        expect((await sentMessage()).capabilities).toEqual(['alertShim'])
    })
})

describe('getDomainRecord with a gated store', () => {
    it('withholds the record while the marker is absent', async () => {
        expect(await getDomainRecord('porkbun.com')).toBeUndefined()
    })

    it('hands the record over once the marker is present, www included', async () => {
        stamp()
        expect(await getDomainRecord('porkbun.com')).toEqual(PORKBUN_ROW)
        expect(await getDomainRecord('www.porkbun.com')).toEqual(PORKBUN_ROW)
    })

    it('re-asks the page every lookup: the marker is not cached with the list', async () => {
        expect(await getDomainRecord('porkbun.com')).toBeUndefined()
        stamp()
        expect(await getDomainRecord('porkbun.com')).toEqual(PORKBUN_ROW)
        document.documentElement.removeAttribute(
            CARAMEL_CAPABILITY_MARKERS.alertShim,
        )
        expect(await getDomainRecord('porkbun.com')).toBeUndefined()
    })

    it('does not touch an ungated store either way', async () => {
        expect(await getDomainRecord('example.com')).toEqual(PLAIN_ROW)
        stamp()
        expect(await getDomainRecord('example.com')).toEqual(PLAIN_ROW)
    })

    it('a response with no gated bucket (an older server) just has no gated stores', async () => {
        apiResponse = { supported: [PLAIN_ROW] }
        stamp()
        expect(await getDomainRecord('porkbun.com')).toBeUndefined()
        expect(await getDomainRecord('example.com')).toEqual(PLAIN_ROW)
    })

    it('persists the gated bucket with the cache and reads it back', async () => {
        await getDomainRecord('example.com')
        const saved = setCalls[0].caramel_supported_stores
        expect(saved.gated).toEqual([PORKBUN_ROW])

        getDomainRecord.cache = null
        getDomainRecord.gated = []
        storedEntry = { ...saved, ts: Date.now() }
        apiResponse = { error: 'must not be asked: the cache is fresh' }
        stamp()
        expect(await getDomainRecord('porkbun.com')).toEqual(PORKBUN_ROW)
    })

    it('a cache entry written before this field existed has no gated stores', async () => {
        storedEntry = { data: [PLAIN_ROW], ts: Date.now() }
        stamp()
        expect(await getDomainRecord('example.com')).toEqual(PLAIN_ROW)
        expect(await getDomainRecord('porkbun.com')).toBeUndefined()
    })
})

describe('a row that reached `supported` anyway (server change not live yet, or a cached old payload)', () => {
    it('is still withheld while the marker is absent, and served once it is present', async () => {
        apiResponse = { supported: [PORKBUN_ROW_UNGATED, PLAIN_ROW] }
        expect(await getDomainRecord('porkbun.com')).toBeUndefined()
        stamp()
        expect(await getDomainRecord('porkbun.com')).toEqual(
            PORKBUN_ROW_UNGATED,
        )
    })

    it('covers a subdomain and a www host, and never a look-alike', async () => {
        apiResponse = { supported: [PORKBUN_ROW_UNGATED, PLAIN_ROW] }
        expect(await getDomainRecord('www.porkbun.com')).toBeUndefined()
        expect(caramelStoreWithheld('www.porkbun.com')).toBe(true)
        expect(caramelStoreWithheld('notporkbun.com')).toBe(false)
        expect(caramelStoreWithheld('porkbun.com.evil.example')).toBe(false)
    })
})

describe('caramelStoreWithheld / isCheckout', () => {
    it('answers without any server data: the local table is enough', () => {
        expect(caramelStoreWithheld('porkbun.com')).toBe(true)
        stamp()
        expect(caramelStoreWithheld('porkbun.com')).toBe(false)
        expect(caramelStoreWithheld('example.com')).toBe(false)
    })

    it('isCheckout says no on a withheld store BEFORE the config-less routes (platform cart, finder) get a say', async () => {
        const original = window.location
        Object.defineProperty(window, 'location', {
            value: new URL('https://porkbun.com/checkout/cart'),
            writable: true,
            configurable: true,
        })
        try {
            // No config at all: the only way isCheckout could say yes is a
            // config-less route, which is exactly what must stay off.
            apiResponse = { supported: [] }
            expect(await isCheckout()).toBe(false)
        } finally {
            Object.defineProperty(window, 'location', {
                value: original,
                writable: true,
                configurable: true,
            })
        }
    })
})
