import {
    act,
    cleanup,
    render,
    screen,
    waitFor,
    within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { initBackground } from '../background.js'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { ToastProvider } from '../entrypoints/popup/components/toast'
import {
    HIDDEN_COUPONS_KEY,
    PENDING_VOTE_KEY,
    VOTED_COUPONS_KEY,
} from '../entrypoints/popup/couponVote'
import type { AppApi, Coupon, CouponsPage } from '../entrypoints/popup/types'
import { CouponsView } from '../entrypoints/popup/views/CouponsView'

// Issue #288, popup side: the "Did it work?" prompt, the per-shopper hide and
// the keepsFailing disclosure, driven through the REAL CouponsView, the REAL
// storage module and the REAL background handlers. Only the edges are stubbed:
// storage.local (an in-memory map with chrome's callback shape), window.close,
// the clipboard, IntersectionObserver and fetch (so the vote POST and the
// catalog pages can be asserted/served — nothing here can reach the network).

const SITE = 'shop.example'
const COUPONS: Coupon[] = [
    { id: 1, code: 'GOOD10', title: 'Good code', status: 'valid' },
    {
        id: 2,
        code: 'BAD20',
        title: 'Keeps failing',
        status: 'valid',
        keepsFailing: true,
    },
    { id: 3, code: 'OK30', title: 'Another code', status: 'valid' },
]

type Respond = (response?: unknown) => void
type BackgroundHandler = (
    message: unknown,
    sender: unknown,
    respond: Respond,
) => boolean | void
type StorageGet = (
    keys: string[],
    cb: (res: Record<string, unknown>) => void,
) => void
type StorageSet = (items: Record<string, unknown>, cb?: () => void) => void

/** The slice of the permissive chrome stub these tests drive. */
interface ChromeStub {
    storage: Record<
        'sync' | 'local' | 'session',
        { get: StorageGet; set: StorageSet }
    >
    runtime: {
        lastError: unknown
        sendMessage: (message: unknown, cb: Respond) => void
        onMessage: { addListener: (fn: BackgroundHandler) => void }
    }
}

interface FetchCall {
    url: string
    body: { outcome?: string } | undefined
}

let stub: ChromeStub
let backgroundHandler: BackgroundHandler
let storage: Record<string, unknown>
let fetchCalls: FetchCall[]
let reportStatus: number | 'network'
/** catalog page number -> the page the (stubbed) API serves. */
let catalogPages: Record<number, CouponsPage>

/** Permissive chrome stub: anything not set answers with a callable no-op,
 *  the way the real API surface is merely "present". */
function installChromeStub() {
    const cache = new WeakMap<object, object>()
    const wrap = (target: Record<string, unknown>): object => {
        const hit = cache.get(target)
        if (hit) return hit
        const proxy = new Proxy(target, {
            get(obj, prop) {
                if (prop === 'then' || typeof prop === 'symbol')
                    return undefined
                if (!(prop in obj))
                    obj[prop] = wrap(function () {} as unknown as Record<
                        string,
                        unknown
                    >)
                return obj[prop]
            },
            apply: () => undefined,
        })
        cache.set(target, proxy)
        return proxy
    }
    const root = wrap(function chromeStubRoot() {} as unknown as Record<
        string,
        unknown
    >) as unknown as ChromeStub
    root.runtime.lastError = undefined
    const listeners: BackgroundHandler[] = []
    root.runtime.onMessage.addListener = fn => listeners.push(fn)
    const realm = globalThis as unknown as Record<string, unknown>
    realm.chrome = root
    realm.browser = undefined
    ;(window as unknown as Record<string, unknown>).chrome = root
    ;(window as unknown as Record<string, unknown>).browser = undefined
    realm.ServiceWorkerGlobalScope = { [Symbol.hasInstance]: () => true }
    initCaramelBase()
    return { root, listeners }
}

function wireStorage() {
    for (const area of ['sync', 'session'] as const) {
        stub.storage[area].get = (_keys, cb) => cb({})
        stub.storage[area].set = (_items, cb) => cb?.()
    }
    stub.storage.local.get = (keys, cb) =>
        cb(Object.fromEntries(keys.map(k => [k, storage[k]])))
    stub.storage.local.set = (items, cb) => {
        Object.assign(storage, items)
        cb?.()
    }
    // The popup reaches the worker by message, exactly as in a real browser.
    stub.runtime.sendMessage = (message, cb) =>
        void backgroundHandler(message, {}, cb)
}

function wireFetch() {
    fetchCalls = []
    globalThis.fetch = (async (url: unknown, opts?: { body?: string }) => {
        const parsed = new URL(String(url))
        fetchCalls.push({
            url: String(url),
            body: opts?.body ? JSON.parse(opts.body) : undefined,
        })
        if (parsed.pathname === '/api/coupons') {
            const page = Number(parsed.searchParams.get('page') ?? 1)
            const served = catalogPages[page]
            if (!served) throw new Error(`no stub catalog page ${page}`)
            return { ok: true, status: 200, json: async () => served }
        }
        if (reportStatus === 'network') throw new TypeError('network down')
        return {
            ok: reportStatus >= 200 && reportStatus < 300,
            status: reportStatus,
            json: async () => ({ ok: true }),
        }
    }) as typeof fetch
}

function installClipboard() {
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => {} },
    })
}

