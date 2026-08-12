import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// log() used to be a script global the suite could overwrite; it is an import
// now, so the collaborator is replaced at the module boundary instead. Only
// `log` changes — `currentBrowser` is a live binding that initCaramelBase()
// fills in later, so it is re-read through a getter rather than snapshotted by
// the spread.
const { logged } = vi.hoisted(() => ({ logged: [] }))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        log: (...args) => logged.push(String(args[0])),
    }
})

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
// The UI-helpers namespace of the CURRENT module registry: `getShadowCss` is
// its _caramelGetShadowCss, and `ui._caramelShadowCssPromise` reads the cache
// live, which the pre-ESM suite did through a global of the same name.
let ui
let getShadowCss

beforeAll(() => {
    globalThis.chrome = {
        runtime: { getURL: p => p, lastError: undefined },
        storage: {
            local: { get: (_keys, cb) => cb?.({}), set: (_i, cb) => cb?.() },
            sync: { get: (_keys, cb) => cb?.({}), set: (_i, cb) => cb?.() },
        },
    }
})

beforeEach(async () => {
    logged.length = 0
    // A fresh registry is how the cached promise gets back to null now that it
    // is module state; the imports run BEFORE the timers are faked so nothing
    // in the loader waits on a clock this suite controls.
    vi.resetModules()
    const base = await import('../caramel-base.js')
    base.initCaramelBase()
    ui = await import('../UI-helpers.js')
    ;({ _caramelGetShadowCss: getShadowCss } = ui)
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

const serveRealCss = () => {
    globalThis.fetch = async relPath => ({
        ok: true,
        text: async () =>
            readFileSync(join(EXT_ROOT, 'public', relPath), 'utf8'),
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
        expect(ui._caramelShadowCssPromise).not.toBeNull()
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
        expect(ui._caramelShadowCssPromise).toBeNull()
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
