import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initBackground } from '../background.js'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initPopup } from '../popup.js'

// Depth of the popup's coupon list (2026-08-10). The popup asked for 20 codes
// and rendered whatever came back, with nothing on screen to say a store held
// more — on the day this was written eBay had 96 live codes in the catalog and
// a shopper could see 20 of them. The owner's ask was blunt: "at least they
// should see the coupons".
//
// The suite runs the REAL producer against the REAL popup, the
// popup-tab-url-contract.test.mjs pattern: background.js's own onMessage
// handler builds the request URL and shapes the response, and the popup realm's
// sendMessage is BRIDGED into that captured handler rather than answered with a
// hand-written payload. A fixture that describes the contract instead of
// exercising it is exactly how the eBay bug stayed invisible, so the only thing
// hand-written here is the catalog the HTTP layer serves.
//
// jsdom has no IntersectionObserver and no layout, so the observer is stubbed
// with one that records what it was asked to watch and lets a test say "this
// crossed into view". That is the boundary being tested: everything downstream
// of the callback — request, dedupe, append, end state, failure — is real.

const SITE = 'ebay.com'
const CATALOG_SIZE = 46
const PAGE_SIZE = 20

// The clipboard helper popup.js imports. It was a free global the old harness
// could overwrite on globalThis; under ESM the collaborator is replaced at its
// own module boundary instead, which is the only thing this substitutes —
// every other UI-helpers export stays the real one.
const { copiedText } = vi.hoisted(() => ({ copiedText: [] }))
vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    caramelCopyText: async text => {
        copiedText.push(text)
        return true
    },
}))

/** A coupon shaped like the /api/coupons rows the popup actually renders. */
function catalogRow(n) {
    return {
        id: String(n),
        code: `SAVE${String(n).padStart(2, '0')}`,
        title: `Deal number ${n}`,
        description: `Description ${n}`,
        status: n % 7 === 0 ? 'product_restriction' : 'valid',
    }
}

const CATALOG = Array.from({ length: CATALOG_SIZE }, (_, i) =>
    catalogRow(i + 1),
)

/* ------------------------------------------------------------------ */
/*  HTTP layer — /api/coupons' documented envelope                     */
/* ------------------------------------------------------------------ */

/** Every URL background.js fetched, in order. */
let requestedUrls = []
/** Pages the HTTP layer should fail on (page number -> times remaining). */
let failPages = new Map()
/** Optional override: page number -> rows to serve, or
 * `{ coupons, hasMore }` when the page must also lie about there being more
 * (both shapes a real catalog under concurrent ingest can produce). */
let servedRows = new Map()

function installCatalogFetch(storeSize = CATALOG_SIZE) {
    requestedUrls = []
    failPages = new Map()
    servedRows = new Map()
    globalThis.fetch = async url => {
        const parsed = new URL(String(url))
        // The signed-in boots fire validateStoredSession in parallel; answer
        // its /api/extension/me probe with a real profile shape so it neither
        // signs the popup out nor writes a garbage user into storage.
        if (parsed.pathname === '/api/extension/me') {
            return {
                ok: true,
                status: 200,
                json: async () => ({ username: 'tester', image: '' }),
            }
        }
        requestedUrls.push(parsed)
        const page = Number(parsed.searchParams.get('page') || '1')
        const limit = Number(parsed.searchParams.get('limit') || '10')

        const remaining = failPages.get(page) || 0
        if (remaining > 0) {
            failPages.set(page, remaining - 1)
            return { ok: false, status: 503 }
        }

        const skip = (page - 1) * limit
        const override = servedRows.get(page)
        const coupons = !override
            ? CATALOG.slice(skip, Math.min(skip + limit, storeSize))
            : Array.isArray(override)
              ? override
              : override.coupons
        const forcedHasMore =
            override && !Array.isArray(override) ? override.hasMore : undefined
        return {
            ok: true,
            status: 200,
            // Byte-for-byte the envelope apps/caramel-app/src/app/api/coupons
            // returns (page/limit/total/hasMore alongside coupons); the app
            // suite pins that route's own shape.
            json: async () => ({
                coupons,
                page,
                limit,
                total: storeSize,
                hasMore:
                    forcedHasMore === undefined
                        ? skip + coupons.length < storeSize
                        : forcedHasMore,
            }),
        }
    }
}