/** Records every observer the view creates; a test fires the newest live one
 *  to say "the footer scrolled into view". */
class FakeIntersectionObserver {
    static instances: FakeIntersectionObserver[] = []
    live = true
    constructor(public callback: IntersectionObserverCallback) {
        FakeIntersectionObserver.instances.push(this)
    }
    observe() {}
    disconnect() {
        this.live = false
    }
}

async function scrollFooterIntoView() {
    await waitFor(() => {
        if (!FakeIntersectionObserver.instances.some(o => o.live))
            throw new Error('no live IntersectionObserver yet')
    })
    const observer = FakeIntersectionObserver.instances
        .filter(o => o.live)
        .at(-1)!
    await act(async () => {
        observer.callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            observer as unknown as IntersectionObserver,
        )
        await new Promise(resolve => setTimeout(resolve, 0))
    })
}

const makeApi = (): AppApi => ({
    openSignIn: vi.fn(),
    closeOverlay: vi.fn(),
    refresh: vi.fn(),
})

const pendingRecord = (over: Record<string, unknown> = {}) => ({
    couponId: '1',
    code: 'GOOD10',
    site: SITE,
    copiedAt: Date.now() - 5 * 60 * 1000,
    ...over,
})

function renderView(
    coupons: Coupon[] = COUPONS,
    page: Partial<CouponsPage> = {},
) {
    return render(
        <ToastProvider>
            <CouponsView
                coupons={coupons}
                user={{ username: 'tester', image: '' }}
                domain={SITE}
                page={{ coupons, ...page }}
                api={makeApi()}
            />
        </ToastProvider>,
    )
}

const reportCalls = () =>
    fetchCalls.filter(c => /\/api\/coupons\/\d+\/report$/.test(c.url))
const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 30))
    })

beforeAll(() => {
    const installed = installChromeStub()
    stub = installed.root
    initCouponConstants()
    initBackground()
    ;[backgroundHandler] = installed.listeners as [BackgroundHandler]
})

beforeEach(() => {
    storage = {}
    reportStatus = 200
    catalogPages = {}
    FakeIntersectionObserver.instances = []
    Reflect.deleteProperty(globalThis, 'IntersectionObserver')
    wireStorage()
    wireFetch()
    installClipboard()
    window.close = vi.fn()
})
afterEach(() => cleanup())

