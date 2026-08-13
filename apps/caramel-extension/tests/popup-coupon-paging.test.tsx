import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import { initBackground } from '../background.js'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { App } from '../entrypoints/popup/App'

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
//
// P2-ported 2026-08-13 from popup-coupon-paging.test.mjs. The boot is now
// render(<App/>) instead of initPopup() — App resolves through the same
// popup-core branching and paints CouponsView — and rows are counted the way a
// screen reader finds them (each card is a button named "<title> — copy code
// <CODE>") instead of by reading #couponList's children. ONE pin changed
// shape: the guest gate's destination. The vanilla popup repainted
// #auth-container with #loginForm, while routing now belongs to App, so the
// pin is that tapping the gate LEAVES the coupon list for the sign-in
// surface — asserting on the sign-in form's own markup would pin a view this
// suite does not own.

const SITE = 'ebay.com'
const CATALOG_SIZE = 46
const PAGE_SIZE = 20

/** Every code the popup put on the clipboard, in order. */
const copiedText: string[] = []

/* The old harness overwrote the free global `caramelCopyText`. Its ESM
 * successor is NOT vi.mock('../UI-helpers.js'): UI-helpers ⇄ coupon-runner is a
 * real import cycle (documented at UI-helpers.js's import block), and mocking a
 * module inside a cycle is bypassed for whichever consumer binds while the
 * factory is still awaiting importOriginal() — a race whose winner depends on
 * evaluation order. Spreading importOriginal() would ALSO freeze that module's
 * one reassigned export (`export let _caramelShadowCssPromise`) at its
 * module-init null.
 *
 * So the boundary is stubbed instead of the module: navigator.clipboard is the
 * browser API the REAL caramelCopyText reaches for first, and jsdom ships no
 * clipboard at all. That runs more production code than the old global swap
 * did, and it cannot be raced. */
function installClipboardStub() {
    copiedText.length = 0
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
            writeText: async (text: string) => {
                copiedText.push(text)
            },
        },
    })
}

