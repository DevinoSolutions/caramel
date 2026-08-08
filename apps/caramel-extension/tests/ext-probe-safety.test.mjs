// The two behaviours that protect the STORE, pinned so they survive the next
// rewrite of the probe.
//
// Neither is a nicety:
//
//  1. The seed stops after 5 consecutive rejected adds. An uncapped version of
//     this loop once fired 154 POSTs into one store, drew 286 rate-limit 429s,
//     and the store's OWN scripts choking on the 429 HTML pages was then
//     mis-filed as an extension defect. The second-order damage — a whole
//     investigation aimed at the wrong component — is the real lesson.
//  2. The cart is read BEFORE the wait window. An empty cart at arrival makes
//     the extension's silence the CORRECT answer; reading the cart only after
//     the wait cannot tell "no prompt because the config is broken" from "no
//     prompt because there was nothing to discount".
//
// (1) is exercised as code, against a stubbed fetch — no network, no store.
// (2) is a source-order gate, the same shape as console-silence.test.mjs: the
// ordering cannot be observed from outside, so it is asserted where it lives.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
    MAX_REJECTED_ADDS,
    readCartStateInPage,
    seedShopifyCartInPage,
} from '../../../tools/ext-probe/seed.mjs'

const TOOL_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'tools',
    'ext-probe',
)
const probeSource = readFileSync(join(TOOL_DIR, 'probe.mjs'), 'utf8')
const seedSource = readFileSync(join(TOOL_DIR, 'seed.mjs'), 'utf8')
// Comment-stripped view, for bans that must not be tripped by a comment
// EXPLAINING the banned form — probe.mjs names the Windows-only path trick in
// prose precisely so the next reader knows why it is gone.
const probeCode = probeSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')

const originalFetch = globalThis.fetch
afterEach(() => {
    globalThis.fetch = originalFetch
})

/** 10 products x 4 available variants = 40 adds available to an uncapped loop. */
function catalogue(productCount = 10, variantCount = 4) {
    return {
        products: Array.from({ length: productCount }, (_, p) => ({
            title: `Product ${p}`,
            variants: Array.from({ length: variantCount }, (_, v) => ({
                id: p * 100 + v,
                available: true,
            })),
        })),
    }
}

/**
 * A store that serves its product feed and then rejects every single add.
 * Returns the POST counter so a test can see exactly how hard we pushed.
 */
function stubRejectingStore({ addStatus = 429 } = {}) {
    const counts = { products: 0, adds: 0 }
    globalThis.fetch = async (url, init) => {
        if (String(url).startsWith('/products.json')) {
            counts.products++
            return { ok: true, status: 200, json: async () => catalogue() }
        }
        if (String(url) === '/cart/add.js' && init?.method === 'POST') {
            counts.adds++
            return { ok: false, status: addStatus, json: async () => ({}) }
        }
        throw new Error(`unexpected request: ${url}`)
    }
    return counts
}

describe('the seed stops before it can rate-limit a store', () => {
    it('fires exactly 5 adds against a store that rejects every one', async () => {
        const counts = stubRejectingStore()
        const out = await seedShopifyCartInPage({
            maxRejectedAdds: MAX_REJECTED_ADDS,
        })

        expect(counts.adds).toBe(5)
        expect(out.rejectedAdds).toBe(5)
        expect(out.adds).toBe(5)
        expect(out.ok).toBe(false)
        expect(out.detail).toContain('stopping before we rate-limit the store')
    })

    it('RED-PROOF: without the cap the same run fires 40 adds, so the assertion above is cap-sensitive', async () => {
        // This is the uncapped variant of the identical loop against the
        // identical fixture. If someone deletes the cap from seed.mjs, the test
        // above stops seeing 5 and sees THIS number instead — the pin cannot
        // pass by accident.
        const counts = stubRejectingStore()
        const out = await seedShopifyCartInPage({ maxRejectedAdds: Infinity })

        expect(counts.adds).toBe(40)
        expect(counts.adds).toBeGreaterThan(MAX_REJECTED_ADDS)
        expect(out.detail).toBe('no available variant')
    })

    it('defaults to the cap when no option is passed at all', async () => {
        const counts = stubRejectingStore()
        await seedShopifyCartInPage()
        expect(counts.adds).toBe(MAX_REJECTED_ADDS)
    })

    it('does not stop early when the store accepts — the cap counts REJECTIONS', async () => {
        let adds = 0
        globalThis.fetch = async url => {
            if (String(url).startsWith('/products.json'))
                return { ok: true, status: 200, json: async () => catalogue() }
            adds++
            return {
                ok: adds >= 3,
                status: adds >= 3 ? 200 : 422,
                json: async () => ({}),
            }
        }
        const out = await seedShopifyCartInPage()
        expect(out.ok).toBe(true)
        expect(out.rejectedAdds).toBe(2)
        expect(out.detail).toMatch(/^added Product 0 \/ 2$/)
    })

    it('reports a non-OK product feed instead of pushing adds at it', async () => {
        let adds = 0
        globalThis.fetch = async url => {
            if (String(url).startsWith('/products.json'))
                return { ok: false, status: 403, json: async () => ({}) }
            adds++
            return { ok: false, status: 403, json: async () => ({}) }
        }
        const out = await seedShopifyCartInPage()
        expect(out.productsJsonOk).toBe(false)
        expect(out.detail).toBe('products.json 403')
        expect(adds).toBe(0)
    })

    it('carries the incident comment that explains the number', async () => {
        // The cap without its story is a magic number the next rewrite deletes.
        expect(seedSource).toContain('154 POSTs into brooklinen')
        expect(seedSource).toContain('286')
        expect(seedSource).toContain(
            "that rejects 5 adds in a row isn't going to accept the 6th",
        )
    })
})

