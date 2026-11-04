import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
    COUPON_ID_LIST_MAX,
    HIDDEN_COUPONS_KEY,
    PENDING_VOTE_KEY,
    PENDING_VOTE_WINDOW_MS,
    VOTED_COUPONS_KEY,
    clearPendingVote,
    parseIdList,
    parsePendingVote,
    pendingVoteExpired,
    pendingVoteToAsk,
    readVoteState,
    recordVote,
    rememberCopiedCoupon,
    setCouponHidden,
    splitCoupons,
    withId,
} from '../entrypoints/popup/couponVote'

// Issue #288, extension side. The pure rules behind the popup's "Did it work?"
// prompt, the per-shopper hide list and the keepsFailing split. DISPLAY ONLY:
// the last describe pins that the apply path never reads any of it, because a
// forged report or `keepsFailing` must not be able to stop a code being tried.

const NOW = Date.parse('2026-10-11T12:00:00Z')
const pending = (over = {}) => ({
    couponId: '42',
    code: 'SAVE10',
    site: 'shop.example',
    copiedAt: NOW - 10 * 60 * 1000,
    ...over,
})

/** In-memory storage.local with chrome's callback shape. `failWith` makes the
 *  next call set runtime.lastError the way a quota/IO failure does. */
function makeBrowser(initial = {}) {
    const data = { ...initial }
    const browser = {
        runtime: { lastError: undefined },
        storage: {
            local: {
                get(keys, cb) {
                    cb(Object.fromEntries(keys.map(k => [k, data[k]])))
                },
                set(items, cb) {
                    Object.assign(data, items)
                    cb()
                },
            },
        },
    }
    return { browser, data }
}

describe('pending vote parsing + the ask window', () => {
    it('parsePendingVote accepts only a complete record', () => {
        expect(parsePendingVote(pending())).toEqual(pending())
        expect(parsePendingVote(null)).toBeNull()
        expect(parsePendingVote('x')).toBeNull()
        expect(parsePendingVote(pending({ couponId: '' }))).toBeNull()
        expect(parsePendingVote(pending({ code: 7 }))).toBeNull()
        expect(parsePendingVote(pending({ site: undefined }))).toBeNull()
        expect(parsePendingVote(pending({ copiedAt: 'soon' }))).toBeNull()
        expect(parsePendingVote(pending({ copiedAt: NaN }))).toBeNull()
    })

    it('asks about a fresh copy on the same site', () => {
        const state = { pending: pending(), voted: [] }
        expect(pendingVoteToAsk(state, 'shop.example', NOW)).toEqual(pending())
    })

    it('does not ask on another site', () => {
        const state = { pending: pending(), voted: [] }
        expect(pendingVoteToAsk(state, 'other.example', NOW)).toBeNull()
    })

    it('stops asking after the 2h window, and treats a future timestamp as skew', () => {
        expect(PENDING_VOTE_WINDOW_MS).toBe(2 * 60 * 60 * 1000)
        const at = copiedAt => ({
            pending: pending({ copiedAt }),
            voted: [],
        })
        expect(
            pendingVoteToAsk(
                at(NOW - PENDING_VOTE_WINDOW_MS),
                'shop.example',
                NOW,
            ),
        ).not.toBeNull()
        expect(
            pendingVoteToAsk(
                at(NOW - PENDING_VOTE_WINDOW_MS - 1),
                'shop.example',
                NOW,
            ),
        ).toBeNull()
        expect(
            pendingVoteToAsk(at(NOW + 60_000), 'shop.example', NOW),
        ).toBeNull()
    })

    it('pendingVoteExpired is true only strictly past the window, on any site', () => {
        expect(pendingVoteExpired(pending(), NOW)).toBe(false)
        expect(
            pendingVoteExpired(
                pending({ copiedAt: NOW - PENDING_VOTE_WINDOW_MS }),
                NOW,
            ),
        ).toBe(false)
        expect(
            pendingVoteExpired(
                pending({ copiedAt: NOW - PENDING_VOTE_WINDOW_MS - 1 }),
                NOW,
            ),
        ).toBe(true)
        // Clock skew (a future stamp) is not "expired" — it is just not asked.
        expect(
            pendingVoteExpired(pending({ copiedAt: NOW + 60_000 }), NOW),
        ).toBe(false)
    })

    it('never asks twice for the same coupon (one vote per coupon)', () => {
        const state = { pending: pending(), voted: ['42'] }
        expect(pendingVoteToAsk(state, 'shop.example', NOW)).toBeNull()
    })

    it('has nothing to ask with no pending record', () => {
        expect(
            pendingVoteToAsk({ pending: null, voted: [] }, 'shop.example', NOW),
        ).toBeNull()
    })
})

