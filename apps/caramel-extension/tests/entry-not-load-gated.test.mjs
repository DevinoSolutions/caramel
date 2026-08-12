// The extension must start even on a page whose `load` event never fires.
//
// Measured live (chomps.com drawer page, 2026-08-07): readyState stayed
// `interactive` indefinitely — one subresource never resolved — so the old
// entry (`load` or nothing) meant the extension was, for that shopper,
// not installed. inject.js now arms BOTH the load listener and a
// DOMContentLoaded + grace timer; these tests pin that dispatch logic and
// that the two paths can never double-start detection.
//
// Each test re-imports inject.js, so listeners from earlier tests are still
// attached to the shared jsdom window. That is deliberate cover, not a
// nuisance: every stale listener funnels through the same once-flag, so the
// "exactly one start" assertions also prove the dedupe holds across repeated
// injection — the real-world content-script double-injection case.
import { beforeEach, describe, expect, it, vi } from 'vitest'

let starts

// The only collaborator inject.js has. The factory is re-run by each
// resetModules() below, but every copy increments the SAME counter, so a start
// is counted no matter which injection's listener fired it.
vi.mock('../store-detect.js', () => ({
    startCheckoutDetection: () => {
        starts++
    },
}))

function setReadyState(value) {
    Object.defineProperty(document, 'readyState', {
        value,
        configurable: true,
    })
}

async function evalInject() {
    // A fresh module registry per injection: `_caramelDetectionStarted` is
    // module state now, and re-importing is what the eval'd re-declaration
    // used to be. initInject() holds this file's entire former top-level body,
    // in its original order — which is the thing under test.
    vi.resetModules()
    const { initInject } = await import('../inject.js')
    initInject()
}

beforeEach(() => {
    vi.useFakeTimers()
    starts = 0
})

describe('detection starts without waiting on a load event that may never come', () => {
    it('a page already complete starts immediately', async () => {
        setReadyState('complete')
        await evalInject()
        expect(starts).toBe(1)
    })

    it('load never fires: DOMContentLoaded + grace still starts it', async () => {
        setReadyState('loading')
        await evalInject()
        expect(starts).toBe(0)

        document.dispatchEvent(new Event('DOMContentLoaded'))
        expect(starts).toBe(0) // the grace is real — not an instant start

        vi.advanceTimersByTime(4999)
        expect(starts).toBe(0)
        vi.advanceTimersByTime(1)
        expect(starts).toBe(1)

        // load arriving late must not start a second run
        window.dispatchEvent(new Event('load'))
        vi.runAllTimers()
        expect(starts).toBe(1)
    })

    it('injected mid-parse after DOMContentLoaded (readyState interactive) arms the grace timer directly', async () => {
        setReadyState('interactive')
        await evalInject()
        expect(starts).toBe(0)
        vi.advanceTimersByTime(5000)
        expect(starts).toBe(1)
    })

    it('a healthy page keeps the old behavior: load wins the race and the timer is a no-op', async () => {
        setReadyState('interactive')
        await evalInject()
        window.dispatchEvent(new Event('load'))
        expect(starts).toBe(1)
        vi.advanceTimersByTime(60000)
        expect(starts).toBe(1)
    })
})
