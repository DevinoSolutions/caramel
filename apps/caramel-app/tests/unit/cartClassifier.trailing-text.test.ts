import type { CartSignals } from '@/lib/cartClassifier'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// CARAMEL-G (2026-09-24/25, 2 events, 2 users) — POST /api/classify-cart
// threw `SyntaxError: Unexpected non-whitespace character after JSON at
// position 77 (line 6 column 1)` (and `position 72` on the other event).
// The model answered with a pretty-printed object and then more text; the
// old greedy fallback regex sliced from the first `{` to the LAST `}` of the
// whole reply and handed that to an unguarded JSON.parse.
//
// `chat` is mocked — no live OpenRouter call (tests/unit/**, free).
const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }))
vi.mock('@/lib/openrouter', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/openrouter')>()
    return { ...actual, chat: chatMock }
})

import { classifyCart } from '@/lib/cartClassifier'

// The pre-fix parse, kept VERBATIM (minus the schema step) so the PAIR below
// proves the new parse fixes exactly the shape production failed on.
function legacyParse(raw: string): unknown {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        const m = raw.match(/\{[\s\S]*\}/)
        if (!m) throw new Error('llm returned non-json')
        parsed = JSON.parse(m[0])
    }
    return parsed
}

// A pretty-printed 2-space object that is exactly 76 characters, one
// newline, then commentary on line 6 that itself contains a `}` — which is
// what makes the greedy regex overshoot. The legacy parse reproduces the
// Sentry message byte for byte (asserted below, not assumed).
const PROD_SHAPE_REPLY =
    '{\n' +
    '  "primary": "tools_hardware",\n' +
    '  "secondary": null,\n' +
    '  "confidence": 0.85\n' +
    '}\n' +
    'The cart items ({"drill bits", "saw blade"}) are hardware.'

// The second event's position (72): same shape, shorter object.
const PROD_SHAPE_REPLY_72 =
    '{\n' +
    '  "primary": "toys_games",\n' +
    '  "secondary": null,\n' +
    '  "confidence": 0.9\n' +
    '}\n' +
    'Note: {"reason": "LEGO set in cart"}'

function signalsFor(domain: string): CartSignals {
    return { domain, title: `title for ${domain}` }
}

beforeEach(() => {
    chatMock.mockReset()
})

describe('cartClassifier — a reply with trailing text after the JSON (CARAMEL-G)', () => {
    it('PAIR (red half): the pre-fix parse throws the exact production SyntaxError', () => {
        expect(() => legacyParse(PROD_SHAPE_REPLY)).toThrow(
            new SyntaxError(
                'Unexpected non-whitespace character after JSON at position 77 (line 6 column 1)',
            ),
        )
        expect(() => legacyParse(PROD_SHAPE_REPLY_72)).toThrow(
            'at position 72 (line 6 column 1)',
        )
    })

    it('PAIR (green half): the shipped parse classifies that same reply from its first object', async () => {
        chatMock.mockResolvedValueOnce(PROD_SHAPE_REPLY)
        const result = await classifyCart(
            signalsFor('trailing-prod-77.example'),
        )
        expect(result).toEqual({
            primary: 'tools_hardware',
            secondary: undefined,
            confidence: 0.85,
            cached: false,
        })

        chatMock.mockResolvedValueOnce(PROD_SHAPE_REPLY_72)
        const second = await classifyCart(
            signalsFor('trailing-prod-72.example'),
        )
        expect(second.primary).toBe('toys_games')
        expect(second.confidence).toBe(0.9)
    })

    it('prose before the JSON, with a brace in the prose, still finds the object', async () => {
        chatMock.mockResolvedValueOnce(
            'Using the {domain, title} signals, here is my answer:\n{"primary":"beauty","secondary":"health_supplements","confidence":0.7}',
        )
        const result = await classifyCart(signalsFor('trailing-prose.example'))
        expect(result).toEqual({
            primary: 'beauty',
            secondary: 'health_supplements',
            confidence: 0.7,
            cached: false,
        })
    })

    it('code-fenced JSON is read from inside the fence', async () => {
        chatMock.mockResolvedValueOnce(
            '```json\n{\n  "primary": "pet",\n  "secondary": null,\n  "confidence": 0.95\n}\n```',
        )
        const result = await classifyCart(signalsFor('trailing-fenced.example'))
        expect(result.primary).toBe('pet')
        expect(result.confidence).toBe(0.95)
    })

    it('two JSON objects: the FIRST one wins, the second is ignored', async () => {
        chatMock.mockResolvedValueOnce(
            '{"primary":"electronics","confidence":0.8}\n{"primary":"apparel","confidence":0.9}',
        )
        const result = await classifyCart(signalsFor('trailing-two.example'))
        expect(result.primary).toBe('electronics')
        expect(result.confidence).toBe(0.8)
    })

    it('a brace inside a JSON string does not close the object early', async () => {
        chatMock.mockResolvedValueOnce(
            '{"primary":"books_media","note":"a } and a \\" inside","confidence":0.6} trailing }',
        )
        const result = await classifyCart(signalsFor('trailing-string.example'))
        expect(result.primary).toBe('books_media')
        expect(result.confidence).toBe(0.6)
    })

    it('garbage with braces but no parseable object fails the existing way, never with a raw SyntaxError', async () => {
        chatMock.mockResolvedValueOnce(
            'I cannot decide {maybe apparel} or {beauty?}',
        )
        const err = await classifyCart(
            signalsFor('trailing-garbage.example'),
        ).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(Error)
        expect(err).not.toBeInstanceOf(SyntaxError)
        expect((err as Error).message).toBe('llm returned non-json')
    })

    it('a truncated reply (braces never close) fails as non-json', async () => {
        chatMock.mockResolvedValueOnce('{"primary":"apparel","confidence":0.')
        await expect(
            classifyCart(signalsFor('trailing-truncated.example')),
        ).rejects.toThrow('llm returned non-json')
    })

    it('a first object that parses but is not a classification still fails the schema — nothing is invented', async () => {
        chatMock.mockResolvedValueOnce(
            '{"category":"electronics"}\n{"primary":"apparel","confidence":0.9}',
        )
        await expect(
            classifyCart(signalsFor('trailing-wrong-first.example')),
        ).rejects.toThrow('unknown primary category: ')
    })
})
