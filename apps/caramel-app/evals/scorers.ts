// F-012 — pure, deterministic scorers for the cart-classifier eval suite.
// No LLM-as-judge: every check here is a plain comparison against a fixed
// dataset's accept-sets (see PLAN-F-012.md §Approach — "unjustified for a
// 16-class advisory label"). Imported by both the LIVE suite
// (evals/cartClassifier.eval.ts) and the FREE mocked-pipeline unit test
// (tests/unit/cartClassifier.pipeline.test.ts) so the exact same
// scoring+aggregation code is what's proven red and green.
import {
    classificationSchema,
    type CartSignals,
    type Category,
    type Classification,
} from '@/lib/cartClassifier'

/** Matches classifyCart's own `chat()` call (`timeoutMs: 7000`) + margin. */
export const LATENCY_BUDGET_MS = 7500

/**
 * What a fixture case accepts as a correct result.
 *
 * `secondary: null` means "no constraint — any value, including absence,
 * is fine" (used for cases where a second category is inherently
 * unpredictable and not worth gating, e.g. junk/ambiguous carts). A
 * non-empty array means: IF the model returns a secondary, it must be one
 * of these; omitting secondary is always acceptable too — the model is
 * never required to find one (the "secondary-tolerant" scorer below).
 */
export interface CaseExpectation {
    primary: Category[]
    secondary: Category[] | null
    confidence: [min: number, max: number]
}

export interface CartCase {
    name: string
    signals: CartSignals
    expect: CaseExpectation
}

export interface ScorerResult {
    name: string
    pass: boolean
    /** Present only on failure — human-readable reason. */
    detail?: string
}

export interface CaseScoreSummary {
    caseName: string
    /** True only when every scorer passed (PLAN-F-012.md: "Case-pass = ALL scorers pass"). */
    pass: boolean
    scorers: ScorerResult[]
}

export function scorePrimaryExact(
    result: Classification,
    expected: CaseExpectation,
): ScorerResult {
    const pass = expected.primary.includes(result.primary)
    return {
        name: 'primary-exact',
        pass,
        detail: pass
            ? undefined
            : `expected primary in [${expected.primary.join(', ')}], got "${result.primary}"`,
    }
}

export function scoreSecondaryTolerant(
    result: Classification,
    expected: CaseExpectation,
): ScorerResult {
    if (expected.secondary === null || result.secondary === undefined) {
        return { name: 'secondary-tolerant', pass: true }
    }
    const pass = expected.secondary.includes(result.secondary)
    return {
        name: 'secondary-tolerant',
        pass,
        detail: pass
            ? undefined
            : `secondary "${result.secondary}" not in accepted [${expected.secondary.join(', ')}]`,
    }
}

export function scoreConfidenceBounds(
    result: Classification,
    expected: CaseExpectation,
): ScorerResult {
    const [min, max] = expected.confidence
    const pass = result.confidence >= min && result.confidence <= max
    return {
        name: 'confidence-bounds',
        pass,
        detail: pass
            ? undefined
            : `confidence ${result.confidence} outside [${min}, ${max}]`,
    }
}

/**
 * Re-validates the already-returned result against the SAME production
 * schema (classifyCart already ran it once internally to get here — this
 * is deliberate defense-in-depth, not redundant faith: it catches a future
 * bug that returns a malformed shape without throwing).
 */
export function scoreSchemaValid(result: Classification): ScorerResult {
    const check = classificationSchema.safeParse(result)
    return {
        name: 'schema-valid',
        pass: check.success,
        detail: check.success ? undefined : check.error.issues[0]?.message,
    }
}

export function scoreLatencyBudget(latencyMs: number): ScorerResult {
    const pass = latencyMs <= LATENCY_BUDGET_MS
    return {
        name: 'latency-budget',
        pass,
        detail: pass
            ? undefined
            : `${latencyMs.toFixed(0)}ms exceeds ${LATENCY_BUDGET_MS}ms budget`,
    }
}

