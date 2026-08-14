// The probe's verdict vocabulary, pinned.
//
// tools/ext-probe/verdict.mjs is the half of the probe that decides whether a
// store config WORKS. It is deliberately browser-free so it can be pinned here,
// in the extension's own unit lane: every symbol it reasons about
// (`caramel-small-prompt`, the AUTO_INSERT trail, priceContainer /
// successIndicator / errorIndicator) is extension-owned, so a rename that
// silently downgrades every future probe run to a meaningless verdict should
// fail THIS build, not be discovered a night later on a live store.
//
// The order of the checks IS the semantics — first matching precondition wins —
// so the precedence cases at the bottom are as load-bearing as the ten
// per-verdict cases above them.
import { describe, expect, it } from 'vitest'
import { SEEDABLE_PLATFORMS } from '../../../tools/ext-probe/seed.mjs'
import {
    classify,
    EXIT_CODES,
    exitCodeFor,
    PROBE_ERROR,
    PROBE_NO_EXTENSION,
    VERDICTS,
} from '../../../tools/ext-probe/verdict.mjs'
import { greenObservation } from './_ext-probe-fixtures.mjs'

describe('every verdict is reachable and carries its own exit code', () => {
    it('GREEN when all seven evidence items are present', () => {
        const { verdict, exitCode } = classify(greenObservation())
        expect(verdict).toBe('GREEN')
        expect(exitCode).toBe(0)
    })

    it('INCONCLUSIVE_SEED when the seed never succeeded', () => {
        const r = classify(
            greenObservation({
                seed: { ok: false, detail: 'no available variant' },
            }),
        )
        expect(r.verdict).toBe('INCONCLUSIVE_SEED')
        expect(r.exitCode).toBe(30)
    })

    it('INCONCLUSIVE_SEED when the cart held 0 items at arrival — silence is CORRECT there', () => {
        const r = classify(greenObservation({ cartItemsAtArrival: 0 }))
        expect(r.verdict).toBe('INCONCLUSIVE_SEED')
        expect(r.reasons.join(' ')).toMatch(/correct behaviour/i)
    })

    it('INCONCLUSIVE_PLATFORM when no seeder speaks for the store platform', () => {
        const r = classify(
            greenObservation({ platform: { detected: 'unknown' } }),
        )
        expect(r.verdict).toBe('INCONCLUSIVE_PLATFORM')
        expect(r.exitCode).toBe(31)
        // The reason names what the seeder DOES speak, so the reader knows
        // whether this is a gap to close or a store to leave alone.
        for (const p of SEEDABLE_PLATFORMS)
            expect(r.reasons.join(' ')).toContain(p)
    })

    it.each(SEEDABLE_PLATFORMS)(
        'a seeded %s store gets past the platform gate',
        platform => {
            expect(
                classify(greenObservation({ platform: { detected: platform } }))
                    .verdict,
            ).toBe('GREEN')
        },
    )

    it('INCONCLUSIVE_PLATFORM when the platform is known but its endpoints did not answer', () => {
        for (const patch of [{ productFeedOk: false }, { cartApiOk: false }]) {
            const r = classify(
                greenObservation({
                    platform: { detected: 'woocommerce', ...patch },
                }),
            )
            expect(r.verdict).toBe('INCONCLUSIVE_PLATFORM')
            expect(r.reasons.join(' ')).toContain('woocommerce')
        }
    })

    it('INCONCLUSIVE_CONFIG_STALE when the API log line never appeared', () => {
        const r = classify(
            greenObservation({ config: { servedFromApi: false } }),
        )
        expect(r.verdict).toBe('INCONCLUSIVE_CONFIG_STALE')
        expect(r.exitCode).toBe(32)
    })

    it('INCONCLUSIVE_CONFIG_STALE when the served selectors differ from the ones under test', () => {
        const r = classify(
            greenObservation({
                config: { matches: false, mismatchedFields: ['couponInput'] },
            }),
        )
        expect(r.verdict).toBe('INCONCLUSIVE_CONFIG_STALE')
        expect(r.reasons.join(' ')).toContain('couponInput')
    })

    it('RED_NOT_DETECTED when a real cart never produced a checkout signal', () => {
        const r = classify(
            greenObservation({
                detection: {
                    checkoutViaCartPayload: false,
                    matchedPromoBox: false,
                },
            }),
        )
        expect(r.verdict).toBe('RED_NOT_DETECTED')
        expect(r.exitCode).toBe(20)
    })

    it('RED_NO_COUPONS when the catalogue returned nothing to try', () => {
        const r = classify(greenObservation({ coupons: { count: 0 } }))
        expect(r.verdict).toBe('RED_NO_COUPONS')
        expect(r.exitCode).toBe(21)
    })

    it('RED_NO_PROMPT when coupons were fetched and nothing rendered', () => {
        const r = classify(
            greenObservation({ prompt: { present: false, appearedMs: null } }),
        )
        expect(r.verdict).toBe('RED_NO_PROMPT')
        expect(r.exitCode).toBe(22)
    })

    it('RED_PROMPT_DEGENERATE on zero geometry', () => {
        const r = classify(
            greenObservation({ prompt: { rect: { w: 0, h: 0 } } }),
        )
        expect(r.verdict).toBe('RED_PROMPT_DEGENERATE')
        expect(r.exitCode).toBe(23)
        expect(r.reasons.join(' ')).toMatch(/zero geometry/)
    })

    it('RED_PROMPT_DEGENERATE when the shadow root fell back to the stub stylesheet', () => {
        const r = classify(
            greenObservation({ prompt: { cssIsFallback: true } }),
        )
        expect(r.verdict).toBe('RED_PROMPT_DEGENERATE')
    })

    it('RED_APPLY_FAILED when codes went in and nothing at all came back', () => {
        const r = classify(
            greenObservation({
                apply: {
                    submitted: 3,
                    successFiredOnGoodCode: false,
                    errorFiredOnInvalidCode: false,
                    totalBefore: 11100,
                    totalAfter: 11100,
                },
            }),
        )
        expect(r.verdict).toBe('RED_APPLY_FAILED')
        expect(r.exitCode).toBe(24)
    })

    it('AMBER_NO_INDICATORS when the served config cannot prove anything', () => {
        const r = classify(
            greenObservation({
                indicators: { successIndicator: null, errorIndicator: null },
            }),
        )
        expect(r.verdict).toBe('AMBER_NO_INDICATORS')
        expect(r.exitCode).toBe(10)
        expect(r.reasons.join(' ')).toMatch(/successIndicator/)
    })

    it('every verdict in VERDICTS has a distinct exit code, and only GREEN is 0', () => {
        const codes = VERDICTS.map(exitCodeFor)
        expect(new Set(codes).size).toBe(VERDICTS.length)
        expect(codes.filter(c => c === 0)).toEqual([0])
        expect(exitCodeFor('GREEN')).toBe(0)
        // 1 and 2 are node's own; a caller must be able to tell a broken config
        // from a probe that never ran.
        expect(codes).not.toContain(1)
        expect(codes).not.toContain(2)
    })

    it('a probe crash is not a verdict about the store', () => {
        expect(VERDICTS).not.toContain(PROBE_ERROR)
        expect(exitCodeFor(PROBE_ERROR)).toBe(70)
        // An unknown verdict string exits like a crash rather than like a red.
        expect(exitCodeFor('NOT_A_VERDICT')).toBe(EXIT_CODES[PROBE_ERROR])
    })

    it('"no extension was loaded" is not a verdict about the store either, and has its own code', () => {
        // A browser with no extension answers every question with "nothing
        // happened", which reads exactly like a broken config — so this must
        // never be countable as a red, and must not collapse into the generic
        // crash code a caller might already tolerate.
        expect(VERDICTS).not.toContain(PROBE_NO_EXTENSION)
        expect(exitCodeFor(PROBE_NO_EXTENSION)).toBe(71)
        expect(exitCodeFor(PROBE_NO_EXTENSION)).not.toBe(
            exitCodeFor(PROBE_ERROR),
        )
        for (const verdict of VERDICTS)
            expect(exitCodeFor(verdict)).not.toBe(
                exitCodeFor(PROBE_NO_EXTENSION),
            )
    })
})