describe('bounded id lists', () => {
    it('withId appends as newest, moves a repeat instead of duplicating', () => {
        expect(withId(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
        expect(withId(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a'])
    })

    it('withId keeps only the newest 500 ids', () => {
        let list = []
        for (let i = 0; i < COUPON_ID_LIST_MAX + 25; i++)
            list = withId(list, String(i))
        expect(list).toHaveLength(COUPON_ID_LIST_MAX)
        expect(list[0]).toBe('25')
        expect(list.at(-1)).toBe(String(COUPON_ID_LIST_MAX + 24))
    })

    it('parseIdList drops junk, dedupes and caps what storage hands back', () => {
        expect(parseIdList(undefined)).toEqual([])
        expect(parseIdList('nope')).toEqual([])
        expect(parseIdList(['1', 2, '', null, '1', '3'])).toEqual(['1', '3'])
        const big = Array.from({ length: 600 }, (_, i) => String(i))
        expect(parseIdList(big)).toHaveLength(COUPON_ID_LIST_MAX)
    })
})

const c = (id, over = {}) => ({ id, code: `C${id}`, ...over })

describe('splitCoupons (keepsFailing + hidden)', () => {
    it('moves keepsFailing:true codes out of the main list, order preserved', () => {
        const split = splitCoupons(
            [
                c(1),
                c(2, { keepsFailing: true }),
                c(3),
                c(4, { keepsFailing: true }),
            ],
            [],
        )
        expect(split.main.map(x => x.id)).toEqual([1, 3])
        expect(split.failing.map(x => x.id)).toEqual([2, 4])
        expect(split.hidden).toEqual([])
    })

    it('treats a MISSING keepsFailing (older server) as not failing', () => {
        const split = splitCoupons(
            [c(1), c(2, { keepsFailing: undefined })],
            [],
        )
        expect(split.main).toHaveLength(2)
        expect(split.failing).toEqual([])
    })

    it('only an explicit true counts — truthy junk does not hide a code', () => {
        const split = splitCoupons(
            [
                c(1, { keepsFailing: 'true' }),
                c(2, { keepsFailing: 1 }),
                c(3, { keepsFailing: false }),
            ],
            [],
        )
        expect(split.main).toHaveLength(3)
        expect(split.failing).toEqual([])
    })

    it('shopper-hidden codes leave the list, and win over keepsFailing', () => {
        const split = splitCoupons(
            [c(1), c(2, { keepsFailing: true }), c(3)],
            ['2', '3'],
        )
        expect(split.main.map(x => x.id)).toEqual([1])
        expect(split.failing).toEqual([])
        expect(split.hidden.map(x => x.id)).toEqual([2, 3])
    })

    it('matches hidden ids as strings, and a coupon without an id can never be hidden', () => {
        const noId = { code: 'NOID' }
        const split = splitCoupons([c(7), noId], ['7', 'undefined', ''])
        expect(split.hidden.map(x => x.code)).toEqual(['C7'])
        expect(split.main).toEqual([noId])
    })

    it('loses nothing: main + failing + hidden is the whole input', () => {
        const input = [c(1), c(2, { keepsFailing: true }), c(3), c(4)]
        const s = splitCoupons(input, ['4'])
        expect(s.main.length + s.failing.length + s.hidden.length).toBe(4)
    })
})

describe('storage round trips', () => {
    it('remembers a copied coupon, and the next read finds it', async () => {
        const { browser, data } = makeBrowser()
        await rememberCopiedCoupon(
            browser,
            { id: 42, code: 'SAVE10' },
            'shop.example',
            NOW,
        )
        expect(data[PENDING_VOTE_KEY]).toEqual({
            couponId: '42',
            code: 'SAVE10',
            site: 'shop.example',
            copiedAt: NOW,
        })
        const state = await readVoteState(browser)
        expect(pendingVoteToAsk(state, 'shop.example', NOW)).not.toBeNull()
    })

    it('the latest copy replaces the earlier one', async () => {
        const { browser } = makeBrowser()
        await rememberCopiedCoupon(browser, { id: 1, code: 'A' }, 's', NOW)
        await rememberCopiedCoupon(browser, { id: 2, code: 'B' }, 's', NOW + 5)
        expect((await readVoteState(browser)).pending.code).toBe('B')
    })

    it('a coupon without an id cannot be voted on, so nothing is stored', async () => {
        const { browser, data } = makeBrowser()
        await rememberCopiedCoupon(browser, { code: 'NOID' }, 's', NOW)
        expect(PENDING_VOTE_KEY in data).toBe(false)
    })

    it("recordVote('failed') marks voted, clears pending AND hides the code", async () => {
        const { browser, data } = makeBrowser({
            [PENDING_VOTE_KEY]: pending(),
            [HIDDEN_COUPONS_KEY]: ['9'],
        })
        await recordVote(browser, '42', 'failed')
        expect(data[VOTED_COUPONS_KEY]).toEqual(['42'])
        expect(data[HIDDEN_COUPONS_KEY]).toEqual(['9', '42'])
        expect(data[PENDING_VOTE_KEY]).toBeNull()
        const state = await readVoteState(browser)
        expect(pendingVoteToAsk(state, 'shop.example', NOW)).toBeNull()
    })

    it("recordVote('worked') marks voted and clears pending but hides nothing", async () => {
        const { browser, data } = makeBrowser({ [PENDING_VOTE_KEY]: pending() })
        await recordVote(browser, '42', 'worked')
        expect(data[VOTED_COUPONS_KEY]).toEqual(['42'])
        expect(HIDDEN_COUPONS_KEY in data).toBe(false)
        expect(data[PENDING_VOTE_KEY]).toBeNull()
    })

    it('clearPendingVote drops the question without recording a vote', async () => {
        const { browser, data } = makeBrowser({ [PENDING_VOTE_KEY]: pending() })
        await clearPendingVote(browser)
        expect(data[PENDING_VOTE_KEY]).toBeNull()
        expect(VOTED_COUPONS_KEY in data).toBe(false)
    })

    it('setCouponHidden hides, then unhides, and returns the new list', async () => {
        const { browser, data } = makeBrowser()
        expect(await setCouponHidden(browser, '5', true)).toEqual(['5'])
        expect(await setCouponHidden(browser, '6', true)).toEqual(['5', '6'])
        expect(await setCouponHidden(browser, '5', false)).toEqual(['6'])
        expect(data[HIDDEN_COUPONS_KEY]).toEqual(['6'])
    })

    it('the hidden list is bounded at 500 across writes', async () => {
        const { browser } = makeBrowser({
            [HIDDEN_COUPONS_KEY]: Array.from(
                { length: COUPON_ID_LIST_MAX },
                (_, i) => String(i),
            ),
        })
        const next = await setCouponHidden(browser, 'new', true)
        expect(next).toHaveLength(COUPON_ID_LIST_MAX)
        expect(next.at(-1)).toBe('new')
        expect(next).not.toContain('0')
    })

    it('a storage failure REJECTS — a write that did not land is never reported as done', async () => {
        const { browser } = makeBrowser()
        browser.storage.local.set = (_items, cb) => {
            browser.runtime.lastError = { message: 'QUOTA_BYTES exceeded' }
            cb()
            browser.runtime.lastError = undefined
        }
        await expect(setCouponHidden(browser, '1', true)).rejects.toThrow(
            /coupon vote write failed: QUOTA_BYTES exceeded/,
        )
        browser.storage.local.get = () => {
            throw new Error('storage gone')
        }
        await expect(readVoteState(browser)).rejects.toThrow('storage gone')
    })
})

describe('display-only: the apply path never sees any of it', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const applyFiles = [
        'coupon-runner.js',
        'coupon-cart-discount.js',
        'coupon-apply.js',
        'coupon-fetch.js',
        'code-capture.js',
    ]

    it.each(applyFiles)(
        '%s does not read keepsFailing or the hide/vote storage keys',
        file => {
            const source = readFileSync(join(root, file), 'utf8')
            expect(source).not.toMatch(/keepsFailing/)
            expect(source).not.toMatch(/caramel_hidden_coupons/)
            expect(source).not.toMatch(/caramel_voted_coupons/)
            expect(source).not.toMatch(/caramel_pending_vote/)
        },
    )
})

describe('popup stylesheet a11y pins', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const css = readFileSync(
        join(root, 'public', 'assets', 'styles.css'),
        'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')

    it('never hides the vote live region while it is empty (display:none drops it from the a11y tree, so the first message may not be announced)', () => {
        expect(css).not.toMatch(/\.coupon-vote-msg:empty/)
        expect(css).not.toMatch(/\.coupon-vote-msg[^{]*\{[^}]*display:\s*none/)
    })

    it('the vote buttons are aria-disabled while sending, not :disabled (a disabled button drops focus)', () => {
        expect(css).not.toMatch(/\.coupon-vote-(btn|dismiss):disabled/)
    })
})