/** A coupon shaped like the /api/coupons rows the popup actually renders. */
function catalogRow(n: number) {
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
let requestedUrls: URL[] = []
/** Pages the HTTP layer should fail on (page number -> times remaining). */
let failPages = new Map<number, number>()
/** Optional override: page number -> rows to serve, or
 * `{ coupons, hasMore }` when the page must also lie about there being more
 * (both shapes a real catalog under concurrent ingest can produce). */
let servedRows = new Map<number, any>()

function installCatalogFetch(storeSize = CATALOG_SIZE) {
    requestedUrls = []
    failPages = new Map()
    servedRows = new Map()
    globalThis.fetch = (async (url: unknown) => {
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
    }) as any
}

/* ------------------------------------------------------------------ */
/*  Realms                                                             */
/* ------------------------------------------------------------------ */

let chromeStub: any
/** background.js's own onMessage handler, captured off the realm's stub. */
let backgroundHandler: any

/** Permissive chrome stub — the makeChromeStub/installChromeStub pair the old
 * tests/_load.mjs harness installed around every eval: anything not explicitly
 * set answers with a callable no-op, storage callbacks fire the way the real
 * API does, runtime.lastError starts UNDEFINED (a permissive proxy would
 * auto-create a truthy callable, which caramel-base.js reads as a closed
 * port), and onMessage.addListener records real listeners so a test can invoke
 * one. */
function installChromeStub() {
    const cache = new WeakMap()
    const wrap = (target: any): any => {
        if (cache.has(target)) return cache.get(target)
        const proxy = new Proxy(target, {
            get(obj: any, prop) {
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
        stub.storage[area].get = (_keys: unknown, cb: any) => {
            if (typeof cb === 'function') cb({})
        }
        stub.storage[area].set = (_items: unknown, cb: any) => {
            if (typeof cb === 'function') cb()
        }
        stub.storage[area].remove = (_keys: unknown, cb: any) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    const listeners: any[] = []
    stub.runtime.onMessage.addListener = (fn: any) => listeners.push(fn)
    stub.runtime.onMessage.removeListener = (fn: any) => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
    }
    stub.runtime.onMessage.hasListener = (fn: any) => listeners.includes(fn)
    ;(globalThis as any).chrome = stub
    ;(globalThis as any).browser = undefined
    ;(window as any).chrome = stub
    ;(window as any).browser = undefined
    // Installed ONCE per suite file — vitest gives each file its own jsdom
    // window, so caramel-base.js's first-run bootstrap latch is still unset and
    // this stub really becomes the realm's currentBrowser.
    initCaramelBase()
    return { stub, listeners }
}

/** Backs one storage area with a real object (tests/_load.mjs's
 * backStorageArea, inlined), so a test asserts on what the code actually
 * stored instead of on which API it called. */
function backStorageArea(area: string, data: Record<string, unknown> = {}) {
    const store = chromeStub.storage[area]
    store.get = (_keys: unknown, cb: any) => {
        if (typeof cb === 'function') cb({ ...data })
    }
    store.set = (items: Record<string, unknown>, cb: any) => {
        Object.assign(data, items)
        if (typeof cb === 'function') cb()
    }
    store.remove = (keys: string | string[], cb: any) => {
        for (const key of ([] as string[]).concat(keys)) delete data[key]
        if (typeof cb === 'function') cb()
    }
    return data
}

/** Stub IntersectionObserver: records observed targets and exposes a way to
 * say "the target scrolled into view". */
function installObserverStub() {
    const observed: any[] = []
    class StubIntersectionObserver {
        callback: any
        options: any
        target: any
        disconnected = false
        constructor(callback: any, options: any) {
            this.callback = callback
            this.options = options
            observed.push(this)
        }
        observe(target: any) {
            this.target = target
        }
        disconnect() {
            this.disconnected = true
        }
    }
    ;(globalThis as any).IntersectionObserver = StubIntersectionObserver
    return {
        instances: observed,
        /** Fires the newest live observer as if its target came into view, and
         *  lets the fetch → sendMessage → append chain settle. The observer is
         *  created in a layout effect AFTER paint, so under full-suite load it
         *  can register a beat after render() returns — wait for it instead of
         *  racing it (measured flaking in the 769-test run, 2026-08-13). */
        async scrollIntoView() {
            await waitFor(() => {
                if (!observed.some(o => !o.disconnected))
                    throw new Error('no live IntersectionObserver yet')
            })
            const live = observed.filter(o => !o.disconnected)
            const observer = live[live.length - 1]
            if (!observer) throw new Error('no live IntersectionObserver')
            await act(async () => {
                observer.callback(
                    [{ isIntersecting: true, target: observer.target }],
                    observer,
                )
                await new Promise(resolve => setTimeout(resolve, 0))
            })
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
    initBackground()
    ;[backgroundHandler] = installed.listeners
})

/** Boots the popup against the real background handler and renders page 1.
 * Returns the observer control plus what the popup rendered.
 *
 * `signedIn` defaults to true because the DEEP list is a member feature since
 * the guest cap (GUEST_COUPON_LIMIT in popup-core.js): every paging behavior
 * below only exists behind a session, and the "guest gate" suite at the bottom
 * is what pins the logged-out shape. */
async function bootPopup({
    withObserver = true,
    storeSize,
    signedIn = true,
}: {
    withObserver?: boolean
    storeSize?: number
    signedIn?: boolean
} = {}) {
    installCatalogFetch(storeSize)

    /** Every fetchCoupons message the popup sent to the worker. */
    const sentMessages: any[] = []
    chromeStub.runtime.sendMessage = (message: any, cb: any) => {
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
    chromeStub.storage.sync.get = (_keys: unknown, cb: any) => cb({})
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
    if (!withObserver) delete (globalThis as any).IntersectionObserver

    installClipboardStub()

    const view = render(<App />)
    // The list painting IS the boot signal: App resolves, then CouponsView
    // renders the page-1 envelope it was handed.
    await screen.findAllByRole('button', { name: CODE_CARD })

    return { observer, sentMessages, container: view.container }
}

/** Every coupon card is a button named "<title> — copy code <CODE>". */
const CODE_CARD = / — copy code /

const codesOnScreen = () =>
    screen
        .queryAllByRole('button', { name: CODE_CARD })
        .map(el =>
            (el.getAttribute('aria-label') || '').replace(
                /^.* — copy code /,
                '',
            ),
        )

const footer = (container: HTMLElement) =>
    container.querySelector('.coupon-list-footer')

const loadMoreButton = () =>
    screen.queryByRole('button', { name: 'Load more codes' })

describe('popup coupon list — first page', () => {
    it('renders the first page of codes and, because the store holds more, a footer to load the rest', async () => {
        const { container } = await bootPopup()

        const codes = codesOnScreen()
        expect(codes).toHaveLength(PAGE_SIZE)
        expect(codes[0]).toBe('SAVE01')
        expect(codes[PAGE_SIZE - 1]).toBe('SAVE20')
        expect(footer(container)).not.toBeNull()
    })

    it('asks for page 1 with NO page parameter, so the shipped request shape is unchanged', async () => {
        await bootPopup()

        expect(requestedUrls).toHaveLength(1)
        const url = requestedUrls[0]!
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
        const { container } = await bootPopup({ storeSize: 3 })

        expect(codesOnScreen()).toEqual(['SAVE01', 'SAVE02', 'SAVE03'])
        expect(footer(container)).toBeNull()
        expect(requestedUrls).toHaveLength(1)
    })
})

describe('popup coupon list — scrolling into the next page', () => {
    it('fetches page 2 with the right parameters, through the real worker, and appends it', async () => {
        const { observer, sentMessages, container } = await bootPopup()
        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)

        await observer!.scrollIntoView()

        // The popup asked the worker for page 2...
        expect(sentMessages.map(m => m.page)).toEqual([1, 2])
        // ...and the worker turned that into the right request.
        expect(requestedUrls).toHaveLength(2)
        expect(requestedUrls[1]!.searchParams.get('page')).toBe('2')
        expect(requestedUrls[1]!.searchParams.get('limit')).toBe(
            String(PAGE_SIZE),
        )
        expect(requestedUrls[1]!.searchParams.get('site')).toBe(SITE)

        const codes = codesOnScreen()
        expect(codes).toHaveLength(PAGE_SIZE * 2)
        expect(codes[PAGE_SIZE]).toBe('SAVE21')
        expect(codes[codes.length - 1]).toBe('SAVE40')
        // Appended rows are real cards, not text: the badge markup came from
        // the same builder the first page used.
        expect(container.querySelectorAll('.coupon-badge')).toHaveLength(
            PAGE_SIZE * 2,
        )
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

        await observer!.scrollIntoView()

        const after = codesOnScreen()
        expect(after).toEqual([...new Set(after)])
        // The three repeats were dropped; the 17 genuinely new rows landed.
        expect(after).toHaveLength(PAGE_SIZE + 17)
        expect(after.slice(0, PAGE_SIZE)).toEqual(before)
        expect(after[PAGE_SIZE]).toBe('SAVE21')
    })

    it('copy still works on a row that arrived with page 2', async () => {
        const { observer } = await bootPopup()
        await observer!.scrollIntoView()

        const appended = screen.getByRole('button', {
            name: /copy code SAVE30$/,
        })
        await userEvent.click(appended)

        await waitFor(() => expect(copiedText).toEqual(['SAVE30']))
    })
})

describe('popup coupon list — the end of the catalog', () => {
    it('stops cleanly on the last page, says how many there were, and stops observing', async () => {
        const { observer, container } = await bootPopup()

        // 46 codes at 20 a page: two more pulls reach the end.
        await observer!.scrollIntoView()
        expect(codesOnScreen()).toHaveLength(40)
        expect(footer(container)).not.toBeNull()

        await observer!.scrollIntoView()

        expect(codesOnScreen()).toHaveLength(CATALOG_SIZE)
        expect(footer(container)!.textContent).toContain(
            `You've seen all ${CATALOG_SIZE} codes`,
        )
        expect(footer(container)!.hasAttribute('aria-busy')).toBe(false)
        expect(observer!.instances.every(o => o.disconnected)).toBe(true)

        // And it does not keep asking: 3 requests for 3 pages, nothing more.
        expect(requestedUrls).toHaveLength(3)
    })
})

describe('popup coupon list — when a page fails', () => {
    it('leaves a quiet retry button instead of a spinner that never resolves, and the codes already on screen survive', async () => {
        const { observer, container } = await bootPopup()
        // Precondition: the happy path really does produce rows for this store.
        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)

        failPages.set(2, 1)
        await observer!.scrollIntoView()

        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)
        expect(footer(container)!.hasAttribute('aria-busy')).toBe(false)
        expect(footer(container)!.querySelector('.skeleton')).toBeNull()
        expect(loadMoreButton()).not.toBeNull()
        // No error banner painted over a list that is still perfectly usable.
        expect(document.body.textContent).not.toContain("Couldn't load coupons")
    })

    it('the retry button actually loads the page that failed', async () => {
        const { observer } = await bootPopup()
        failPages.set(2, 1)
        await observer!.scrollIntoView()
        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)

        await userEvent.click(loadMoreButton()!)

        await waitFor(() => expect(codesOnScreen()).toHaveLength(PAGE_SIZE * 2))
        expect(loadMoreButton()).toBeNull()
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

        await observer!.scrollIntoView()

        await waitFor(() => expect(loadMoreButton()).not.toBeNull())
        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)
        // Bounded: it gave up after a few empty pages rather than spinning.
        expect(requestedUrls.length).toBeLessThanOrEqual(5)
    })
})

describe('popup coupon list — without IntersectionObserver', () => {
    it('falls back to a Load more button that pages the list', async () => {
        await bootPopup({ withObserver: false })

        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)
        // The fallback is decided when the list mounts and the realm turns out
        // to have no IntersectionObserver, so it lands one commit after the
        // first page paints.
        await waitFor(() => expect(loadMoreButton()).not.toBeNull())

        await userEvent.click(loadMoreButton()!)

        await waitFor(() => expect(codesOnScreen()).toHaveLength(PAGE_SIZE * 2))
        expect(requestedUrls[1]!.searchParams.get('page')).toBe('2')
    })
})

