// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://grabcaramel.com/"}
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponRunner, reportOutcome } from '../coupon-runner.js'

// Characterization suite (T-5446), written BEFORE coupon-runner.js is split
// into modules. It pins the two surfaces no other suite drives directly:
//
//   · reportOutcome — the trust-loop report the runner sends the background
//     (shape, the no-id no-op, and that a dead service worker can never break
//     the apply flow);
//   · initCouponRunner's registrations — bound ONCE per realm, what the
//     `message` relay stores and refuses, and what the runtime.onMessage
//     listener does for `userLoggedIn` and for an action it does not know.
//
// On the grabcaramel.com origin (the jsdom URL above), the one allowlisted
// production origin, so the relay actually listens.

const stubs = vi.hoisted(() => ({
    getDomainRecord: null,
    finalModalCalls: [],
    hideTestingModalCalls: 0,
}))

vi.mock('../store-detect.js', async importOriginal => ({
    ...(await importOriginal()),
    getDomainRecord: (...args) => stubs.getDomainRecord(...args),
}))
vi.mock('../coupon-fetch.js', async importOriginal => ({
    ...(await importOriginal()),
    fetchCoupons: async () => [],
}))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {
        stubs.hideTestingModalCalls += 1
    },
    showFinalModal: (...args) => stubs.finalModalCalls.push(args),
}))

let stored
let posted
let onMessageListeners
let chromeStub

/* The realm's chrome: anything unknown is a callable no-op, storage answers an
 * empty read, and runtime.onMessage.addListener RECORDS what is registered so
 * the suite can both count registrations and drive the listener itself. */
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
    for (const area of ['sync', 'local', 'session']) {
        stub.storage[area].get = (_keys, cb) => {
            if (typeof cb === 'function') cb({})
        }
        stub.storage[area].set = (_items, cb) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    stub.runtime.onMessage.addListener = fn => onMessageListeners.push(fn)
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
    return stub
}

const relay = data =>
    window.dispatchEvent(
        new MessageEvent('message', {
            origin: 'https://grabcaramel.com',
            data,
        }),
    )
const settle = () => new Promise(r => setTimeout(r, 0))

/** Drive the runtime.onMessage listener the way the browser does. */
function deliver(req) {
    const replies = []
    const result = onMessageListeners[0](req, {}, r => replies.push(r))
    return { result, replies }
}

beforeAll(() => {
    onMessageListeners = []
    posted = []
    window.postMessage = vi.fn((data, target) => posted.push({ data, target }))
    chromeStub = installChromeStub()
    initCaramelBase()
    initCouponRunner()
})

beforeEach(() => {
    stored = null
    // The relayed session is stored in storage.LOCAL (a full website session
    // token must not roam via Chrome Sync).
    chromeStub.storage.local.set = (items, cb) => {
        stored = items
        if (cb) cb()
    }
    stubs.finalModalCalls = []
    stubs.hideTestingModalCalls = 0
    stubs.getDomainRecord = async () => null
})

describe('reportOutcome — the trust-loop report', () => {
    it('sends the background the id as a string, the outcome and the store reason', () => {
        const sent = []
        chromeStub.runtime.sendMessage = msg => {
            sent.push(msg)
            return Promise.resolve()
        }

        reportOutcome(42, 'failed', 'Minimum spend $50')

        expect(sent).toEqual([
            {
                action: 'reportOutcome',
                id: '42',
                outcome: 'failed',
                storeReason: 'Minimum spend $50',
            },
        ])
    })

    it('carries an absent reason as undefined, for a worked report', () => {
        const sent = []
        chromeStub.runtime.sendMessage = msg => {
            sent.push(msg)
            return Promise.resolve()
        }

        reportOutcome('c9', 'worked')

        expect(sent).toEqual([
            {
                action: 'reportOutcome',
                id: 'c9',
                outcome: 'worked',
                storeReason: undefined,
            },
        ])
    })

    it('sends nothing without a coupon id (the #caramel-test mock list has none)', () => {
        const sendMessage = vi.fn()
        chromeStub.runtime.sendMessage = sendMessage

        reportOutcome(undefined, 'worked')
        reportOutcome(null, 'failed', 'x')
        reportOutcome('', 'worked')

        expect(sendMessage).not.toHaveBeenCalled()
    })

    it('never lets a dead service worker (a rejected promise) reach the caller', async () => {
        chromeStub.runtime.sendMessage = () =>
            Promise.reject(new Error('Extension context invalidated'))

        expect(() => reportOutcome('c1', 'worked')).not.toThrow()
        await settle()
    })

    it('never lets a synchronous send failure reach the caller', () => {
        chromeStub.runtime.sendMessage = () => {
            throw new Error('Extension context invalidated')
        }

        expect(() => reportOutcome('c1', 'worked')).not.toThrow()
    })

    it('copes with a send that does not return a promise', () => {
        chromeStub.runtime.sendMessage = () => undefined

        expect(() => reportOutcome('c1', 'worked')).not.toThrow()
    })
})