describe('the "Did it work?" prompt', () => {
    it('asks about the code copied earlier on this store, as a labelled group', async () => {
        storage[PENDING_VOTE_KEY] = pendingRecord()
        renderView()

        const group = await screen.findByRole('group', {
            name: /Did GOOD10 work\?/,
        })
        expect(
            within(group).getByRole('button', { name: 'Yes, it worked' }),
        ).toBeEnabled()
        expect(
            within(group).getByRole('button', { name: "No, it didn't" }),
        ).toBeEnabled()
    })

    it('keeps the live region rendered (and empty) while it has nothing to say', async () => {
        storage[PENDING_VOTE_KEY] = pendingRecord()
        const { container } = renderView()
        await screen.findByRole('group', { name: /Did GOOD10 work\?/ })

        const region = container.querySelector('.coupon-vote-msg')
        expect(region).not.toBeNull()
        expect(region).toHaveAttribute('aria-live', 'polite')
        expect(region).toBeEmptyDOMElement()
    })

    it.each([
        ['another store', { site: 'other.example' }],
        ['a copy older than 2h', { copiedAt: Date.now() - 3 * 3600 * 1000 }],
    ])('does not ask about %s', async (_label, over) => {
        storage[PENDING_VOTE_KEY] = pendingRecord(over)
        renderView()
        await screen.findByText('Good code')
        await settle()
        expect(screen.queryByRole('group', { name: /Did .* work/ })).toBeNull()
    })

    it('does not ask again once that coupon was voted on', async () => {
        storage[PENDING_VOTE_KEY] = pendingRecord()
        storage[VOTED_COUPONS_KEY] = ['1']
        renderView()
        await screen.findByText('Good code')
        await settle()
        expect(screen.queryByRole('group', { name: /Did .* work/ })).toBeNull()
    })

    it('clears a pending copy that is past the window when it is read, but keeps a fresh one for another store', async () => {
        storage[PENDING_VOTE_KEY] = pendingRecord({
            copiedAt: Date.now() - 3 * 3600 * 1000,
        })
        renderView()
        await waitFor(() => expect(storage[PENDING_VOTE_KEY]).toBeNull())
        cleanup()

        const fresh = pendingRecord({ site: 'other.example' })
        storage[PENDING_VOTE_KEY] = fresh
        renderView()
        await screen.findByText('Good code')
        await settle()
        expect(storage[PENDING_VOTE_KEY]).toEqual(fresh)
    })

    it('Yes: POSTs outcome=worked through the existing report path, announces thanks, remembers the vote', async () => {
        storage[PENDING_VOTE_KEY] = pendingRecord()
        renderView()

        await userEvent.click(
            await screen.findByRole('button', { name: 'Yes, it worked' }),
        )

        const thanks = await screen.findByText(
            'Thanks! Your answer helps other shoppers.',
        )
        expect(reportCalls()).toHaveLength(1)
        expect(reportCalls()[0]!.url).toMatch(/\/api\/coupons\/1\/report$/)
        expect(reportCalls()[0]!.body?.outcome).toBe('worked')
        // A vote is not an apply: no usage-counter bump.
        expect(fetchCalls.some(c => c.url.endsWith('coupons/increment'))).toBe(
            false,
        )
        expect(storage[VOTED_COUPONS_KEY]).toEqual(['1'])
        expect(storage[PENDING_VOTE_KEY]).toBeNull()
        // The thanks lives in the polite live region; the question is gone.
        expect(thanks.closest('[aria-live="polite"]')).not.toBeNull()
        expect(screen.queryByRole('group', { name: /Did .* work/ })).toBeNull()
        // "Yes" hides nothing.
        expect(screen.queryByText(/Hidden codes/)).toBeNull()
    })

    it('after an answer, focus moves to the thanks instead of falling to <body>', async () => {
        storage[PENDING_VOTE_KEY] = pendingRecord()
        renderView()
        await userEvent.click(
            await screen.findByRole('button', { name: 'Yes, it worked' }),
        )
        const thanks = await screen.findByText(
            'Thanks! Your answer helps other shoppers.',
        )
        await waitFor(() => expect(thanks).toHaveFocus())
    })

    it('No: POSTs outcome=failed, then hides the code for this shopper', async () => {
        storage[PENDING_VOTE_KEY] = pendingRecord()
        renderView()

        await userEvent.click(
            await screen.findByRole('button', { name: "No, it didn't" }),
        )

        const thanks = await screen.findByText(
            "Thanks! We've hidden GOOD10 for you.",
        )
        await waitFor(() => expect(thanks).toHaveFocus())
        expect(reportCalls()[0]!.body?.outcome).toBe('failed')
        expect(storage[HIDDEN_COUPONS_KEY]).toEqual(['1'])
        expect(storage[VOTED_COUPONS_KEY]).toEqual(['1'])
        // Gone from the main list, present under the collapsed disclosure.
        expect(screen.queryByLabelText(/copy code GOOD10/)).toBeNull()
        const toggle = screen.getByRole('button', { name: 'Hidden codes (1)' })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
    })

    it.each([
        [500, "Couldn't send that. Try again."],
        [429, 'Too many answers just now. Try again in a minute.'],
        ['network' as const, "Couldn't send that. Try again."],
    ])(
        'a failed send (%s) shows an inline error, stays retryable (and focused), remembers nothing',
        async (status, message) => {
            storage[PENDING_VOTE_KEY] = pendingRecord()
            reportStatus = status
            renderView()

            const yes = await screen.findByRole('button', {
                name: 'Yes, it worked',
            })
            await userEvent.click(yes)

            await screen.findByText(message)
            expect(storage[VOTED_COUPONS_KEY]).toBeUndefined()
            expect(storage[PENDING_VOTE_KEY]).not.toBeNull()
            // Not `disabled`: a disabled control drops keyboard focus.
            expect(yes).not.toHaveAttribute('aria-disabled', 'true')
            expect(yes).toHaveFocus()
            // The failure is logged through the extension's error mechanism.
            const timings = (storage.caramel_timings ?? []) as {
                event: string
                meta: { where: string }
            }[]
            expect(
                timings.some(
                    t => t.event === 'ERROR' && t.meta.where === 'couponVote',
                ),
            ).toBe(true)

            // Retry succeeds once the server is back.
            reportStatus = 200
            await userEvent.click(yes)
            await screen.findByText('Thanks! Your answer helps other shoppers.')
            expect(storage[VOTED_COUPONS_KEY]).toEqual(['1'])
        },
    )

    it('a 404 (the code left the catalog) says it is no longer listed: not logged as an error, not retryable, and not asked again', async () => {
        storage[PENDING_VOTE_KEY] = pendingRecord()
        reportStatus = 404
        renderView()

        await userEvent.click(
            await screen.findByRole('button', { name: 'Yes, it worked' }),
        )

        await screen.findByText('That code is no longer listed.')
        expect(
            screen.queryByRole('button', { name: 'Yes, it worked' }),
        ).toBeNull()
        expect(screen.queryByText("Couldn't send that. Try again.")).toBeNull()
        expect(reportCalls()).toHaveLength(1)
        expect(storage[VOTED_COUPONS_KEY]).toBeUndefined()
        await waitFor(() => expect(storage[PENDING_VOTE_KEY]).toBeNull())
        const timings = (storage.caramel_timings ?? []) as {
            event: string
            meta: { where: string }
        }[]
        expect(
            timings.some(
                t => t.event === 'ERROR' && t.meta.where === 'couponVote',
            ),
        ).toBe(false)
    })

    it('"Not now" dismisses the prompt, clears the pending record, and hands focus to the list', async () => {
        storage[PENDING_VOTE_KEY] = pendingRecord()
        renderView()

        await userEvent.click(
            await screen.findByRole('button', { name: 'Not now' }),
        )

        expect(screen.queryByRole('group', { name: /Did .* work/ })).toBeNull()
        await waitFor(() => expect(storage[PENDING_VOTE_KEY]).toBeNull())
        expect(reportCalls()).toHaveLength(0)
        expect(document.getElementById('couponList')).toHaveFocus()
    })
})

