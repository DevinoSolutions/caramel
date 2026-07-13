import type { Classification } from '@/lib/cartClassifier'
import { describe, expect, it } from 'vitest'
import {
    LATENCY_BUDGET_MS,
    scoreCase,
    scoreConfidenceBounds,
    scoreLatencyBudget,
    scorePrimaryExact,
    scoreSchemaValid,
    scoreSecondaryTolerant,
    scoreThrown,
    type CartCase,
    type CaseExpectation,
} from '../../evals/scorers'

// F-012 — pure unit tests for the deterministic scorers (evals/scorers.ts),
// canned Classification objects only, no classifyCart/openrouter involved
// (FREE — tests/unit/**, F-004's vitest include).

const baseExpect: CaseExpectation = {
    primary: ['apparel'],
    secondary: null,
    confidence: [0.5, 1],
}

function classification(
    overrides: Partial<Classification> = {},
): Classification {
    return {
        primary: 'apparel',
        secondary: undefined,
        confidence: 0.8,
        cached: false,
        ...overrides,
    }
}

describe('scorePrimaryExact', () => {
    it('passes when the result primary is in the accept-set', () => {
        const r = scorePrimaryExact(classification({ primary: 'apparel' }), {
            ...baseExpect,
            primary: ['apparel', 'beauty'],
        })
        expect(r.pass).toBe(true)
        expect(r.name).toBe('primary-exact')
    })

    it('fails when the result primary is outside the accept-set, with a detail message', () => {
        const r = scorePrimaryExact(
            classification({ primary: 'electronics' }),
            {
                ...baseExpect,
                primary: ['apparel'],
            },
        )
        expect(r.pass).toBe(false)
        expect(r.detail).toContain('electronics')
    })
})

describe('scoreSecondaryTolerant', () => {
    it('passes when expect.secondary is null, regardless of the result', () => {
        const r = scoreSecondaryTolerant(
            classification({ secondary: 'travel' }),
            { ...baseExpect, secondary: null },
        )
        expect(r.pass).toBe(true)
    })

    it('passes when the result omits secondary, even if expect.secondary is a non-empty list', () => {
        const r = scoreSecondaryTolerant(
            classification({ secondary: undefined }),
            {
                ...baseExpect,
                secondary: ['beauty'],
            },
        )
        expect(r.pass).toBe(true)
    })

    it('passes when a present secondary is in the accept-set', () => {
        const r = scoreSecondaryTolerant(
            classification({ secondary: 'beauty' }),
            {
                ...baseExpect,
                secondary: ['beauty', 'jewelry_accessories'],
            },
        )
        expect(r.pass).toBe(true)
    })

    it('fails when a present secondary is outside the accept-set', () => {
        const r = scoreSecondaryTolerant(
            classification({ secondary: 'travel' }),
            {
                ...baseExpect,
                secondary: ['beauty'],
            },
        )
        expect(r.pass).toBe(false)
        expect(r.detail).toContain('travel')
    })
})

describe('scoreConfidenceBounds', () => {
    it('passes inside the inclusive bounds', () => {
        expect(
            scoreConfidenceBounds(classification({ confidence: 0.5 }), {
                ...baseExpect,
                confidence: [0.5, 0.9],
            }).pass,
        ).toBe(true)
        expect(
            scoreConfidenceBounds(classification({ confidence: 0.9 }), {
                ...baseExpect,
                confidence: [0.5, 0.9],
            }).pass,
        ).toBe(true)
    })

    it('fails outside the bounds', () => {
        const r = scoreConfidenceBounds(classification({ confidence: 0.95 }), {
            ...baseExpect,
            confidence: [0.5, 0.9],
        })
        expect(r.pass).toBe(false)
        expect(r.detail).toContain('0.95')
    })
})

describe('scoreSchemaValid', () => {
    it('passes for a well-formed Classification', () => {
        expect(scoreSchemaValid(classification()).pass).toBe(true)
    })

    it('fails for a malformed primary category', () => {
        const malformed = {
            primary: 'not-a-real-category',
            confidence: 0.5,
            cached: false,
        } as unknown as Classification
        const r = scoreSchemaValid(malformed)
        expect(r.pass).toBe(false)
        expect(r.detail).toContain('unknown primary category')
    })
})

describe('scoreLatencyBudget', () => {
    it('passes at or under the budget', () => {
        expect(scoreLatencyBudget(LATENCY_BUDGET_MS).pass).toBe(true)
        expect(scoreLatencyBudget(1).pass).toBe(true)
    })

    it('fails over the budget, with a detail message naming both numbers', () => {
        const r = scoreLatencyBudget(LATENCY_BUDGET_MS + 1)
        expect(r.pass).toBe(false)
        expect(r.detail).toContain(String(LATENCY_BUDGET_MS))
    })
})

describe('scoreCase', () => {
    const clearCase: CartCase = {
        name: 'clear-apparel',
        signals: { domain: 'scorer-test.example' },
        expect: { primary: ['apparel'], secondary: null, confidence: [0.5, 1] },
    }

    it('passes only when every scorer passes', () => {
        const summary = scoreCase(
            clearCase,
            classification({ confidence: 0.8 }),
            100,
        )
        expect(summary.pass).toBe(true)
        expect(summary.scorers).toHaveLength(5)
        expect(summary.scorers.every(s => s.pass)).toBe(true)
    })

    it('fails overall when exactly one scorer fails (confidence out of bounds)', () => {
        const summary = scoreCase(
            clearCase,
            classification({ confidence: 0.1 }),
            100,
        )
        expect(summary.pass).toBe(false)
        const confidenceScorer = summary.scorers.find(
            s => s.name === 'confidence-bounds',
        )
        expect(confidenceScorer?.pass).toBe(false)
        // Every other scorer still ran and still passed independently.
        expect(
            summary.scorers
                .filter(s => s.name !== 'confidence-bounds')
                .every(s => s.pass),
        ).toBe(true)
    })

    it('fails overall when the primary is wrong, even if everything else is fine', () => {
        const summary = scoreCase(
            clearCase,
            classification({ primary: 'electronics', confidence: 0.8 }),
            100,
        )
        expect(summary.pass).toBe(false)
        expect(
            summary.scorers.find(s => s.name === 'primary-exact')?.pass,
        ).toBe(false)
    })
})

describe('scoreThrown', () => {
    it('marks every scorer as failed with the error message in each detail', () => {
        const caseDef: CartCase = {
            name: 'throws-case',
            signals: { domain: 'scorer-throw-test.example' },
            expect: {
                primary: ['apparel'],
                secondary: null,
                confidence: [0, 1],
            },
        }
        const summary = scoreThrown(caseDef, new Error('boom'), 42)
        expect(summary.pass).toBe(false)
        expect(summary.caseName).toBe('throws-case')
        expect(summary.scorers).toHaveLength(5)
        for (const scorer of summary.scorers) {
            expect(scorer.pass).toBe(false)
            expect(scorer.detail).toContain('boom')
        }
    })

    it('stringifies a non-Error throw value', () => {
        const caseDef: CartCase = {
            name: 'throws-non-error',
            signals: { domain: 'scorer-throw-test-2.example' },
            expect: {
                primary: ['apparel'],
                secondary: null,
                confidence: [0, 1],
            },
        }
        const summary = scoreThrown(caseDef, 'a plain string rejection', 1)
        expect(summary.scorers[0]?.detail).toContain('a plain string rejection')
    })
})
