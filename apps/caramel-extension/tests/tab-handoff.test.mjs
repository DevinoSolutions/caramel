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

        it('measures the 4 kB in bytes, not characters', async () => {
            // 1,500 characters, 4,500 bytes once written as UTF-8.
            const wide = '€'.repeat(1500)
            expect(await h.set(1, A, 'pending_submit', { label: wide })).toBe(
                'refused',
            )
            expect(
                await h.set(1, A, 'pending_submit', {
                    label: 'e'.repeat(1500),
                }),
            ).toBe('saved')
        })

        it('replaces a record only over the one the caller read', async () => {
            await h.set(1, A, 'run', { hops: 1, t: 5 })

            expect(
                await h.replace(
                    1,
                    A,
                    'run',
                    { hops: 2, t: 5 },
                    {
                        hops: 1,
                        t: 5,
                    },
                ),
            ).toBe('saved')
            expect(
                await h.replace(
                    1,
                    A,
                    'run',
                    { hops: 2, t: 5 },
                    {
                        hops: 1,
                        t: 5,
                    },
                ),
            ).toBe('changed')
            expect(await h.get(1, A, 'run')).toEqual({ hops: 2, t: 5 })
        })

        it('replaces whatever is there when the caller read nothing', async () => {
            await h.set(1, A, 'run', { hops: 3, t: 5 })
            expect(
                await h.replace(1, A, 'run', { hops: 6, t: 0, cancelled: 1 }),
            ).toBe('saved')
            expect(await h.get(1, A, 'run')).toEqual({
                hops: 6,
                t: 0,
                cancelled: 1,
            })
        })

        it('never creates a record by replacing', async () => {
            expect(await h.replace(1, A, 'run', { hops: 6 })).toBe('absent')
            expect(await h.replace(1, B, 'run', { hops: 6 })).toBe('absent')
            expect(await h.get(1, A, 'run')).toBeNull()
            expect(await h.replace(1, A, 'unknown_kind', {})).toBe('refused')
        })

        it('lets nothing land between the read and the write of a replace', async () => {
            await h.set(1, A, 'run', { hops: 1, t: 5 })
            // Both start before either finishes: the second sees the first's
            // write, not the record they both began from.
            const [first, second] = await Promise.all([
                h.replace(1, A, 'run', { hops: 2, t: 5 }, { hops: 1, t: 5 }),
                h.replace(1, A, 'run', { hops: 2, t: 5 }, { hops: 1, t: 5 }),
            ])
            expect([first, second]).toEqual(['saved', 'changed'])
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

describe('a storage call that fails', () => {
    // The storage API reports a failure only through runtime.lastError, set
    // while its callback runs (a full quota, a closed session area).
    function failingArea(failOn) {
        const area = sessionArea()
        for (const method of failOn) {
            const real = area[method]
            area[method] = (arg, cb) =>
                real(arg, () => {
                    globalThis.chrome = {
                        runtime: {
                            lastError: {
                                message: 'QUOTA_BYTES quota exceeded',
                            },
                        },
                    }
                    try {
                        cb?.()
                    } finally {
                        delete globalThis.chrome
                    }
                })
        }
        return area
    }

    it('is not answered as saved when the write did not land', async () => {
        const h = caramelTabHandoffs(failingArea(['set']))
        await expect(
            h.set(1, A, 'pending_submit', { code: 'SAVE10' }),
        ).rejects.toThrow('QUOTA_BYTES')
    })

    it('fails the read rather than answering that nothing is pending', async () => {
        const h = caramelTabHandoffs(failingArea(['get']))
        await expect(h.take(1, A, 'pending_submit')).rejects.toThrow(
            'QUOTA_BYTES',
        )
    })

    it('does not stop the next operation from running', async () => {
        // The failing set still stored its record here; what matters is that
        // the queue behind it keeps going.
        const h = caramelTabHandoffs(failingArea(['set']))
        await h.set(1, A, 'run', { hops: 1 }).catch(() => {})
        expect(await h.get(1, A, 'run')).toEqual({ hops: 1 })
    })
})
