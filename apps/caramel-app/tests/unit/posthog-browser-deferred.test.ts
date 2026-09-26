// @vitest-environment jsdom
//
// posthog-js is loaded after the page, not in the first-load bundle (mobile
// Lighthouse 2026-09-26: posthog-js + its recorder were ~130 KB gzip and
// ~1.5 s of main-thread work inside the landing page's load). These pin the
// two halves of that contract: calls made while the SDK is still loading are
// replayed in order rather than lost, and nothing in src/ can pull posthog-js
// back into the first load with a static import.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PostHog } from 'posthog-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Holder = typeof import('@/lib/analytics/posthogBrowser')

async function freshHolder(): Promise<Holder> {
    vi.resetModules()
    return import('@/lib/analytics/posthogBrowser')
}

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

describe('posthogBrowser: calls made while posthog-js loads', () => {
    let holder: Holder
    beforeEach(async () => {
        holder = await freshHolder()
    })

    it('drops calls when PostHog is not configured for this deploy', () => {
        const task = vi.fn()
        holder.withPosthog(task)
        expect(task).not.toHaveBeenCalled()
        expect(holder.isPosthogActive()).toBe(false)
    })

    it('queues calls during the load and replays them in order after init', async () => {
        const load = deferred<PostHog>()
        holder.startPosthogLoad(() => load.promise, vi.fn())
        expect(holder.isPosthogActive()).toBe(true)

        const order: string[] = []
        holder.withPosthog(() => order.push('identify'))
        holder.withPosthog(() => order.push('capture'))
        expect(order).toEqual([])
        expect(holder.getLoadedPosthog()).toBeNull()

        const instance = { capture: vi.fn() } as unknown as PostHog
        load.resolve(instance)
        await load.promise
        await Promise.resolve()

        expect(order).toEqual(['identify', 'capture'])
        expect(holder.getLoadedPosthog()).toBe(instance)
        // Once live, a call runs immediately.
        holder.withPosthog(() => order.push('later'))
        expect(order).toEqual(['identify', 'capture', 'later'])
    })

    it('one throwing queued call is reported and does not cost the rest', async () => {
        const load = deferred<PostHog>()
        const onError = vi.fn()
        holder.startPosthogLoad(() => load.promise, onError)
        const after = vi.fn()
        holder.withPosthog(() => {
            throw new Error('capture blew up')
        })
        holder.withPosthog(after)

        load.resolve({} as PostHog)
        await load.promise
        await Promise.resolve()

        expect(onError).toHaveBeenCalledWith(expect.any(Error))
        expect(after).toHaveBeenCalledTimes(1)
    })

    it('a failed load is reported, the queue is dropped and later calls no-op', async () => {
        const load = deferred<PostHog>()
        const onError = vi.fn()
        holder.startPosthogLoad(() => load.promise, onError)
        const queued = vi.fn()
        holder.withPosthog(queued)

        load.reject(new Error('chunk load failed'))
        await load.promise.catch(() => undefined)
        await Promise.resolve()

        expect(onError).toHaveBeenCalledWith(expect.any(Error))
        expect(queued).not.toHaveBeenCalled()
        expect(holder.isPosthogActive()).toBe(false)
        const later = vi.fn()
        holder.withPosthog(later)
        expect(later).not.toHaveBeenCalled()
    })

    it('holds at most 50 calls while loading, keeping the earliest', async () => {
        const load = deferred<PostHog>()
        holder.startPosthogLoad(() => load.promise, vi.fn())
        const ran: number[] = []
        for (let i = 0; i < 60; i++) holder.withPosthog(() => ran.push(i))

        load.resolve({} as PostHog)
        await load.promise
        await Promise.resolve()

        expect(ran).toEqual(Array.from({ length: 50 }, (_, i) => i))
    })
})

describe('capturePosthog: no event lost, none re-timed', () => {
    let holder: Holder
    beforeEach(async () => {
        holder = await freshHolder()
        vi.useFakeTimers({ toFake: ['Date'] })
        return () => vi.useRealTimers()
    })

    it('replays captures made during the load in order, each at the time it happened', async () => {
        const load = deferred<PostHog>()
        holder.startPosthogLoad(() => load.promise, vi.fn())

        vi.setSystemTime(new Date('2026-09-26T10:00:00.000Z'))
        holder.capturePosthog('install_cta_click', { n: 1 }, vi.fn())
        vi.setSystemTime(new Date('2026-09-26T10:00:03.000Z'))
        holder.capturePosthog('agent_setup_copied', { n: 2 }, vi.fn())

        vi.setSystemTime(new Date('2026-09-26T10:00:08.000Z'))
        const capture = vi.fn()
        load.resolve({ capture } as unknown as PostHog)
        await load.promise
        await Promise.resolve()

        expect(capture.mock.calls).toEqual([
            [
                'install_cta_click',
                { n: 1 },
                { timestamp: new Date('2026-09-26T10:00:00.000Z') },
            ],
            [
                'agent_setup_copied',
                { n: 2 },
                { timestamp: new Date('2026-09-26T10:00:03.000Z') },
            ],
        ])
    })

    it('reports a throwing capture to onError instead of throwing', async () => {
        const capture = vi.fn(() => {
            throw new Error('boom')
        })
        holder.startPosthogLoad(
            () => Promise.resolve({ capture } as unknown as PostHog),
            vi.fn(),
        )
        await Promise.resolve()
        await Promise.resolve()
        const onError = vi.fn()
        expect(() =>
            holder.capturePosthog('prompt_shown', {}, onError),
        ).not.toThrow()
        expect(onError).toHaveBeenCalledWith(expect.any(Error))
    })
})

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return walk(path)
        return /\.(ts|tsx)$/.test(name) ? [path] : []
    })
}

describe('no static posthog-js import in browser code', () => {
    const src = join(__dirname, '..', '..', 'src')

    it('src/ only type-imports or dynamically imports posthog-js', () => {
        const offenders = walk(src).filter(file =>
            // [^'"]* keeps a match inside ONE import statement.
            /^import\s+(?!type\b)[^'"]*from\s+['"]posthog-js['"]/m.test(
                readFileSync(file, 'utf8'),
            ),
        )
        expect(offenders).toEqual([])
    })
})