describe('the cart is read before the wait window', () => {
    it('the cart read appears earlier in probe.mjs than the wait deadline', () => {
        const cartRead = probeSource.indexOf(
            'page.evaluate(readCartStateInPage)',
        )
        const waitLoop = probeSource.indexOf(
            'const deadline = Date.now() + waitMs',
        )
        expect(cartRead).toBeGreaterThan(-1)
        expect(waitLoop).toBeGreaterThan(-1)
        expect(cartRead).toBeLessThan(waitLoop)
    })

    it('the reason is written down at the call site, not left to memory', () => {
        expect(probeSource).toContain(
            'empty cart here makes silence the CORRECT answer, and reading it only',
        )
        expect(probeSource).toContain(
            'after the wait cannot tell the two apart',
        )
    })

    it('cartItemsAtArrival is assigned from that read and nothing later', () => {
        const assign = probeSource.indexOf(
            'observation.cartItemsAtArrival = cartState.itemCount',
        )
        const waitLoop = probeSource.indexOf(
            'const deadline = Date.now() + waitMs',
        )
        expect(assign).toBeGreaterThan(-1)
        expect(assign).toBeLessThan(waitLoop)
        // ...and it is never reassigned afterwards.
        expect(
            probeSource.split('observation.cartItemsAtArrival ='),
        ).toHaveLength(2)
    })

    it("reads the cart the store's own way, and says so when it cannot", async () => {
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ item_count: 3 }),
        })
        await expect(readCartStateInPage()).resolves.toEqual({
            cartJsOk: true,
            itemCount: 3,
            detail: '',
        })

        globalThis.fetch = async () => ({ ok: false, status: 404 })
        await expect(readCartStateInPage()).resolves.toEqual({
            cartJsOk: false,
            itemCount: null,
            detail: 'cart.js 404',
        })

        globalThis.fetch = async () => {
            throw new Error('network down')
        }
        const thrown = await readCartStateInPage()
        expect(thrown.cartJsOk).toBe(false)
        expect(thrown.itemCount).toBeNull()
    })
})

describe('the probe is platform-portable', () => {
    it('resolves paths with fileURLToPath, never the Windows-only pathname slice', () => {
        // `new URL(...).pathname.slice(1)` strips the leading slash of a
        // Windows drive path and produces garbage everywhere else; it is what
        // made the scratch original Windows-only.
        expect(probeCode).not.toContain('.pathname.slice(1)')
        expect(probeCode).toContain('fileURLToPath')
    })

    it('keeps the three documented env knobs', () => {
        for (const knob of ['EXT_DIR', 'PROBE_WAIT_MS', 'PROBE_ALL_LOGS'])
            expect(probeSource).toContain(knob)
    })

    it('sends the report to stdout and every word of prose to stderr', () => {
        expect(probeCode).toContain('process.stdout.write')
        expect(probeCode).toMatch(/const note = \([^)]*\) =>\s*console\.error/)
        // No bare console.log: one stray line would corrupt the JSON on stdout.
        expect(probeCode).not.toMatch(/(^|[^.\w])console\.log\s*\(/)
    })
})

describe('the page functions stay serialisable', () => {
    it.each([
        ['seedShopifyCartInPage', seedShopifyCartInPage],
        ['readCartStateInPage', readCartStateInPage],
    ])('%s closes over nothing from module scope', (name, fn) => {
        // Playwright serialises a function by its source text, so anything
        // captured from this module would arrive `undefined` in the page. The
        // same property is what lets the tests above call them directly.
        const src = fn.toString()
        expect(src).not.toContain('MAX_REJECTED_ADDS')
        expect(src).not.toContain('DEFAULT_PRODUCT_LIMIT')
        expect(src).not.toMatch(/\bimport\b/)
        // A plain named declaration — not a bound wrapper and not `[native
        // code]`, either of which would serialise into something the page
        // cannot run.
        expect(src.startsWith(`async function ${name}`)).toBe(true)
    })
})
