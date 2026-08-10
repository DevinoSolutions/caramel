import { beforeEach, describe, expect, it } from 'vitest'
import {
    getOnMessageListeners,
    loadExtensionSource,
    loadExtensionSources,
} from './_load.mjs'

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

/** Boots the popup against the real background handler and renders page 1.
 * Returns the observer control plus what the popup rendered. */
async function bootPopup({ withObserver = true, storeSize } = {}) {
    installCatalogFetch(storeSize)

    // Realm A — the REAL service worker. Its handler stays callable after the
    // popup realm is built: it closed over its own chrome stub and its own
    // caramelUrl, and reaches the network through the fetch stub above.
    loadExtensionSource('background.js', [])
    const [backgroundHandler] = getOnMessageListeners()

    // Realm B — the REAL popup, same file order as index.html.
    document.body.innerHTML =
        '<div id="loading-container"></div><div id="auth-container"></div>'
    loadExtensionSource('coupon-constants.generated.js', [])
    loadExtensionSources(
        [
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
            'UI-helpers.js',
        ],
        [],
    )

    /** Every fetchCoupons message the popup sent to the worker. */
    const sentMessages = []
    globalThis.currentBrowser.runtime.sendMessage = (message, cb) => {
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
    globalThis.currentBrowser.storage.sync.get = (_keys, cb) => cb({})

    const observer = withObserver ? installObserverStub() : null
    if (!withObserver) delete globalThis.IntersectionObserver

    const copied = []
    globalThis.caramelCopyText = async text => {
        copied.push(text)
        return true
    }

    const { initPopup } = loadExtensionSource('popup.js', ['initPopup'])
    const painted = new Promise(resolve => {
        const original = globalThis.renderCouponsView
        globalThis.renderCouponsView = (...args) => {
            const result = original(...args)
            resolve()
            return result
        }
    })
    await initPopup()
    await painted

    return { observer, sentMessages, copied }
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
