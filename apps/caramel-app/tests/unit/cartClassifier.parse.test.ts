import type { CartSignals } from '@/lib/cartClassifier'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F-012 — characterization pins for cartClassifier's response parsing,
// captured via the PUBLIC API (classifyCart), not a test-only export. These
// pin the EXACT tolerances the original hand-rolled `parseResponse` body
// had (see PLAN-F-012.md §Sequencing step 1) so the immediately-following
// zod `classificationSchema` refactor (step 2) can be proven behavior-
// neutral: this file must stay green, unmodified, after that refactor.
//
// `chat` is mocked so no live OpenRouter call ever happens here (FREE,
// tests/unit/** — F-004's vitest include, excluded from the live
// `evals/**/*.eval.ts` glob).
const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }))
vi.mock('@/lib/openrouter', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/openrouter')>()
    return { ...actual, chat: chatMock }
})

import { classifyCart } from '@/lib/cartClassifier'

// Each case gets a distinct domain (folded into cartClassifier's in-memory
// cache key) so no two pins can accidentally share a cache hit — every
// call below must reach the (mocked) `chat`.
function signalsFor(domain: string): CartSignals {
    return { domain, title: `title for ${domain}` }
}

beforeEach(() => {
    chatMock.mockReset()
})

describe('cartClassifier — parseResponse pins (F-012, via classifyCart)', () => {
    it('(a) valid JSON — primary, secondary, confidence all kept', async () => {
        chatMock.mockResolvedValueOnce(
            '{"primary":"electronics","secondary":"toys_games","confidence":0.8}',
        )
        const result = await classifyCart(signalsFor('pin-valid-json.example'))
        expect(result).toEqual({
            primary: 'electronics',
            secondary: 'toys_games',
            confidence: 0.8,
            cached: false,
        })
    })

    it('(b) prose-wrapped JSON — regex fallback extracts the embedded object', async () => {
        chatMock.mockResolvedValueOnce(
            'Sure! Here is the classification: {"primary":"apparel","confidence":0.7} Hope that helps!',
        )
        const result = await classifyCart(
            signalsFor('pin-prose-wrapped.example'),
        )
        expect(result).toEqual({
            primary: 'apparel',
            secondary: undefined,
            confidence: 0.7,
            cached: false,
        })
    })

    it('(c) unknown primary category throws, naming the offending value', async () => {
        chatMock.mockResolvedValueOnce('{"primary":"crypto","confidence":0.9}')
        await expect(
            classifyCart(signalsFor('pin-unknown-primary.example')),
        ).rejects.toThrow('unknown primary category: crypto')
    })

    it('(d) unknown secondary category is dropped, not thrown', async () => {
        chatMock.mockResolvedValueOnce(
            '{"primary":"apparel","secondary":"not_a_category","confidence":0.6}',
        )
        const result = await classifyCart(
            signalsFor('pin-unknown-secondary.example'),
        )
        expect(result.primary).toBe('apparel')
        expect(result.secondary).toBeUndefined()
    })

    it('(e) secondary === primary is dropped', async () => {
        chatMock.mockResolvedValueOnce(
            '{"primary":"apparel","secondary":"apparel","confidence":0.6}',
        )
        const result = await classifyCart(
            signalsFor('pin-secondary-eq-primary.example'),
        )
        expect(result.secondary).toBeUndefined()
    })

    it('(f) confidence > 1 coerces to 0.5', async () => {
        chatMock.mockResolvedValueOnce('{"primary":"apparel","confidence":1.5}')
        const result = await classifyCart(
            signalsFor('pin-confidence-over-1.example'),
        )
        expect(result.confidence).toBe(0.5)
    })

    it('(g) confidence < 0 coerces to 0.5', async () => {
        chatMock.mockResolvedValueOnce(
            '{"primary":"apparel","confidence":-0.2}',
        )
        const result = await classifyCart(
            signalsFor('pin-confidence-under-0.example'),
        )
        expect(result.confidence).toBe(0.5)
    })

    it('(h) confidence missing entirely coerces to 0.5', async () => {
        chatMock.mockResolvedValueOnce('{"primary":"apparel"}')
        const result = await classifyCart(
            signalsFor('pin-confidence-missing.example'),
        )
        expect(result.confidence).toBe(0.5)
    })

    it('(i) confidence: null coerces to 0.5 (non-numeric — JSON.parse can never itself produce NaN, so this and the next case realize the plan\'s "confidence...NaN" pin)', async () => {
        chatMock.mockResolvedValueOnce(
            '{"primary":"apparel","confidence":null}',
        )
        const result = await classifyCart(
            signalsFor('pin-confidence-null.example'),
        )
        expect(result.confidence).toBe(0.5)
    })

    it('(j) confidence as a non-numeric string coerces to 0.5', async () => {
        chatMock.mockResolvedValueOnce(
            '{"primary":"apparel","confidence":"high"}',
        )
        const result = await classifyCart(
            signalsFor('pin-confidence-string.example'),
        )
        expect(result.confidence).toBe(0.5)
    })

    it('(k) a valid, distinct secondary is kept', async () => {
        chatMock.mockResolvedValueOnce(
            '{"primary":"apparel","secondary":"jewelry_accessories","confidence":0.75}',
        )
        const result = await classifyCart(
            signalsFor('pin-valid-secondary-kept.example'),
        )
        expect(result).toEqual({
            primary: 'apparel',
            secondary: 'jewelry_accessories',
            confidence: 0.75,
            cached: false,
        })
    })

    it('(l) totally non-JSON, non-prose-wrapped output throws "llm returned non-json"', async () => {
        chatMock.mockResolvedValueOnce('not json at all, no braces')
        await expect(
            classifyCart(signalsFor('pin-non-json.example')),
        ).rejects.toThrow('llm returned non-json')
    })
})
