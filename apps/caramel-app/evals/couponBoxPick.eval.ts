// LIVE eval suite for the coupon-box pick (POST /api/extension/coupon-box-pick).
// Calls the PRODUCTION pickCouponBox() — real prompt, scrub, parsing and
// index validation, imported and never copied — on the labelled real cart
// pages in fixtures/coupon-box-cases.ts, scores each answer deterministically,
// and gates on the pass rate.
//
// NOT collected by the unit suite (vitest.config.ts excludes `**/*.eval.*`);
// only vitest.eval.config.ts picks it up. Needs OPENROUTER_API_KEY (and
// OPENROUTER_API_URL when the model lives behind another OpenAI-compatible
// base) plus COUPON_BOX_PICK_MODEL — the model under test. With no model the
// suite fails loudly instead of passing vacuously. Costs one short completion
// per case (65), temperature 0.
//
// A case passes when:
//   * the page has a box: the picked input is one of the labelled inputs (and,
//     on a case that labels its buttons, the picked button is one of them),
//     or no input was picked and the picked toggle is one of the labelled
//     toggles (the box is behind it);
//   * the page has no box: neither an input nor a toggle was picked.
// Anything else — a wrong field, a wrong apply button, a missed box, a pick on
// a box-less page, a refused answer, a model error or an unusable reply —
// fails the case. A case marked knownMiss still runs and is reported, but is
// left out of the pass rate.
import {
    CouponBoxOutlineTooLargeError,
    pickCouponBox,
    type CouponBoxPickResult,
} from '@/lib/couponBoxPick'
import { env } from '@/lib/env'
import { beforeAll, expect, it } from 'vitest'
import { couponBoxCases, type CouponBoxCase } from './fixtures/coupon-box-cases'

const PASS_RATE_THRESHOLD = 0.9
// Cases run one at a time, as production calls arrive, so the latency figures
// are not inflated by the suite's own load (~2 minutes measured at 63 calls).
const SUITE_TIMEOUT_MS = 12 * 60 * 1000

interface Pick {
    input: number | null
    button: number | null
    toggle: number | null
}

interface CaseOutcome {
    store: string
    pass: boolean
    /** The pick's outcome, or 'too_large' when the outline was refused. */
    outcome: CouponBoxPickResult['outcome'] | 'too_large'
    detail: string
    picked: Pick
    ms: number
}

const NOTHING: Pick = { input: null, button: null, toggle: null }

function pickOf(result: CouponBoxPickResult): Pick {
    return result.outcome === 'box'
        ? { input: result.input, button: result.button, toggle: result.toggle }
        : NOTHING
}

function judge(c: CouponBoxCase, picked: Pick): boolean {
    const hasBox = c.inputs.length > 0 || c.toggles.length > 0
    if (!hasBox) return picked.input === null && picked.toggle === null
    if (picked.input !== null)
        return (
            c.inputs.includes(picked.input) &&
            (!c.buttons ||
                (picked.button !== null && c.buttons.includes(picked.button)))
        )
    return picked.toggle !== null && c.toggles.includes(picked.toggle)
}

async function runCase(c: CouponBoxCase): Promise<CaseOutcome> {
    const started = Date.now()
    try {
        const result = await pickCouponBox({
            domain: c.store,
            outline: c.outline,
        })
        const picked = pickOf(result)
        return {
            store: c.store,
            pass: judge(c, picked),
            outcome: result.outcome,
            detail: result.outcome === 'no_pick' ? result.reason : '',
            picked,
            ms: Date.now() - started,
        }
    } catch (error) {
        if (!(error instanceof CouponBoxOutlineTooLargeError)) throw error
        return {
            store: c.store,
            pass: judge(c, NOTHING),
            outcome: 'too_large',
            detail: error.message,
            picked: NOTHING,
            ms: Date.now() - started,
        }
    }
}

async function runAll(cases: readonly CouponBoxCase[]): Promise<CaseOutcome[]> {
    const outcomes: CaseOutcome[] = []
    for (const c of cases) outcomes.push(await runCase(c))
    return outcomes
}

function percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b)
    return (
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
    )
}

const fmt = (n: number | null) => (n === null ? '-' : String(n))
const fmtPick = (p: Pick) =>
    `input=${fmt(p.input)} button=${fmt(p.button)} toggle=${fmt(p.toggle)}`
const fmtList = (xs: number[]) => (xs.length ? xs.join('|') : '-')

let outcomes: CaseOutcome[] = []
let passRate = 0

beforeAll(async () => {
    if (!env.COUPON_BOX_PICK_MODEL) {
        throw new Error(
            'COUPON_BOX_PICK_MODEL is not set: the coupon-box pick eval needs the model under test',
        )
    }
    // A label that names no node in its own outline can never be matched: it
    // would silently turn a case into a free miss or a free pass.
    const stale = couponBoxCases.flatMap(c =>
        [...c.inputs, ...(c.buttons ?? []), ...c.toggles]
            .filter(
                n =>
                    !new RegExp(`^\\s*- \\[${n}\\] [a-z]`, 'm').test(c.outline),
            )
            .map(n => `${c.store}[${n}]`),
    )
    if (stale.length)
        throw new Error(
            `fixture labels not in their outline: ${stale.join(', ')}`,
        )
    outcomes = await runAll(couponBoxCases)
    const scored = outcomes.filter((_, i) => !couponBoxCases[i]!.knownMiss)
    const passed = scored.filter(o => o.pass).length
    passRate = passed / scored.length
    const answered = outcomes
        .filter(o => o.outcome !== 'too_large')
        .map(o => o.ms)
    console.log(
        `[coupon-box-pick-eval] model=${env.COUPON_BOX_PICK_MODEL} cases=${scored.length} pass=${passed}/${scored.length} (${(passRate * 100).toFixed(1)}%) p50=${percentile(answered, 0.5)}ms p95=${percentile(answered, 0.95)}ms known-misses=${outcomes.length - scored.length}`,
    )
    // Paired by position, not by store: a store can have more than one case
    // (two snapshots of its page), so its name does not pick out one label.
    outcomes.forEach((o, i) => {
        const c = couponBoxCases[i]!
        const verdict = c.knownMiss
            ? o.pass
                ? 'KNOWN-MISS-NOW-PASSES'
                : 'known-miss'
            : o.pass
              ? 'pass'
              : 'FAIL'
        console.log(
            `[coupon-box-pick-eval] ${verdict} ${o.store} ${o.ms}ms: ${o.outcome}${o.detail ? ` (${o.detail})` : ''} picked ${fmtPick(o.picked)}; expected input=${fmtList(c.inputs)} button=${c.buttons ? fmtList(c.buttons) : 'any'} toggle=${fmtList(c.toggles)}`,
        )
    })
}, SUITE_TIMEOUT_MS)

it(`pass rate meets the >=${PASS_RATE_THRESHOLD} threshold gate`, () => {
    const scored = outcomes.filter((_, i) => !couponBoxCases[i]!.knownMiss)
    const failing = scored.filter(o => !o.pass).map(o => o.store)
    expect(
        passRate,
        failing.length
            ? `pass_rate=${(passRate * 100).toFixed(1)}% (${scored.length} cases) — failing: ${failing.join(', ')}`
            : undefined,
    ).toBeGreaterThanOrEqual(PASS_RATE_THRESHOLD)
})
