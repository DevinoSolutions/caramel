import {
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
import type { AppApi, Coupon } from '../entrypoints/popup/types'
import { CouponsView } from '../entrypoints/popup/views/CouponsView'

// Issue #288, popup side: the "Did it work?" prompt, the per-shopper hide and
// the keepsFailing disclosure, driven through the REAL CouponsView, the REAL
// storage module and the REAL background `reportOutcome` handler. Only the
// edges are stubbed: storage.local (an in-memory map with chrome's callback
// shape), window.close, the clipboard and fetch (so the vote POST can be
// asserted — nothing here can reach the network).

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

let stub: any
let backgroundHandler: any
let storage: Record<string, unknown>
let fetchCalls: { url: string; body: any }[]
let reportStatus: number | 'network'

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
    const root = wrap(function chromeStubRoot() {})
    root.runtime.lastError = undefined
    const listeners: any[] = []
    root.runtime.onMessage.addListener = (fn: any) => listeners.push(fn)
    ;(globalThis as any).chrome = root
    ;(globalThis as any).browser = undefined
    ;(window as any).chrome = root
    ;(window as any).browser = undefined
    ;(globalThis as any).ServiceWorkerGlobalScope = {
        [Symbol.hasInstance]: () => true,
    }
    initCaramelBase()
    return { root, listeners }
}

function wireStorage() {
    for (const area of ['sync', 'session']) {
        stub.storage[area].get = (_k: unknown, cb: any) => cb?.({})
        stub.storage[area].set = (_i: unknown, cb: any) => cb?.()
    }
    stub.storage.local.get = (keys: string[], cb: any) =>
        cb(Object.fromEntries(keys.map(k => [k, storage[k]])))
    stub.storage.local.set = (items: Record<string, unknown>, cb: any) => {
        Object.assign(storage, items)
        cb?.()
    }
    // The popup reaches the worker by message, exactly as in a real browser.
    stub.runtime.sendMessage = (message: any, cb: any) =>
        backgroundHandler(message, {}, cb)
}

function wireFetch() {
    fetchCalls = []
    globalThis.fetch = (async (url: unknown, opts: any) => {
        fetchCalls.push({
            url: String(url),
            body: opts?.body ? JSON.parse(opts.body) : undefined,
        })
        if (reportStatus === 'network') throw new TypeError('network down')
        return {
            ok: reportStatus >= 200 && reportStatus < 300,
            status: reportStatus,
            json: async () => ({ ok: true }),
        }
    }) as any
}

function installClipboard() {
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => {} },
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

function renderView(coupons: Coupon[] = COUPONS) {
    return render(
        <ToastProvider>
            <CouponsView
                coupons={coupons}
                user={{ username: 'tester', image: '' }}
                domain={SITE}
                page={{ coupons }}
                api={makeApi()}
            />
        </ToastProvider>,
    )
}

const reportCalls = () =>
    fetchCalls.filter(c => /\/api\/coupons\/\d+\/report$/.test(c.url))

beforeAll(() => {
    const installed = installChromeStub()
    stub = installed.root
    initCouponConstants()
    initBackground()
    ;[backgroundHandler] = installed.listeners
    delete (globalThis as any).IntersectionObserver
})