describe('copying remembers the code for the next open', () => {
    it('a successful copy stores {couponId, code, site, copiedAt} before the popup closes', async () => {
        renderView()
        const before = Date.now()
        await userEvent.click(
            await screen.findByRole('button', { name: /copy code OK30/ }),
        )
        await screen.findByText('Copied "OK30" to clipboard!')

        const saved = storage[PENDING_VOTE_KEY] as {
            couponId: string
            code: string
            site: string
            copiedAt: number
        }
        expect(saved).toMatchObject({
            couponId: '3',
            code: 'OK30',
            site: SITE,
        })
        expect(saved.copiedAt).toBeGreaterThanOrEqual(before)
        // Not asked in the same session: the question is for the NEXT open.
        expect(screen.queryByRole('group', { name: /Did .* work/ })).toBeNull()
    })
})

describe('per-shopper hide', () => {
    it('Hide moves a code into the hidden disclosure; Unhide brings it back', async () => {
        renderView()

        await userEvent.click(
            await screen.findByRole('button', { name: 'Hide code GOOD10' }),
        )
        expect(
            screen.queryByRole('button', { name: /copy code GOOD10/ }),
        ).toBeNull()
        expect(storage[HIDDEN_COUPONS_KEY]).toEqual(['1'])

        const toggle = screen.getByRole('button', { name: 'Hidden codes (1)' })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        await userEvent.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'true')

        await userEvent.click(
            screen.getByRole('button', { name: 'Unhide code GOOD10' }),
        )
        expect(
            await screen.findByRole('button', { name: /copy code GOOD10/ }),
        ).toBeTruthy()
        expect(storage[HIDDEN_COUPONS_KEY]).toEqual([])
        expect(screen.queryByText(/Hidden codes/)).toBeNull()
    })

    it('keeps focus on the page: Hide hands it to the neighbouring row, and to the list when none is left', async () => {
        renderView()

        // GOOD10 and OK30 are the main list; hiding GOOD10 focuses OK30's Hide.
        await userEvent.click(
            await screen.findByRole('button', { name: 'Hide code GOOD10' }),
        )
        expect(
            screen.getByRole('button', { name: 'Hide code OK30' }),
        ).toHaveFocus()

        // Hiding the last main row has no neighbour in the main list.
        await userEvent.click(
            screen.getByRole('button', { name: 'Hide code OK30' }),
        )
        expect(document.getElementById('couponList')).toHaveFocus()

        // Unhide GOOD10 (OK30 stays): the neighbour inside the disclosure.
        await userEvent.click(
            screen.getByRole('button', { name: 'Hidden codes (2)' }),
        )
        await userEvent.click(
            screen.getByRole('button', { name: 'Unhide code GOOD10' }),
        )
        expect(
            screen.getByRole('button', { name: 'Unhide code OK30' }),
        ).toHaveFocus()

        // Unhiding the last hidden code removes the whole disclosure.
        await userEvent.click(
            screen.getByRole('button', { name: 'Unhide code OK30' }),
        )
        expect(screen.queryByText(/Hidden codes/)).toBeNull()
        expect(document.getElementById('couponList')).toHaveFocus()
    })

    it('hidden ids persisted from an earlier open are applied on mount', async () => {
        storage[HIDDEN_COUPONS_KEY] = ['3']
        renderView()
        await screen.findByRole('button', { name: 'Hidden codes (1)' })
        expect(
            screen.queryByRole('button', { name: /copy code OK30/ }),
        ).toBeNull()
    })

    it('a failed hide write is reported, not swallowed', async () => {
        renderView()
        const hideBtn = await screen.findByRole('button', {
            name: 'Hide code GOOD10',
        })
        stub.storage.local.get = () => {
            throw new Error('storage gone')
        }
        await userEvent.click(hideBtn)
        await screen.findByText("Couldn't save that — please try again")
    })
})

