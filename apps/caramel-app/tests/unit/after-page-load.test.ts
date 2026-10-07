// @vitest-environment jsdom
//
// On the landing page, the session recorders (PostHog's and Sentry Replay)
// start at the visitor's first activity or a ceiling after load — never during
// the page's own load, where their full-DOM snapshot cost the landing page its
// mobile Lighthouse score. Sentry's error SDK itself still starts before
// hydration, and every other route starts the recorders at mount.
import { defersAnalytics, onFirstActivity } from '@/lib/afterPageLoad'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('onFirstActivity', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        // jsdom has finished "loading" by the time a test runs.
        expect(document.readyState).toBe('complete')
        vi.stubGlobal('requestIdleCallback', (cb: () => void) =>
            setTimeout(cb, 0),
        )
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('waits for activity: nothing runs before the ceiling on an idle page', () => {
        const callback = vi.fn()
        onFirstActivity(callback, 10_000)
        vi.advanceTimersByTime(9_000)
        expect(callback).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1_001)
        expect(callback).toHaveBeenCalledTimes(1)
    })

    it('runs once, at the first scroll, and never again', () => {
        const callback = vi.fn()
        onFirstActivity(callback, 10_000)
        window.dispatchEvent(new Event('scroll'))
        vi.advanceTimersByTime(1)
        expect(callback).toHaveBeenCalledTimes(1)
        window.dispatchEvent(new Event('pointerdown'))
        vi.advanceTimersByTime(20_000)
        expect(callback).toHaveBeenCalledTimes(1)
    })
})

describe('Sentry client init', () => {
    const source = readFileSync(
        join(__dirname, '..', '..', 'src', 'instrumentation-client.ts'),
        'utf8',
    )

    // Where Replay is added (first activity on the landing route, at once
    // elsewhere) is pinned by behaviour in analytics-route-scope.test.ts.
    it('keeps Replay out of the eager init (it arrives in its own chunk)', () => {
        const init = source.slice(source.indexOf('Sentry.init('))
        const initCall = init.slice(0, init.indexOf('})') + 2)
        expect(initCall).not.toContain('replayIntegration')
        expect(source).toContain('replaysOnErrorSampleRate: 1.0')
    })
})

describe('defersAnalytics', () => {
    it('defers on the landing page only', () => {
        expect(defersAnalytics('/')).toBe(true)
        for (const path of [
            '/login',
            '/signup',
            '/oauth/consent',
            '/pricing',
            '/coupons',
        ]) {
            expect(defersAnalytics(path)).toBe(false)
        }
    })
})
