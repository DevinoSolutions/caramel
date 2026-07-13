// F-012 — LIVE eval suite for the repo's only LLM surface. Calls the
// PRODUCTION classifyCart() (real prompt, real parsing/schema — imported,
// never copied) against the fixed dataset in fixtures/cart-cases.ts, scores
// deterministically (see scorers.ts), and gates on the primary-match rate.
//
// NOT collected by the regular unit suite: F-004's vitest.config.ts
// excludes `**/*.eval.*`, and only `vitest.eval.config.ts` (this file's
// `include`) picks it up — see package.json's "eval" script and
// .github/workflows/ai-evals.yml. Running this costs real OpenRouter spend
// (~40 short completions, temperature 0, see evals/README.md).
import { classifyCart } from '@/lib/cartClassifier'
import { env } from '@/lib/env'
import { beforeAll, expect, it } from 'vitest'
import { cartCases } from './fixtures/cart-cases'
import {
    formatScoreboardRow,
    runEvalSuite,
    type CartCase,
    type EvalSuiteResult,
} from './scorers'

const PRIMARY_MATCH_THRESHOLD = 0.85

// Red-proof mode (PLAN-F-012.md §Sequencing step 6) — SCRAMBLE_EVAL=1
// rotates each case's *expected* label onto its neighbor, so a correctly
// functioning model still fails almost every case (see fixtures/
// cart-cases.ts's module comment: the first 8 entries are one-per-category
// by construction, so a rotate-by-1 within that slice is guaranteed to
// mismatch every case). Also caps the run to those 8 cases — proving the
// gate bites doesn't need to re-spend the full ~$0.20 baseline; see
// evals/README.md §Red-proof and EXECUTOR-BRIEF's cost guidance.
const SMOKE_SIZE = 8
const SCRAMBLE = process.env.SCRAMBLE_EVAL === '1'

function rotateExpectations(cases: readonly CartCase[]): CartCase[] {
    return cases.map((caseDef, i) => ({
        ...caseDef,
        expect: cases[(i + 1) % cases.length]!.expect,
    }))
}

const activeCases = SCRAMBLE
    ? rotateExpectations(cartCases.slice(0, SMOKE_SIZE))
    : cartCases

let suite: EvalSuiteResult

// Sequential by construction (runEvalSuite's `for` loop, no Promise.all) —
// polite to OpenRouter's rate limits (PLAN-F-012.md §Approach). Cases run
// inside ONE beforeAll (not one `it` per case) so a single generous
// hookTimeout (vitest.eval.config.ts) covers the whole live loop while the
// `it` below — the actual CI gate — stays fast and its failure message
// names every failing case (no per-case `it` noise failing the run over a
// single borderline case when the aggregate gate would still pass).
beforeAll(async () => {
    suite = await runEvalSuite(activeCases, classifyCart)
    console.log(
        `[cart-classifier-eval] ${formatScoreboardRow(suite, env.OPENROUTER_MODEL)}${
            SCRAMBLE ? ' [SCRAMBLE_EVAL smoke]' : ''
        }`,
    )
})

it(
    SCRAMBLE
        ? `primary-match rate meets the >=${PRIMARY_MATCH_THRESHOLD} threshold gate [SCRAMBLE_EVAL smoke — expected to fail]`
        : `primary-match rate meets the >=${PRIMARY_MATCH_THRESHOLD} threshold gate`,
    () => {
        const failingCaseNames = suite.summaries
            .filter(s => !s.pass)
            .map(s => s.caseName)
        expect(
            suite.primaryMatchRate,
            failingCaseNames.length
                ? `primary_match_rate=${(suite.primaryMatchRate * 100).toFixed(1)}% (${suite.summaries.length} cases) — failing: ${failingCaseNames.join(', ')}`
                : undefined,
        ).toBeGreaterThanOrEqual(PRIMARY_MATCH_THRESHOLD)
    },
)
