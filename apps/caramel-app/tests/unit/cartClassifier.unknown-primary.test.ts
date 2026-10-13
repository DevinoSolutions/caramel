import type { CartSignals } from '@/lib/cartClassifier'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// CARAMEL-T (2026-10-06): the model answered {"primary":"furniture"} — a label
// outside CATEGORY_ENUM — and POST /api/classify-cart returned a 500 because
// the schema's only hard failure was "unknown primary category". An
// out-of-vocabulary primary now degrades to the vocabulary's own fallback
// ('other') at low confidence, and is REPORTED to Sentry (a warning carrying
// the raw label) so the drift is never silent. A known category, and the
// malformed-reply failures, are unchanged.
//
// `chat` and Sentry are mocked: no live OpenRouter call, no real Sentry event.
const { chatMock, captureMessageMock } = vi.hoisted(() => ({
    chatMock: vi.fn(),
    captureMessageMock: vi.fn(),
}))
vi.mock('@/lib/openrouter', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/openrouter')>()
    return { ...actual, chat: chatMock }
})
vi.mock('@sentry/nextjs', () => ({ captureMessage: captureMessageMock }))

import { classifyCart } from '@/lib/cartClassifier'

// A distinct domain per case keeps cartClassifier's in-memory cache from
// answering one test with another's result.
function signalsFor(domain: string): CartSignals {
    return { domain, title: `title for ${domain}` }
}

beforeEach(() => {
    chatMock.mockReset()
    captureMessageMock.mockReset()
})

describe('classifyCart — out-of-vocabulary primary category (CARAMEL-T)', () => {
    it('degrades to "other" at low confidence instead of throwing', async () => {
        chatMock.mockResolvedValueOnce(
            '{"primary":"furniture","secondary":"home_garden","confidence":0.9}',
        )
        const result = await classifyCart(signalsFor('furniture-drift.example'))
        expect(result).toEqual({
            primary: 'other',
            secondary: undefined,
            confidence: 0.2,
            cached: false,
        })
    })

    it('records a Sentry warning carrying the raw category, the domain and a stable fingerprint', async () => {
        chatMock.mockResolvedValueOnce(
            '{"primary":"furniture","confidence":0.8}',
        )
        await classifyCart(signalsFor('furniture-reported.example'))

        expect(captureMessageMock).toHaveBeenCalledTimes(1)
        const [message, context] = captureMessageMock.mock.calls[0] as [
            string,
            {
                level: string
                tags: Record<string, string>
                fingerprint: string[]
                extra: Record<string, string>
            },
        ]
        expect(message).toContain('outside the vocabulary')
        expect(context.level).toBe('warning')
        expect(context.tags).toMatchObject({ surface: 'classify-cart' })
        expect(context.fingerprint).toEqual([
            'classify-cart',
            'unknown-primary-category',
        ])
        expect(context.extra).toMatchObject({
            rawPrimary: 'furniture',
            fallback: 'other',
            domain: 'furniture-reported.example',
        })
    })

    it('truncates an absurdly long raw label in the Sentry context', async () => {
        const longLabel = 'x'.repeat(500)
        chatMock.mockResolvedValueOnce(
            JSON.stringify({ primary: longLabel, confidence: 0.5 }),
        )
        await classifyCart(signalsFor('long-label.example'))
        const [, context] = captureMessageMock.mock.calls[0] as [
            string,
            { extra: { rawPrimary: string } },
        ]
        expect(context.extra.rawPrimary).toHaveLength(80)
    })

    it('does not report a second time for the same cart (the degraded answer is cached)', async () => {
        chatMock.mockResolvedValue('{"primary":"furniture","confidence":0.8}')
        const signals = signalsFor('furniture-cached.example')
        await classifyCart(signals)
        const second = await classifyCart(signals)
        expect(second.cached).toBe(true)
        expect(second.primary).toBe('other')
        expect(captureMessageMock).toHaveBeenCalledTimes(1)
    })
})

describe('classifyCart — unchanged paths (CARAMEL-T guard rails)', () => {
    it('a known primary is returned as-is and records nothing', async () => {
        chatMock.mockResolvedValueOnce(
            '{"primary":"home_garden","secondary":"tools_hardware","confidence":0.85}',
        )
        const result = await classifyCart(signalsFor('known-category.example'))
        expect(result).toEqual({
            primary: 'home_garden',
            secondary: 'tools_hardware',
            confidence: 0.85,
            cached: false,
        })
        expect(captureMessageMock).not.toHaveBeenCalled()
    })

    it('a missing primary is still a hard failure, not a degrade', async () => {
        chatMock.mockResolvedValueOnce('{"confidence":0.9}')
        await expect(
            classifyCart(signalsFor('missing-primary.example')),
        ).rejects.toThrow('unknown primary category: ')
        expect(captureMessageMock).not.toHaveBeenCalled()
    })
})