const ALL_SCORER_NAMES = [
    'primary-exact',
    'secondary-tolerant',
    'confidence-bounds',
    'schema-valid',
    'latency-budget',
] as const

/** Case-pass = ALL scorers pass (PLAN-F-012.md §Approach). */
export function scoreCase(
    caseDef: CartCase,
    result: Classification,
    latencyMs: number,
): CaseScoreSummary {
    const scorers = [
        scorePrimaryExact(result, caseDef.expect),
        scoreSecondaryTolerant(result, caseDef.expect),
        scoreConfidenceBounds(result, caseDef.expect),
        scoreSchemaValid(result),
        scoreLatencyBudget(latencyMs),
    ]
    return {
        caseName: caseDef.name,
        pass: scorers.every(s => s.pass),
        scorers,
    }
}

/** classifyCart threw — every scorer is unscoreable, so every scorer fails. */
export function scoreThrown(
    caseDef: CartCase,
    error: unknown,
    latencyMs: number,
): CaseScoreSummary {
    const detail = `classifyCart threw: ${error instanceof Error ? error.message : String(error)} (after ${latencyMs.toFixed(0)}ms)`
    return {
        caseName: caseDef.name,
        pass: false,
        scorers: ALL_SCORER_NAMES.map(name => ({ name, pass: false, detail })),
    }
}

export interface EvalSuiteResult {
    summaries: CaseScoreSummary[]
    primaryMatchRate: number
    schemaValidRate: number
    latenciesMs: number[]
}

function rateOf(summaries: CaseScoreSummary[], scorerName: string): number {
    if (summaries.length === 0) return 0
    const passed = summaries.filter(s =>
        s.scorers.find(sc => sc.name === scorerName && sc.pass),
    ).length
    return passed / summaries.length
}

/**
 * Runs `cases` through `classify` SEQUENTIALLY (no `Promise.all` — polite to
 * OpenRouter's rate limits per PLAN-F-012.md §Approach) and scores each
 * result. `classify` is injected so the exact same orchestration proves
 * both: the LIVE suite (real `classifyCart`) and the FREE mocked-pipeline
 * unit test (a canned/mocked classify function) — see
 * tests/unit/cartClassifier.pipeline.test.ts.
 */
export async function runEvalSuite(
    cases: readonly CartCase[],
    classify: (signals: CartSignals) => Promise<Classification>,
): Promise<EvalSuiteResult> {
    const summaries: CaseScoreSummary[] = []
    const latenciesMs: number[] = []
    for (const caseDef of cases) {
        const start = performance.now()
        try {
            const result = await classify(caseDef.signals)
            const latencyMs = performance.now() - start
            latenciesMs.push(latencyMs)
            summaries.push(scoreCase(caseDef, result, latencyMs))
        } catch (error) {
            const latencyMs = performance.now() - start
            latenciesMs.push(latencyMs)
            summaries.push(scoreThrown(caseDef, error, latencyMs))
        }
    }
    return {
        summaries,
        primaryMatchRate: rateOf(summaries, 'primary-exact'),
        schemaValidRate: rateOf(summaries, 'schema-valid'),
        latenciesMs,
    }
}

function percentile(sortedAsc: number[], p: number): number {
    if (sortedAsc.length === 0) return 0
    const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length))
    return sortedAsc[idx]!
}

/** One human-readable line — logged by the live suite, and the basis for evals/SCOREBOARD.md rows. */
export function formatScoreboardRow(
    suite: EvalSuiteResult,
    model: string,
): string {
    const sorted = [...suite.latenciesMs].sort((a, b) => a - b)
    const p50 = percentile(sorted, 0.5)
    const p95 = percentile(sorted, 0.95)
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`
    return (
        `model=${model} cases=${suite.summaries.length} ` +
        `primary_match_rate=${pct(suite.primaryMatchRate)} ` +
        `schema_valid_rate=${pct(suite.schemaValidRate)} ` +
        `p50_latency_ms=${p50.toFixed(0)} p95_latency_ms=${p95.toFixed(0)}`
    )
}