/* ------------------------------------------------------------------ */
/*  Realms                                                             */
/* ------------------------------------------------------------------ */

let chromeStub
/** background.js's own onMessage handler, captured off the realm's stub. */
let backgroundHandler

/** Permissive chrome stub — the makeChromeStub/installChromeStub pair the old
 * tests/_load.mjs harness installed around every eval, inlined here now that
 * the sources are ES modules: anything not explicitly set answers with a
 * callable no-op, storage callbacks fire the way the real API does,
 * runtime.lastError starts UNDEFINED (a permissive proxy would auto-create a
 * truthy callable, which caramel-base.js reads as a closed port), and
 * onMessage.addListener records real listeners so a test can invoke one. */
function installChromeStub() {
    const cache = new WeakMap()
    const wrap = target => {
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
        stub.storage[area].remove = (_keys, cb) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    const listeners = []
    stub.runtime.onMessage.addListener = fn => listeners.push(fn)
    stub.runtime.onMessage.removeListener = fn => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
    }
    stub.runtime.onMessage.hasListener = fn => listeners.includes(fn)
    globalThis.chrome = stub
    globalThis.browser = undefined
    window.chrome = stub
    window.browser = undefined
    // Installed ONCE per suite file — vitest gives each file its own jsdom
    // window, so caramel-base.js's first-run bootstrap latch is still unset and
    // this stub really becomes the realm's currentBrowser.
    initCaramelBase()
    return { stub, listeners }
}

/** Backs one storage area with a real object (tests/_load.mjs's
 * backStorageArea, inlined), so a test asserts on what the code actually
 * stored instead of on which API it called. */
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

/** Stub IntersectionObserver: records observed targets and exposes a way to
 * say "the target scrolled into view". */
function installObserverStub() {
    const observed = []
    class StubIntersectionObserver {
        constructor(callback, options) {
            this.callback = callback
            this.options = options
            observed.push(this)
        }
        observe(target) {
            this.target = target
        }
        disconnect() {
            this.disconnected = true
        }
    }
    globalThis.IntersectionObserver = StubIntersectionObserver
    return {
        instances: observed,
        /** Fires the newest live observer as if its target came into view. */
        scrollIntoView() {
            const live = observed.filter(o => !o.disconnected)
            const observer = live[live.length - 1]
            if (!observer) throw new Error('no live IntersectionObserver')
            observer.callback(
                [{ isIntersecting: true, target: observer.target }],
                observer,
            )
        },
    }
}

beforeAll(() => {
    const installed = installChromeStub()
    chromeStub = installed.stub
    initCouponConstants()
    // Realm A — the REAL service worker. Its handler stays callable for the
    // whole file: it closed over the realm's chrome handle and its own
    // caramelUrl, and reaches the network through the per-boot fetch stub.
    // (The old harness re-eval'd background.js per boot to get a fresh realm;
    // a module evaluates once, so it is initialized once here.)
    initBackground()
    ;[backgroundHandler] = installed.listeners
})

/** Boots the popup against the real background handler and renders page 1.
 * Returns the observer control plus what the popup rendered.
 *
 * `signedIn` defaults to true because the DEEP list is a member feature since
 * the guest cap (GUEST_COUPON_LIMIT in popup.js): every paging behavior below
 * only exists behind a session, and the "guest gate" suite at the bottom is
 * what pins the logged-out shape. */