describe('popup coupon list — guest gate', () => {
    // OWNER RULE (2026-08-10): "for guests dont show all coupons". A guest gets
    // a teaser of GUEST_COUPON_LIMIT rows and a login gate naming the real
    // catalog size; the infinite scroll above is a member feature.
    const GUEST_LIMIT = 6

    it('caps a guest at the teaser with a gate naming the full count, and never wires the pager', async () => {
        const { observer, container } = await bootPopup({ signedIn: false })

        expect(codesOnScreen()).toHaveLength(GUEST_LIMIT)
        expect(footer(container)).toBeNull()
        // No live observer: scrolling a guest's list must not grow it.
        expect(observer!.instances.filter(o => !o.disconnected)).toHaveLength(0)

        const gate = container.querySelector('.coupon-guest-gate')
        expect(gate).not.toBeNull()
        expect(gate!.textContent).toContain(
            `Showing ${GUEST_LIMIT} of ${CATALOG_SIZE} codes`,
        )
        expect(
            screen.getByRole('button', {
                name: `Log in to see all ${CATALOG_SIZE} codes`,
            }),
        ).toBeInTheDocument()
        // One request, page 1 — the cap is presentation, not a smaller fetch,
        // so logging in can widen the list without a new contract.
        expect(requestedUrls).toHaveLength(1)
    })

    it('leaves a small store ungated — the gate only exists when it hides something', async () => {
        // Positive precondition: the deep-store boot above DOES gate, so an
        // absent gate here means "nothing hidden", not "gate never renders".
        const { container } = await bootPopup({
            signedIn: false,
            storeSize: 3,
        })

        expect(codesOnScreen()).toEqual(['SAVE01', 'SAVE02', 'SAVE03'])
        expect(container.querySelector('.coupon-guest-gate')).toBeNull()
        expect(footer(container)).toBeNull()
    })

    it('sends the gate tap to the sign-in view', async () => {
        const { container } = await bootPopup({ signedIn: false })

        await userEvent.click(
            screen.getByRole('button', {
                name: `Log in to see all ${CATALOG_SIZE} codes`,
            }),
        )

        // The coupon list is gone: the tap left this view for the sign-in
        // surface (App owns which view is mounted — popup-signin-widgets pins
        // what that surface then shows).
        await waitFor(() => expect(codesOnScreen()).toHaveLength(0))
        expect(container.querySelector('.coupon-list')).toBeNull()
    })

    it('shows a member the full first page on the same store a guest sees capped', async () => {
        const { container } = await bootPopup()

        expect(codesOnScreen()).toHaveLength(PAGE_SIZE)
        expect(container.querySelector('.coupon-guest-gate')).toBeNull()
        expect(footer(container)).not.toBeNull()
    })
})