describe('initCouponRunner — registered once per realm', () => {
    it('registered exactly one runtime.onMessage listener', () => {
        expect(onMessageListeners).toHaveLength(1)
    })

    it('registers nothing more when called again in the same realm', () => {
        const before = onMessageListeners.length

        initCouponRunner()
        initCouponRunner()

        expect(onMessageListeners).toHaveLength(before)
    })

    it('marks the realm as bound', () => {
        expect(window.__caramel_listeners_bound).toBe(true)
    })

    it('keeps one message relay, so a posted token is stored once, not once per call', async () => {
        const writes = []
        chromeStub.storage.local.set = (items, cb) => {
            writes.push(items)
            if (cb) cb()
        }
        initCouponRunner()

        relay({ token: 'once-only', username: 'tester' })
        await settle()

        expect(writes).toHaveLength(1)
    })
})

describe('initCouponRunner — the website message relay', () => {
    it('ignores a message from our own origin that carries no token', async () => {
        relay({ type: 'caramel-ext-present' })
        relay({ hello: true })
        relay(null)
        relay('a string')
        await settle()

        expect(stored).toBeNull()
    })

    it('names the shopper "CaramelUser" when the page sent no username', async () => {
        relay({ token: 'anon-token' })
        await settle()

        expect(stored).toMatchObject({
            token: 'anon-token',
            user: { username: 'CaramelUser' },
        })
    })

    it('carries the image the page sent', async () => {
        relay({
            token: 'pic-token',
            username: 'tester',
            image: 'https://grabcaramel.com/a.png',
        })
        await settle()

        expect(stored.user).toEqual({
            username: 'tester',
            image: 'https://grabcaramel.com/a.png',
        })
    })

    it('says hello to its own origin when there is no session', () => {
        expect(
            posted.some(
                p =>
                    p.data?.type === 'caramel-ext-hello' &&
                    p.target === 'https://grabcaramel.com',
            ),
        ).toBe(true)
    })
})

describe('initCouponRunner — the runtime.onMessage listener', () => {
    it('answers userLoggedIn at once and does not keep the channel open', () => {
        const { result, replies } = deliver({ action: 'userLoggedIn' })

        expect(replies).toEqual([{ success: true }])
        // false, not true and not a Promise: the apply flow runs detached.
        expect(result).toBe(false)
    })

    it('runs the apply flow on userLoggedIn, for the record of this host', async () => {
        const asked = []
        stubs.getDomainRecord = async host => {
            asked.push(host)
            return null
        }

        deliver({ action: 'userLoggedIn' })
        await settle()

        expect(asked).toEqual([location.hostname])
        // startApplyingCoupons(null) ran: the no-config answer reached the card.
        expect(stubs.finalModalCalls).toHaveLength(1)
        expect(stubs.finalModalCalls[0][2]).toBe(
            "We don't have codes for this store yet.",
        )
    })

    it('takes the overlay down when the apply flow throws', async () => {
        stubs.getDomainRecord = async () => {
            throw new Error('lookup blew up')
        }

        const { replies } = deliver({ action: 'userLoggedIn' })
        await settle()

        // The reply was already sent; the failure cannot trap the page.
        expect(replies).toEqual([{ success: true }])
        expect(stubs.hideTestingModalCalls).toBe(1)
        expect(stubs.finalModalCalls).toEqual([])
    })

    it('does not answer, or open the channel, for an action it does not know', () => {
        const { result, replies } = deliver({ action: 'somethingElse' })

        expect(replies).toEqual([])
        expect(result).toBeUndefined()
    })
})