async function bootPopup({
    withObserver = true,
    storeSize,
    signedIn = true,
} = {}) {
    installCatalogFetch(storeSize)

    // Realm B — the REAL popup. The old harness re-eval'd index.html's whole
    // script list here; the module graph is that list now, so all that is left
    // is the page's own DOM and the transport stubs.
    document.body.innerHTML =
        '<div id="loading-container"></div><div id="auth-container"></div>'

    /** Every fetchCoupons message the popup sent to the worker. */
    const sentMessages = []
    chromeStub.runtime.sendMessage = (message, cb) => {
        if (message?.action === 'getActiveTabDomainRecord') {
            cb({ url: `https://www.${SITE}/cart` })
            return
        }
        if (message?.action === 'fetchCoupons') {
            sentMessages.push(message)
            // BRIDGE: the real worker handler answers, over the real URL it
            // builds itself.
            backgroundHandler(message, {}, cb)
            return
        }
        cb(undefined)
    }
    chromeStub.storage.sync.get = (_keys, cb) => cb({})
    // Session lives in storage.LOCAL (token + user). ALWAYS back the area —
    // the stub is shared across boots in this file, so a guest boot that
    // skipped this would inherit the previous signed-in boot's token and
    // silently test the wrong user.
    backStorageArea(
        'local',
        signedIn
            ? {
                  token: 'tok_paging_suite',
                  user: { username: 'tester', image: '' },
              }
            : {},
    )

    const observer = withObserver ? installObserverStub() : null
    if (!withObserver) delete globalThis.IntersectionObserver

    copiedText.length = 0

    // initPopup() awaits the render before it resolves, so this IS the painted
    // signal. (The old suite wrapped the global renderCouponsView to get one, a
    // seam ESM does not have: initPopup calls it through its module binding.)
    await initPopup()

    return { observer, sentMessages, copied: copiedText }
}

const codesOnScreen = () =>
    [...document.querySelectorAll('#couponList .coupon-item')].map(el =>
        el.getAttribute('data-code'),
    )

const footer = () => document.getElementById('couponListFooter')

