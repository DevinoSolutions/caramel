import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { caramelTabHandoffs, TAB_HANDOFFS } from '../tab-handoff.js'

// tab-handoff.js — what one document of a tab leaves for the next, held in the
// background where the store's page cannot write it. Every case runs twice:
// over memory, and over a storage.session area answering in the callback form.

const A = 'https://shop.test'
const B = 'https://other.test'

function sessionArea() {
    const data = {}
    return {
        data,
        get: (keys, cb) =>
            cb(Object.fromEntries([].concat(keys).map(k => [k, data[k]]))),
        set: (items, cb) => {
            Object.assign(data, items)
            cb?.()
        },
        remove: (keys, cb) => {
            for (const k of [].concat(keys)) delete data[k]
            cb?.()
        },
    }
}

afterEach(() => {
    vi.useRealTimers()
})

for (const [name, makeArea] of [
    ['in memory', () => null],
    ['over storage.session', sessionArea],
]) {
    describe(`per-tab handoffs ${name}`, () => {
        let h
        beforeEach(() => {
            h = caramelTabHandoffs(makeArea())
        })

        it('hands a record to the next document of the same tab and site', async () => {
            expect(
                await h.set(1, A, 'pending_submit', { code: 'SAVE10' }),
            ).toBe('saved')
            expect(await h.take(1, A, 'pending_submit')).toEqual({
                code: 'SAVE10',
            })
        })

        it('answers a record once', async () => {
            await h.set(1, A, 'pending_submit', { code: 'SAVE10' })
            await h.take(1, A, 'pending_submit')

            expect(await h.take(1, A, 'pending_submit')).toBeNull()
        })

        it('lets a record be read without consuming it', async () => {
            await h.set(1, A, 'run', { hops: 2 })

            expect(await h.get(1, A, 'run')).toEqual({ hops: 2 })
            expect(await h.get(1, A, 'run')).toEqual({ hops: 2 })
        })

        it('never answers another tab', async () => {
            await h.set(1, A, 'pending_submit', { code: 'SAVE10' })

            expect(await h.take(2, A, 'pending_submit')).toBeNull()
            expect(await h.take(1, A, 'pending_submit')).not.toBeNull()
        })

        it('never answers another site, and leaves the record for its own', async () => {
            await h.set(1, A, 'applied', { code: 'SAVE10' })

            expect(await h.take(1, B, 'applied')).toBeNull()
            await h.clear(1, B, 'applied')
            expect(await h.take(1, A, 'applied')).toEqual({ code: 'SAVE10' })
        })

        it('drops a record older than its kind allows', async () => {
            vi.useFakeTimers()
            await h.set(1, A, 'pending_submit', { code: 'SAVE10' })
            vi.advanceTimersByTime(TAB_HANDOFFS.pending_submit + 1)

            expect(await h.get(1, A, 'pending_submit')).toBeNull()
            vi.useRealTimers()
            expect(await h.take(1, A, 'pending_submit')).toBeNull()
        })

        it('keeps a run for its longer lifetime', async () => {
            vi.useFakeTimers()
            await h.set(1, A, 'run', { hops: 1 })
            vi.advanceTimersByTime(TAB_HANDOFFS.pending_submit + 1)

            expect(await h.get(1, A, 'run')).toEqual({ hops: 1 })
        })

        it('refuses a kind it does not know, and a record over 4 kB', async () => {
            expect(await h.set(1, A, 'unknown_kind', {})).toBe('refused')
            expect(
                await h.set(1, A, 'pending_submit', { pad: 'x'.repeat(5000) }),
            ).toBe('refused')
            expect(await h.get(1, A, 'pending_submit')).toBeNull()
        })

        it('refuses a missing tab or origin', async () => {
            expect(await h.set(undefined, A, 'run', {})).toBe('refused')
            expect(await h.set(-1, A, 'run', {})).toBe('refused')
            expect(await h.set(1, '', 'run', {})).toBe('refused')
        })

        it('clears only the record it names', async () => {
            await h.set(1, A, 'pending_submit', { code: 'SAVE10' })
            await h.set(1, A, 'run', { hops: 0 })
            await h.clear(1, A, 'pending_submit')

            expect(await h.get(1, A, 'pending_submit')).toBeNull()
            expect(await h.get(1, A, 'run')).toEqual({ hops: 0 })
        })

        it('forgets a closed tab, and only that tab', async () => {
            await h.set(1, A, 'pending_submit', { code: 'SAVE10' })
            await h.set(1, A, 'run', { hops: 0 })
            await h.set(2, A, 'run', { hops: 3 })
            await h.forgetTab(1)

            expect(await h.get(1, A, 'pending_submit')).toBeNull()
            expect(await h.get(1, A, 'run')).toBeNull()
            expect(await h.get(2, A, 'run')).toEqual({ hops: 3 })
        })

        it('applies a clear sent before the next set before it', async () => {
            // Not awaited between calls: the order they were sent in is the
            // order they land in.
            const ops = [
                h.set(1, A, 'pending_submit', { code: 'ONE' }),
                h.clear(1, A, 'pending_submit'),
                h.set(1, A, 'pending_submit', { code: 'TWO' }),
            ]
            await Promise.all(ops)

            expect(await h.take(1, A, 'pending_submit')).toEqual({
                code: 'TWO',
            })
        })

        it('stores a copy, not the caller’s object', async () => {
            const value = { code: 'SAVE10', prices: [1] }
            await h.set(1, A, 'pending_submit', value)
            value.prices.push(2)

            expect((await h.get(1, A, 'pending_submit')).prices).toEqual([1])
        })
    })
}

describe('storage.session that throws', () => {
    it('fails the operation instead of answering as if nothing was held', async () => {
        const h = caramelTabHandoffs({
            get: () => {
                throw new Error('storage gone')
            },
            set: () => {
                throw new Error('storage gone')
            },
            remove: () => {
                throw new Error('storage gone')
            },
        })

        await expect(h.set(1, A, 'run', {})).rejects.toThrow('storage gone')
        // One failure does not stop the next operation from running.
        await expect(h.get(1, A, 'run')).rejects.toThrow('storage gone')
    })
})
