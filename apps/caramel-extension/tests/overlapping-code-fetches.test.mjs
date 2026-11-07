import { beforeEach, describe, expect, it, vi } from 'vitest'

// Two fetches of the same store's codes at once must not leave it with none
// (T-11238, seen 2026-10-30 in the 1.4.29 release test; 1.4.28 the same).
//
// The prompt check and the run both ask getCachedCodes for the store's codes.
// When the second asked before the first had its answer, both went to the
// server, and whichever answered LAST was cached. A fetch that failed or timed
// out was cached as an empty list, so a slow failure landing after a good
// list wiped it: the run ended "No codes for this store" on a store with
// codes, and every later ask on that page got the same empty list.
//
// Pinned here: one fetch per store at a time, shared by everyone who asks; a
// failed fetch is never cached, so the next ask tries again.

const stubs = vi.hoisted(() => ({ calls: 0, answers: [] }))

vi.mock('../coupon-fetch.js', async importOriginal => ({
    ...(await importOriginal()),
    // Each call takes the next scripted answer: { list } or { error }, after
    // `ms` milliseconds.
    fetchCoupons: () => {
        const a = stubs.answers[stubs.calls++] ?? { list: [] }
        return new Promise((resolve, reject) =>
            setTimeout(
                () => (a.error ? reject(new Error(a.error)) : resolve(a.list)),
                a.ms ?? 0,
            ),
        )
    },
}))

const { getCachedCodes, _caramelResetCachedCodes } =
    await import('../store-detect.js')

const REC = { domain: 'shop.example' }
const CODES = [
    { id: 'a', code: 'SAVE10' },
    { id: 'b', code: 'FREESHIP' },
]

beforeEach(() => {
    _caramelResetCachedCodes()
    stubs.calls = 0
    stubs.answers = []
})

describe('the codes of one store, asked for twice at once', () => {
    it('come from one fetch, and both askers get them', async () => {
        stubs.answers = [{ list: CODES, ms: 30 }]

        const [a, b] = await Promise.all([
            getCachedCodes(REC),
            getCachedCodes(REC),
        ])

        expect(stubs.calls).toBe(1)
        expect(a).toEqual(CODES)
        expect(b).toEqual(CODES)
    })

    it('are not wiped by a failed fetch that answers after them', async () => {
        // Without the shared fetch: the second ask's request times out after
        // the first's list arrived, and the empty list it cached wins.
        stubs.answers = [
            { list: CODES, ms: 20 },
            { error: 'timed out', ms: 60 },
        ]

        await Promise.all([getCachedCodes(REC), getCachedCodes(REC)])

        expect(await getCachedCodes(REC)).toEqual(CODES)
    })
})

describe('a fetch that fails', () => {
    it('is not cached: the next ask fetches again', async () => {
        stubs.answers = [{ error: 'timed out' }, { list: CODES }]

        expect(await getCachedCodes(REC)).toEqual([])
        expect(await getCachedCodes(REC)).toEqual(CODES)
        expect(stubs.calls).toBe(2)
    })

    it('a store with no codes is cached as having none', async () => {
        stubs.answers = [{ list: [] }]

        await getCachedCodes(REC)
        await getCachedCodes(REC)

        expect(stubs.calls).toBe(1)
    })
})

describe('another store', () => {
    it('gets its own fetch, not the one in flight', async () => {
        const OTHER = [{ id: 'z', code: 'OTHER5' }]
        stubs.answers = [
            { list: CODES, ms: 30 },
            { list: OTHER, ms: 10 },
        ]

        const [a, b] = await Promise.all([
            getCachedCodes(REC),
            getCachedCodes({ domain: 'other.example' }),
        ])

        expect(a).toEqual(CODES)
        expect(b).toEqual(OTHER)
    })
})
