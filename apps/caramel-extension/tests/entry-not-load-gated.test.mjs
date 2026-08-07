// The extension must start even on a page whose `load` event never fires.
//
// Measured live (chomps.com drawer page, 2026-08-07): readyState stayed
// `interactive` indefinitely — one subresource never resolved — so the old
// entry (`load` or nothing) meant the extension was, for that shopper,
// not installed. inject.js now arms BOTH the load listener and a
// DOMContentLoaded + grace timer; these tests pin that dispatch logic and
// that the two paths can never double-start detection.
//
// Each test re-evaluates inject.js, so listeners from earlier tests are still
// attached to the shared jsdom window. That is deliberate cover, not a
// nuisance: every stale listener funnels through the same once-flag, so the
// "exactly one start" assertions also prove the dedupe holds across repeated
// injection — the real-world content-script double-injection case.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const INJECT_SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'inject.js'),
    'utf8',
)

let starts

function setReadyState(value) {
    Object.defineProperty(document, 'readyState', {
        value,
        configurable: true,
    })
}

function evalInject() {
    // Indirect eval, same as tests/_load.mjs: top-level `var`/`function` land
    // on globalThis, which is exactly how the browser runs a content script.
    ;(0, eval)(INJECT_SRC)
}

beforeEach(() => {
    vi.useFakeTimers()
    starts = 0
    globalThis.log = () => {}
    globalThis.startCheckoutDetection = () => {
        starts++
    }
    globalThis._caramelDetectionStarted = false
})

describe('detection starts without waiting on a load event that may never come', () => {
    it('a page already complete starts immediately', () => {
        setReadyState('complete')
        evalInject()
        expect(starts).toBe(1)
    })

    it('load never fires: DOMContentLoaded + grace still starts it', () => {
        setReadyState('loading')
        evalInject()
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

    it('injected mid-parse after DOMContentLoaded (readyState interactive) arms the grace timer directly', () => {
        setReadyState('interactive')
        evalInject()
        expect(starts).toBe(0)
        vi.advanceTimersByTime(5000)
        expect(starts).toBe(1)
    })

    it('a healthy page keeps the old behavior: load wins the race and the timer is a no-op', () => {
        setReadyState('interactive')
        evalInject()
        window.dispatchEvent(new Event('load'))
        expect(starts).toBe(1)
        vi.advanceTimersByTime(60000)
        expect(starts).toBe(1)
    })
})
