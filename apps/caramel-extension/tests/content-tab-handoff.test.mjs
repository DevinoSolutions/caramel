import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { caramelTabHandoff, initCaramelBase } from '../caramel-base.js'

// caramel-base.js — the content side of the per-tab handoffs. It sends one
// message and answers the background's reply; a background that refuses or
// does not answer costs only the handoff.

let answer // (message, cb) => void, per test

beforeAll(() => {
    globalThis.chrome = {
        runtime: {
            lastError: undefined,
            sendMessage: (message, cb) => answer(message, cb),
        },
    }
    initCaramelBase()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('caramelTabHandoff', () => {
    it('sends the operation and answers the reply', async () => {
        const sent = []
        answer = (message, cb) => {
            sent.push(message)
            cb({ value: { hops: 1 } })
        }

        expect(await caramelTabHandoff('get', 'run')).toEqual({
            value: { hops: 1 },
        })
        expect(sent).toEqual([
            { action: 'tabHandoff', op: 'get', key: 'run', value: undefined },
        ])
    })

    it('answers null when the background refuses', async () => {
        answer = (_message, cb) => cb({ error: 'no tab' })

        expect(await caramelTabHandoff('take', 'pending_submit')).toBeNull()
    })

    it('answers null when the background never answers', async () => {
        vi.useFakeTimers()
        answer = () => {}
        const pending = caramelTabHandoff('set', 'run', { hops: 0 })
        await vi.advanceTimersByTimeAsync(10000)

        expect(await pending).toBeNull()
    })

    it('waits out a background held up by slow storage', async () => {
        // A heavy store page loading: storage answered in 2-4.6 s, and the
        // read queued behind the writes before it (4inkjets.com, T-9245).
        vi.useFakeTimers()
        answer = (_message, cb) =>
            setTimeout(() => cb({ value: { hops: 1 } }), 6000)
        const pending = caramelTabHandoff('get', 'run')
        await vi.advanceTimersByTimeAsync(6000)

        expect(await pending).toEqual({ value: { hops: 1 } })
    })

    it('answers null when the message cannot be sent', async () => {
        answer = () => {
            throw new Error('Extension context invalidated.')
        }

        expect(await caramelTabHandoff('clear', 'run')).toBeNull()
    })
})