describe('codes that keep failing (server keepsFailing)', () => {
    it('are out of the main list and under a collapsed disclosure, still copyable once opened', async () => {
        renderView()

        // Main list: the two healthy codes only.
        await screen.findByRole('button', { name: /copy code GOOD10/ })
        expect(
            screen.getByRole('button', { name: /copy code OK30/ }),
        ).toBeTruthy()
        expect(
            screen.queryByRole('button', { name: /copy code BAD20/ }),
        ).toBeNull()

        const toggle = screen.getByRole('button', {
            name: '1 code reported not working',
        })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')

        await userEvent.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        await userEvent.click(
            screen.getByRole('button', { name: /copy code BAD20/ }),
        )
        await screen.findByText('Copied "BAD20" to clipboard!')
    })

    it('uses the plural for several failing codes', async () => {
        renderView([
            { id: 1, code: 'A', keepsFailing: true },
            { id: 2, code: 'B', keepsFailing: true },
            { id: 3, code: 'C' },
        ])
        await screen.findByRole('button', {
            name: '2 codes reported not working',
        })
    })

    it('an older server that omits keepsFailing shows every code in the main list', async () => {
        renderView(COUPONS.map(({ keepsFailing: _drop, ...rest }) => rest))
        await screen.findByRole('button', { name: /copy code BAD20/ })
        expect(screen.queryByText(/reported not working/)).toBeNull()
    })

    it('when every code keeps failing, says so instead of the "no coupons" line', async () => {
        renderView([{ id: 1, code: 'ONLY', keepsFailing: true }])
        await screen.findByText('No other codes to show right now.')
        expect(
            screen.getByRole('button', { name: '1 code reported not working' }),
        ).toBeTruthy()
    })
})