beforeEach(() => {
    storage = {}
    reportStatus = 200
    wireStorage()
    wireFetch()
    installClipboard()
    window.close = vi.fn() as any
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

    it.each([
        ['another store', { site: 'other.example' }],
        ['a copy older than 2h', { copiedAt: Date.now() - 3 * 3600 * 1000 }],
    ])('does not ask about %s', async (_label, over) => {
        storage[PENDING_VOTE_KEY] = pendingRecord(over)
        renderView()
        await screen.findByText('Good code')
        await new Promise(r => setTimeout(r, 30))
        expect(screen.queryByRole('group', { name: /Did .* work/ })).toBeNull()
    })

    it('does not ask again once that coupon was voted on', async () => {
        storage[PENDING_VOTE_KEY] = pendingRecord()
        storage[VOTED_COUPONS_KEY] = ['1']
        renderView()
        await screen.findByText('Good code')
        await new Promise(r => setTimeout(r, 30))
        expect(screen.queryByRole('group', { name: /Did .* work/ })).toBeNull()
    })

    it('Yes: POSTs outcome=worked through the existing report path, announces thanks, remembers the vote', async () => {
        storage[PENDING_VOTE_KEY] = pendingRecord()
        renderView()

        await userEvent.click(
            await screen.findByRole('button', { name: 'Yes, it worked' }),
        )

        await screen.findByText('Thanks! Your answer helps other shoppers.')
        expect(reportCalls()).toHaveLength(1)
        expect(reportCalls()[0]!.url).toMatch(/\/api\/coupons\/1\/report$/)
        expect(reportCalls()[0]!.body.outcome).toBe('worked')
        // A vote is not an apply: no usage-counter bump.
        expect(fetchCalls.some(c => c.url.endsWith('coupons/increment'))).toBe(
            false,
        )
        expect(storage[VOTED_COUPONS_KEY]).toEqual(['1'])
        expect(storage[PENDING_VOTE_KEY]).toBeNull()
        // The thanks lives in a polite live region; the question is gone.
        expect(
            screen
                .getByText('Thanks! Your answer helps other shoppers.')
                .closest('[aria-live="polite"]'),
        ).not.toBeNull()
        expect(screen.queryByRole('group', { name: /Did .* work/ })).toBeNull()
        // "Yes" hides nothing.
        expect(screen.queryByText(/Hidden codes/)).toBeNull()
    })

    it('No: POSTs outcome=failed, then hides the code for this shopper', async () => {
        storage[PENDING_VOTE_KEY] = pendingRecord()
        renderView()

        await userEvent.click(
            await screen.findByRole('button', { name: "No, it didn't" }),
        )

        await screen.findByText("Thanks! We've hidden GOOD10 for you.")
        expect(reportCalls()[0]!.body.outcome).toBe('failed')
        expect(storage[HIDDEN_COUPONS_KEY]).toEqual(['1'])
        expect(storage[VOTED_COUPONS_KEY]).toEqual(['1'])
        // Gone from the main list, present under the collapsed disclosure.
        expect(screen.queryByLabelText(/copy code GOOD10/)).toBeNull()
        const toggle = screen.getByRole('button', {
            name: 'Hidden codes (1) — show',
        })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
    })

    it.each([
        [500, "Couldn't send that. Try again."],
        [429, 'Too many answers just now. Try again in a minute.'],
        ['network' as const, "Couldn't send that. Try again."],
    ])(
        'a failed send (%s) shows an inline error, stays retryable, remembers nothing',
        async (status, message) => {
            storage[PENDING_VOTE_KEY] = pendingRecord()
            reportStatus = status
            renderView()

            await userEvent.click(
                await screen.findByRole('button', { name: 'Yes, it worked' }),
            )

            await screen.findByText(message)
            expect(storage[VOTED_COUPONS_KEY]).toBeUndefined()
            expect(storage[PENDING_VOTE_KEY]).toEqual(
                pendingRecord({
                    copiedAt: (storage[PENDING_VOTE_KEY] as any).copiedAt,
                }),
            )
            // The failure is logged through the extension's error mechanism.
            const timings = storage.caramel_timings as any[] | undefined
            expect(
                (timings ?? []).some(
                    t => t.event === 'ERROR' && t.meta.where === 'couponVote',
                ),
            ).toBe(true)

            // Retry succeeds once the server is back.
            reportStatus = 200
            await userEvent.click(
                screen.getByRole('button', { name: 'Yes, it worked' }),
            )
            await screen.findByText('Thanks! Your answer helps other shoppers.')
            expect(storage[VOTED_COUPONS_KEY]).toEqual(['1'])
        },
    )

    it('"Not now" dismisses the prompt and clears the pending record', async () => {
        storage[PENDING_VOTE_KEY] = pendingRecord()
        renderView()

        await userEvent.click(
            await screen.findByRole('button', { name: 'Not now' }),
        )

        expect(screen.queryByRole('group', { name: /Did .* work/ })).toBeNull()
        await waitFor(() => expect(storage[PENDING_VOTE_KEY]).toBeNull())
        expect(reportCalls()).toHaveLength(0)
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

        const saved = storage[PENDING_VOTE_KEY] as any
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

        const toggle = screen.getByRole('button', {
            name: 'Hidden codes (1) — show',
        })
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

    it('hidden ids persisted from an earlier open are applied on mount', async () => {
        storage[HIDDEN_COUPONS_KEY] = ['3']
        renderView()
        await screen.findByRole('button', { name: 'Hidden codes (1) — show' })
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
