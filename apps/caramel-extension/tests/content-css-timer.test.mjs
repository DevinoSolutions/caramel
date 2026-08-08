import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import {
    EXT_ROOT,
    loadExtensionSource,
    loadExtensionSources,
} from './_load.mjs'

// The shadow-CSS loader races the real stylesheet fetch against a 4s budget.
// The budget timer has to be CANCELLED when the fetch wins, and the whole
// point of the budget is that a fetch which never settles still yields the
// fallback exactly once.
//
// Before the fix the timer was never cleared, so on every surface — on every
// page, in production — the callback fired 4s after the UI was already
// correctly styled: it logged CONTENT_UI_CSS_TIMEOUT for a timeout that never
// happened, and nulled a perfectly good cached promise. A live audit found
// that log on every store and reasonably read it as a real CSS failure; the
// noise was masking the signal it was supposed to be. The packaged assets are
// local (single-digit ms even under Slow 3G), so every one of those logs was
// false.
let getShadowCss
const logged = []

beforeAll(() => {
    loadExtensionSource('coupon-constants.generated.js', [])
    ;({ _caramelGetShadowCss: getShadowCss } = loadExtensionSources(
        [
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
            'UI-helpers.js',
        ],
        ['_caramelGetShadowCss'],
    ))
    globalThis.currentBrowser.runtime.getURL = p => p
})

beforeEach(() => {
    logged.length = 0
    // log() is looked up on the global at call time, so this records what the
    // extension would emit regardless of the dev/packed gate.
    globalThis.log = (...args) => logged.push(String(args[0]))
    globalThis._caramelShadowCssPromise = null
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

const serveRealCss = () => {
    globalThis.fetch = async relPath => ({
        ok: true,
        text: async () => readFileSync(join(EXT_ROOT, relPath), 'utf8'),
    })
}

describe('_caramelGetShadowCss — the 4s budget timer', () => {
    it('does not log a timeout, or drop its cache, once the real CSS has loaded', async () => {
        serveRealCss()

        const css = await getShadowCss()
        expect(css).toContain(':host, :root') // the real sheet won the race

        // Well past the budget: an uncancelled timer fires here.
        await vi.advanceTimersByTimeAsync(5000)

        expect(logged).not.toContain('CONTENT_UI_CSS_TIMEOUT')
        expect(globalThis._caramelShadowCssPromise).not.toBeNull()
    })

    it('still falls back exactly once when the fetch never settles', async () => {
        globalThis.fetch = () => new Promise(() => {})

        const pending = getShadowCss()
        await vi.advanceTimersByTimeAsync(5000)
        const css = await pending

        expect(css).not.toContain(':host, :root')
        expect(css).toContain('.cm-prompt')
        expect(logged.filter(l => l === 'CONTENT_UI_CSS_TIMEOUT')).toHaveLength(
            1,
        )
        // The cache is dropped on a real timeout so a later surface can retry.
        expect(globalThis._caramelShadowCssPromise).toBeNull()
    })

    it('reports a genuine fetch failure as LOAD_FAILED, not as a timeout', async () => {
        globalThis.fetch = async () => ({ ok: false, status: 404 })

        const css = await getShadowCss()
        await vi.advanceTimersByTimeAsync(5000)

        expect(css).toContain('.cm-prompt')
        expect(logged).toContain('CONTENT_UI_CSS_LOAD_FAILED')
        expect(logged).not.toContain('CONTENT_UI_CSS_TIMEOUT')
    })
})