describe('paging with the disclosures', () => {
    const row = (id: number, over: Partial<Coupon> = {}): Coupon => ({
        id,
        code: `P${id}`,
        title: `Paged ${id}`,
        status: 'valid',
        ...over,
    })
    const page1 = [row(1), row(2)]
    const envelope = (
        page: number,
        coupons: Coupon[],
        hasMore: boolean,
    ): CouponsPage => ({ coupons, page, total: 8, hasMore })

    beforeEach(() => {
        ;(
            globalThis as unknown as Record<string, unknown>
        ).IntersectionObserver = FakeIntersectionObserver
    })

    it('renders the disclosures ABOVE the footer, so the loading ghost never sits over them', async () => {
        renderView([row(1), row(2, { keepsFailing: true })], {
            page: 1,
            total: 8,
            hasMore: true,
        })
        const toggle = await screen.findByRole('button', {
            name: '1 code reported not working',
        })
        const footer = document.getElementById('couponListFooter')!
        expect(
            toggle.compareDocumentPosition(footer) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy()
    })

    it('a page that is ALL flagged does not strand the loader: it keeps pulling until the main list grows', async () => {
        catalogPages = {
            2: envelope(
                2,
                [
                    row(3, { keepsFailing: true }),
                    row(4, { keepsFailing: true }),
                ],
                true,
            ),
            3: envelope(3, [row(5), row(6)], false),
        }
        renderView(page1, { page: 1, total: 8, hasMore: true })
        await screen.findByRole('button', { name: /copy code P1/ })

        await scrollFooterIntoView()

        // One scroll event pulled BOTH pages; the healthy rows of page 3 landed.
        await screen.findByRole('button', { name: /copy code P5/ })
        expect(
            fetchCalls
                .filter(c => c.url.includes('/api/coupons?'))
                .map(c => new URL(c.url).searchParams.get('page')),
        ).toEqual(['2', '3'])
        expect(
            screen.getByRole('button', {
                name: '2 codes reported not working',
            }),
        ).toBeTruthy()
        // ...and the loader is finished, not a skeleton left spinning.
        expect(await screen.findByText(/You've seen all 8 codes/)).toBeTruthy()
    })

    it('a page that is ALL hidden by this shopper behaves the same', async () => {
        storage[HIDDEN_COUPONS_KEY] = ['3', '4']
        catalogPages = {
            2: envelope(2, [row(3), row(4)], true),
            3: envelope(3, [row(5), row(6)], false),
        }
        renderView(page1, { page: 1, total: 8, hasMore: true })
        await screen.findByRole('button', { name: /copy code P1/ })
        await settle() // the hide list loads from storage after mount

        await scrollFooterIntoView()

        await screen.findByRole('button', { name: /copy code P5/ })
        expect(
            screen.getByRole('button', { name: 'Hidden codes (2)' }),
        ).toBeTruthy()
        expect(await screen.findByText(/You've seen all 8 codes/)).toBeTruthy()
    })

    it('stops chasing after a few empty pages and offers the button instead of looping', async () => {
        catalogPages = {
            2: envelope(2, [row(3, { keepsFailing: true })], true),
            3: envelope(3, [row(4, { keepsFailing: true })], true),
            4: envelope(4, [row(5, { keepsFailing: true })], true),
            5: envelope(5, [row(6)], false),
        }
        renderView(page1, { page: 1, total: 8, hasMore: true })
        await screen.findByRole('button', { name: /copy code P1/ })

        await scrollFooterIntoView()

        await screen.findByRole('button', { name: 'Load more codes' })
        expect(
            fetchCalls.filter(c => c.url.includes('/api/coupons?')),
        ).toHaveLength(3)
    })
})
