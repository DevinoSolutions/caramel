import type { Category } from '@/lib/cartClassifier'
import { beforeEach, describe, expect, it, vi } from 'vitest'
// Cross-directory import by design (PLAN-F-012.md §Test strategy): this
// FREE test proves the exact same runEvalSuite() the LIVE suite
// (evals/cartClassifier.eval.ts) uses, so what's proven here — the
// aggregation/threshold math, and that a scrambled dataset goes red — is
// proven for the real gate, not a reimplementation of it.
import type { CartCase } from '../../evals/scorers'

// F-012 — mocked full-pipeline test: real classifyCart (real parseResponse,
// real classificationSchema), fake network. FREE (tests/unit/**, no API
// call — chat() never runs for real).
const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }))
vi.mock('@/lib/openrouter', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/openrouter')>()
    return { ...actual, chat: chatMock }
})

import { classifyCart } from '@/lib/cartClassifier'
import { runEvalSuite } from '../../evals/scorers'

interface Fixture {
    key: 'a' | 'b' | 'c' | 'd'
    category: Category
    confidence: number
}

// Keyed by `title` (echoed back into the mocked chat response below), NOT
// by domain — domain varies per test (see buildCases) specifically so each
// test hits classifyCart's in-memory cache fresh instead of silently
// reusing another test's cached result.
const FIXTURES: Fixture[] = [
    { key: 'a', category: 'apparel', confidence: 0.9 },
    { key: 'b', category: 'electronics', confidence: 0.8 },
    { key: 'c', category: 'beauty', confidence: 0.85 },
    { key: 'd', category: 'pet', confidence: 0.7 },
]

function buildCases(domainSuffix: string): CartCase[] {
    return FIXTURES.map(f => ({
        name: `case-${f.key}-${f.category}`,
        signals: {
            domain: `pipeline-${f.key}-${domainSuffix}.example`,
            title: f.key,
        },
        expect: {
            primary: [f.category],
            secondary: null,
            confidence: [0, 1] as [number, number],
        },
    }))
}

beforeEach(() => {
    chatMock.mockReset()
    chatMock.mockImplementation(
        async (messages: { role: string; content: string }[]) => {
            const userContent =
                messages.find(m => m.role === 'user')?.content ?? '{}'
            const { title } = JSON.parse(userContent) as { title?: string }
            const fixture = FIXTURES.find(f => f.key === title)
            return fixture
                ? `{"primary":"${fixture.category}","confidence":${fixture.confidence}}`
                : '{"primary":"other","confidence":0.5}'
        },
    )
})

describe('cartClassifier eval harness — mocked full pipeline (F-012)', () => {
    it('scores a canned run correctly and clears the >=0.85 threshold', async () => {
        const cases = buildCases('green')
        const suite = await runEvalSuite(cases, classifyCart)

        expect(suite.summaries).toHaveLength(4)
        expect(suite.summaries.every(s => s.pass)).toBe(true)
        expect(suite.primaryMatchRate).toBe(1)
        expect(suite.primaryMatchRate).toBeGreaterThanOrEqual(0.85)
        expect(suite.schemaValidRate).toBe(1)
    })

    it('a scrambled-label variant drops the rate below threshold and names every failing case', async () => {
        const cases = buildCases('red')
        const scrambled = cases.map((c, i) => ({
            ...c,
            expect: cases[(i + 1) % cases.length]!.expect,
        }))

        const suite = await runEvalSuite(scrambled, classifyCart)

        expect(suite.primaryMatchRate).toBeLessThan(0.85)
        const failingNames = suite.summaries
            .filter(s => !s.pass)
            .map(s => s.caseName)
        // 4 categories, all distinct (see FIXTURES) -> rotate-by-1
        // guarantees every case's real result mismatches its scrambled
        // expectation, so ALL 4 are named as failing.
        expect(failingNames.sort()).toEqual(scrambled.map(c => c.name).sort())
        // This is exactly what a real CI run's assertion message embeds
        // (see evals/cartClassifier.eval.ts) — proving "non-zero exit +
        // named failing cases" without spending a second live budget.
        expect(() => {
            if (suite.primaryMatchRate < 0.85) {
                throw new Error(
                    `primary_match_rate=${(suite.primaryMatchRate * 100).toFixed(1)}% — failing: ${failingNames.join(', ')}`,
                )
            }
        }).toThrow(/failing: .*case-a-apparel/)
    })

    it('a classifyCart throw is scored as a full-red case, not a crash', async () => {
        const [firstCase] = buildCases('throws')
        chatMock.mockReset()
        chatMock.mockRejectedValueOnce(new Error('network exploded'))

        const suite = await runEvalSuite([firstCase!], classifyCart)

        expect(suite.summaries).toHaveLength(1)
        expect(suite.summaries[0]!.pass).toBe(false)
        expect(suite.summaries[0]!.scorers.every(s => !s.pass)).toBe(true)
        expect(suite.summaries[0]!.scorers[0]!.detail).toContain(
            'network exploded',
        )
        expect(suite.primaryMatchRate).toBe(0)
    })
})
