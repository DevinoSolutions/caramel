import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { fetchCouponsPage } from '../coupon-fetch.js'
import {
    CARAMEL_CAPABILITY_MARKERS,
    caramelCapabilityHeld,
} from '../extension-capabilities.js'

// porkbun.com refuses a coupon with a native alert(). GET /api/coupons withholds
// that store's codes from an extension that does not say the page-world helper
// (porkbun-alert-shim.js) is running (apps/caramel-app/src/lib/
// extensionCapabilityGates.ts), so a build with no proof gets 0 codes, has
// nothing to try, and raises 0 dialogs (store-detect.js shows no prompt for an
// empty list: tests/configless-store.test.mjs 'stays silent when we hold no
// codes for it'). This file pins the extension half: the page's proof is read
// from the marker the helper stamps, and sent. See extension-capabilities.js.

const MARKER = CARAMEL_CAPABILITY_MARKERS.alertShim

const stamp = () => document.documentElement.setAttribute(MARKER, '1')
const clearMarker = () => document.documentElement.removeAttribute(MARKER)

let sent

beforeAll(() => {
    const chromeStub = {
        storage: {
            local: { get: (_k, cb) => cb({}), set: () => {} },
            session: { get: (_k, cb) => cb({}), set: () => {} },
        },
        runtime: {
            lastError: undefined,
            sendMessage: (message, cb) => {
                sent.push(message)
                cb({ coupons: [] })
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
    sent = []
    clearMarker()
})

afterEach(() => {
    clearMarker()
    vi.useRealTimers()
})

function setHost(url) {
    const original = window.location
    Object.defineProperty(window, 'location', {
        value: new URL(url),
        writable: true,
        configurable: true,
    })
    return () =>
        Object.defineProperty(window, 'location', {
            value: original,
            writable: true,
            configurable: true,
        })
}

function setReadyState(value) {
    Object.defineProperty(document, 'readyState', {
        value,
        configurable: true,
    })
    return () => delete document.readyState
}

describe('caramelCapabilityHeld', () => {
    it('is false until the page-world helper stamps its marker', () => {
        expect(caramelCapabilityHeld('alertShim')).toBe(false)
        stamp()
        expect(caramelCapabilityHeld('alertShim')).toBe(true)
    })

    it('only the exact "1" counts', () => {
        document.documentElement.setAttribute(MARKER, 'true')
        expect(caramelCapabilityHeld('alertShim')).toBe(false)
    })

    it('fails closed on a capability this build does not know', () => {
        stamp()
        expect(caramelCapabilityHeld('somethingNew')).toBe(false)
        expect(caramelCapabilityHeld(undefined)).toBe(false)
    })
})

describe('fetchCouponsPage proof', () => {
    // Builds that predate this file send nothing and are withheld by the
    // server; this build must say what its page proves, or it is withheld too.
    it('carries no capability until the page proves one', async () => {
        await fetchCouponsPage('example.com', '', '', 1)
        expect(sent[0].capabilities).toEqual([])
    })

    it('carries alertShim once the marker is stamped', async () => {
        stamp()
        await fetchCouponsPage('example.com', '', '', 1)
        expect(sent[0].capabilities).toEqual(['alertShim'])
    })
})

describe('fetchCouponsPage on a gated host whose marker has not landed', () => {
    it('waits for the load event, then sends the proof the helper stamped there', async () => {
        const restoreHost = setHost('https://porkbun.com/checkout/cart')
        const restoreState = setReadyState('interactive')
        try {
            const pending = fetchCouponsPage('porkbun.com', '', '', 1)
            await Promise.resolve()
            expect(sent).toHaveLength(0)
            // The helper's own load handler runs first, then ours.
            stamp()
            window.dispatchEvent(new Event('load'))
            await pending
            expect(sent[0].capabilities).toEqual(['alertShim'])
        } finally {
            restoreState()
            restoreHost()
        }
    })

    it('gives up after a bounded wait and sends no proof (fail closed)', async () => {
        vi.useFakeTimers()
        const restoreHost = setHost('https://www.porkbun.com/checkout/cart')
        const restoreState = setReadyState('interactive')
        try {
            const pending = fetchCouponsPage('porkbun.com', '', '', 1)
            await vi.advanceTimersByTimeAsync(10000)
            await pending
            expect(sent[0].capabilities).toEqual([])
        } finally {
            restoreState()
            restoreHost()
        }
    })

    it('does not wait when the page has already loaded', async () => {
        const restoreHost = setHost('https://porkbun.com/checkout/cart')
        const restoreState = setReadyState('complete')
        try {
            await fetchCouponsPage('porkbun.com', '', '', 1)
            expect(sent[0].capabilities).toEqual([])
        } finally {
            restoreState()
            restoreHost()
        }
    })

    it('never delays another store, nor a look-alike host', async () => {
        for (const url of [
            'https://example.com/cart',
            'https://notporkbun.com/cart',
            'https://porkbun.com.evil.example/cart',
        ]) {
            const restoreHost = setHost(url)
            const restoreState = setReadyState('interactive')
            try {
                sent = []
                await fetchCouponsPage('example.com', '', '', 1)
                expect(sent).toHaveLength(1)
            } finally {
                restoreState()
                restoreHost()
            }
        }
    })
})