describe('first matching precondition wins', () => {
    it('a failed seed outranks every red beneath it', () => {
        // Everything downstream looks catastrophic — and none of it means
        // anything, because the cart was never populated.
        const r = classify(
            greenObservation({
                seed: { ok: false, detail: 'products.json 403' },
                platform: { productsJsonOk: false, cartJsOk: false },
                config: { servedFromApi: false },
                detection: {
                    checkoutViaCartPayload: false,
                    matchedPromoBox: false,
                },
                coupons: { count: 0 },
                prompt: { present: false },
            }),
        )
        expect(r.verdict).toBe('INCONCLUSIVE_SEED')
    })

    it('an empty cart at arrival outranks "the prompt never showed"', () => {
        const r = classify(
            greenObservation({
                cartItemsAtArrival: 0,
                prompt: { present: false, appearedMs: null },
            }),
        )
        expect(r.verdict).toBe('INCONCLUSIVE_SEED')
    })

    it('a stale config outranks a missing detection trail', () => {
        const r = classify(
            greenObservation({
                config: {
                    matches: false,
                    mismatchedFields: ['priceContainer'],
                },
                detection: {
                    checkoutViaCartPayload: false,
                    matchedPromoBox: false,
                },
            }),
        )
        expect(r.verdict).toBe('INCONCLUSIVE_CONFIG_STALE')
    })

    it('not-detected outranks no-coupons', () => {
        const r = classify(
            greenObservation({
                detection: {
                    checkoutViaCartPayload: false,
                    matchedPromoBox: false,
                },
                coupons: { count: 0 },
            }),
        )
        expect(r.verdict).toBe('RED_NOT_DETECTED')
    })

    it('a degenerate prompt outranks the unprovable-apply bucket', () => {
        const r = classify(
            greenObservation({
                prompt: { rect: { w: 300, h: 0 } },
                indicators: { successIndicator: null },
            }),
        )
        expect(r.verdict).toBe('RED_PROMPT_DEGENERATE')
    })
})

describe('GREEN is never granted on partial proof', () => {
    it.each([
        ['no priceContainer', { indicators: { priceContainer: null } }],
        ['no successIndicator', { indicators: { successIndicator: null } }],
        ['no errorIndicator', { indicators: { errorIndicator: null } }],
        [
            'the price never moved',
            { apply: { totalBefore: 9990, totalAfter: 9990 } },
        ],
        [
            'no success on the good code',
            { apply: { successFiredOnGoodCode: false } },
        ],
        [
            'no error on the deliberately invalid code',
            { apply: { errorFiredOnInvalidCode: null } },
        ],
        ['an incomplete fetch trail', { coupons: { fetchEnded: false } }],
    ])('%s downgrades GREEN to AMBER_NO_INDICATORS', (_label, patch) => {
        expect(classify(greenObservation(patch)).verdict).toBe(
            'AMBER_NO_INDICATORS',
        )
    })

    it('records the prompt rect rather than comparing it to a remembered size', () => {
        // 300x81 was one measurement on one store, never a contract. A prompt
        // that is simply a different size is still healthy.
        const r = classify(
            greenObservation({ prompt: { rect: { w: 412, h: 64 } } }),
        )
        expect(r.verdict).toBe('GREEN')
    })
})