/** Lets the fetch → sendMessage → append chain settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
    document.body.innerHTML = ''
})

describe('popup coupon list — first page', () => {
    it('renders the first page of codes and, because the store holds more, a footer to load the rest', async () => {
        await bootPopup()

        const codes = codesOnScreen()
        expect(codes).toHaveLength(PAGE_SIZE)
        expect(codes[0]).toBe('SAVE01')
        expect(codes[PAGE_SIZE - 1]).toBe('SAVE20')
        expect(footer()).not.toBeNull()
    })

    it('asks for page 1 with NO page parameter, so the shipped request shape is unchanged', async () => {
        await bootPopup()

        expect(requestedUrls).toHaveLength(1)
        const url = requestedUrls[0]
        expect(url.pathname).toBe('/api/coupons')
        expect(url.searchParams.get('site')).toBe(SITE)
        expect(url.searchParams.get('limit')).toBe(String(PAGE_SIZE))
        expect(url.searchParams.has('page')).toBe(false)
    })

    it('shows no footer at all when the first page already is the whole store', async () => {
        // Positive precondition: the SAME popup, same code path, DOES paint a
        // footer when the store is deep (the two assertions above) — so its
        // absence here is a store with nothing more to show, not a footer that
        // never renders.
        await bootPopup({ storeSize: 3 })

        expect(codesOnScreen()).toEqual(['SAVE01', 'SAVE02', 'SAVE03'])
        expect(footer()).toBeNull()
        expect(requestedUrls).toHaveLength(1)
    })
})

describe('popup coupon list — scrolling into the next page', () => {
    it('fetches page 2 with the right parameters, through the real worker, and appends it', async () => {
        const { observer, sentMessages } = await bootPopup()
        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)

        observer.scrollIntoView()
        await settle()

        // The popup asked the worker for page 2...
        expect(sentMessages.map(m => m.page)).toEqual([1, 2])
        // ...and the worker turned that into the right request.
        expect(requestedUrls).toHaveLength(2)
        expect(requestedUrls[1].searchParams.get('page')).toBe('2')
        expect(requestedUrls[1].searchParams.get('limit')).toBe(
            String(PAGE_SIZE),
        )
        expect(requestedUrls[1].searchParams.get('site')).toBe(SITE)

        const codes = codesOnScreen()
        expect(codes).toHaveLength(PAGE_SIZE * 2)
        expect(codes[PAGE_SIZE]).toBe('SAVE21')
        expect(codes[codes.length - 1]).toBe('SAVE40')
        // Appended rows are real cards, not text: the badge markup came from
        // the same builder the first page used.
        expect(
            document.querySelectorAll('#couponList .coupon-badge'),
        ).toHaveLength(PAGE_SIZE * 2)
    })

    it('a code that shifts between pages is appended ONCE (no duplicates)', async () => {
        const { observer } = await bootPopup()
        const before = codesOnScreen()
        expect(before).toHaveLength(PAGE_SIZE)
        expect(new Set(before).size).toBe(PAGE_SIZE)

        // An ingest between the two requests pushes three page-1 rows down: the
        // live catalog is not a snapshot, and offset paging hands them back.
        servedRows.set(2, [
            CATALOG[17],
            CATALOG[18],
            CATALOG[19],
            ...CATALOG.slice(20, 37),
        ])

        observer.scrollIntoView()
        await settle()

        const after = codesOnScreen()
        expect(after).toEqual([...new Set(after)])
        // The three repeats were dropped; the 17 genuinely new rows landed.
        expect(after).toHaveLength(PAGE_SIZE + 17)
        expect(after.slice(0, PAGE_SIZE)).toEqual(before)
        expect(after[PAGE_SIZE]).toBe('SAVE21')
    })

    it('copy still works on a row that arrived with page 2', async () => {
        const { observer, copied } = await bootPopup()
        observer.scrollIntoView()
        await settle()

        const appended = [
            ...document.querySelectorAll('#couponList .coupon-item'),
        ].find(el => el.getAttribute('data-code') === 'SAVE30')
        expect(appended, 'a page-2 row is on screen').toBeTruthy()

        appended.dispatchEvent(new window.Event('click', { bubbles: true }))
        await settle()
        expect(copied).toEqual(['SAVE30'])
    })
})

describe('popup coupon list — the end of the catalog', () => {
    it('stops cleanly on the last page, says how many there were, and stops observing', async () => {
        const { observer } = await bootPopup()

        // 46 codes at 20 a page: two more pulls reach the end.
        observer.scrollIntoView()
        await settle()
        expect(codesOnScreen()).toHaveLength(40)
        expect(footer()).not.toBeNull()

        observer.scrollIntoView()
        await settle()

        expect(codesOnScreen()).toHaveLength(CATALOG_SIZE)
        expect(footer().textContent).toContain(
            `You've seen all ${CATALOG_SIZE} codes`,
        )
        expect(footer().hasAttribute('aria-busy')).toBe(false)
        expect(observer.instances.every(o => o.disconnected)).toBe(true)

        // And it does not keep asking: 3 requests for 3 pages, nothing more.
        expect(requestedUrls).toHaveLength(3)
    })
})

describe('popup coupon list — when a page fails', () => {
    it('leaves a quiet retry button instead of a spinner that never resolves, and the codes already on screen survive', async () => {
        const { observer } = await bootPopup()
        // Precondition: the happy path really does produce rows for this store.
        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)

        failPages.set(2, 1)
        observer.scrollIntoView()
        await settle()

        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)
        expect(footer().hasAttribute('aria-busy')).toBe(false)
        expect(footer().querySelector('.skeleton')).toBeNull()
        const retry = document.getElementById('couponLoadMoreBtn')
        expect(retry).not.toBeNull()
        expect(retry.textContent).toContain('Load more')
        // No error banner painted over a list that is still perfectly usable.
        expect(document.body.textContent).not.toContain("Couldn't load coupons")
    })

    it('the retry button actually loads the page that failed', async () => {
        const { observer } = await bootPopup()
        failPages.set(2, 1)
        observer.scrollIntoView()
        await settle()
        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)

        document
            .getElementById('couponLoadMoreBtn')
            .dispatchEvent(new window.Event('click', { bubbles: true }))
        await settle()

        expect(codesOnScreen()).toHaveLength(PAGE_SIZE * 2)
        expect(document.getElementById('couponLoadMoreBtn')).toBeNull()
    })

    it('a backend that claims more but returns nothing new ends at a button, never a loop', async () => {
        const { observer } = await bootPopup()
        // Every further page repeats page 1 while still claiming hasMore.
        for (const page of [2, 3, 4, 5, 6, 7]) {
            servedRows.set(page, {
                coupons: CATALOG.slice(0, PAGE_SIZE),
                hasMore: true,
            })
        }

        observer.scrollIntoView()
        await settle()

        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)
        expect(document.getElementById('couponLoadMoreBtn')).not.toBeNull()
        // Bounded: it gave up after a few empty pages rather than spinning.
        expect(requestedUrls.length).toBeLessThanOrEqual(5)
    })
})

describe('popup coupon list — without IntersectionObserver', () => {
    it('falls back to a Load more button that pages the list', async () => {
        await bootPopup({ withObserver: false })

        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)
        const button = document.getElementById('couponLoadMoreBtn')
        expect(button).not.toBeNull()

        button.dispatchEvent(new window.Event('click', { bubbles: true }))
        await settle()

        expect(codesOnScreen()).toHaveLength(PAGE_SIZE * 2)
        expect(requestedUrls[1].searchParams.get('page')).toBe('2')
    })
})

describe('popup coupon list — guest gate', () => {
    // OWNER RULE (2026-08-10): "for guests dont show all coupons". A guest gets
    // a teaser of GUEST_COUPON_LIMIT rows and a login gate naming the real
    // catalog size; the infinite scroll above is a member feature.
    const GUEST_LIMIT = 6

    it('caps a guest at the teaser with a gate naming the full count, and never wires the pager', async () => {
        const { observer } = await bootPopup({ signedIn: false })

        expect(codesOnScreen()).toHaveLength(GUEST_LIMIT)
        expect(footer()).toBeNull()
        // No live observer: scrolling a guest's list must not grow it.
        expect(observer.instances.filter(o => !o.disconnected)).toHaveLength(0)

        const gate = document.getElementById('couponGuestGate')
        expect(gate).not.toBeNull()
        expect(gate.textContent).toContain(
            `Showing ${GUEST_LIMIT} of ${CATALOG_SIZE} codes`,
        )
        const button = document.getElementById('couponLoginGateBtn')
        expect(button.textContent).toContain(
            `Log in to see all ${CATALOG_SIZE} codes`,
        )
        // One request, page 1 — the cap is presentation, not a smaller fetch,
        // so logging in can widen the list without a new contract.
        expect(requestedUrls).toHaveLength(1)
    })

    it('leaves a small store ungated — the gate only exists when it hides something', async () => {
        // Positive precondition: the deep-store boot above DOES gate, so an
        // absent gate here means "nothing hidden", not "gate never renders".
        await bootPopup({ signedIn: false, storeSize: 3 })

        expect(codesOnScreen()).toEqual(['SAVE01', 'SAVE02', 'SAVE03'])
        expect(document.getElementById('couponGuestGate')).toBeNull()
        expect(footer()).toBeNull()
    })

    it('sends the gate tap to the sign-in view', async () => {
        await bootPopup({ signedIn: false })

        const button = document.getElementById('couponLoginGateBtn')
        button.dispatchEvent(new window.Event('click', { bubbles: true }))
        await settle()

        // The coupon list is gone and the sign-in form is up.
        expect(document.getElementById('couponList')).toBeNull()
        expect(document.getElementById('loginForm')).not.toBeNull()
    })

    it('shows a member the full first page on the same store a guest sees capped', async () => {
        await bootPopup()

        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)
        expect(document.getElementById('couponGuestGate')).toBeNull()
        expect(footer()).not.toBeNull()
    })
})
