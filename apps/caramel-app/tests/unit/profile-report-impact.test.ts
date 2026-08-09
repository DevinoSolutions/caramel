import {
    isConfirmedReport,
    selectReportTier,
    SHOPPERS_HELPED_MIN,
    summarizeReports,
    type ReportWithCouponState,
} from '@/lib/profile/reportImpact'
import { describe, expect, it } from 'vitest'

// The account page's "your reports" section is the one most likely to ship a
// FALSE CLAIM about a user's impact, so its arithmetic is pinned here rather
// than only exercised through the route.
//
// Two things these tests exist to keep true:
//   1. "confirmed" means our own LATER recheck agreed — not that the coupon
//      happens to be valid now.
//   2. The "helped N shoppers" line never renders from an invented number, and
//      never below the N >= 10 floor.

const REPORTED_AT = new Date('2026-03-01T00:00:00.000Z')
const RECHECKED_AFTER = new Date('2026-03-05T00:00:00.000Z')
const RECHECKED_BEFORE = new Date('2026-02-20T00:00:00.000Z')

function report(
    overrides: Partial<ReportWithCouponState> & {
        coupon?: ReportWithCouponState['coupon']
    } = {},
): ReportWithCouponState {
    return {
        outcome: 'worked',
        createdAt: REPORTED_AT,
        coupon: {
            status: 'valid',
            expired: false,
            updatedAt: RECHECKED_AFTER,
        },
        ...overrides,
    }
}

describe('isConfirmedReport — a recheck that AGREED, not a restatement', () => {
    it('"worked" + a later recheck that left the coupon valid and unexpired → confirmed', () => {
        expect(isConfirmedReport(report())).toBe(true)
    })

    it('"failed" + a later recheck that expired the coupon → confirmed', () => {
        expect(
            isConfirmedReport(
                report({
                    outcome: 'failed',
                    coupon: {
                        status: 'valid',
                        expired: true,
                        updatedAt: RECHECKED_AFTER,
                    },
                }),
            ),
        ).toBe(true)
    })

    it('"failed" + a later recheck that de-validated the coupon → confirmed', () => {
        expect(
            isConfirmedReport(
                report({
                    outcome: 'failed',
                    coupon: {
                        status: 'invalid',
                        expired: false,
                        updatedAt: RECHECKED_AFTER,
                    },
                }),
            ),
        ).toBe(true)
    })

    it('"worked" but our later recheck DISAGREED (coupon now expired) → not confirmed', () => {
        expect(
            isConfirmedReport(
                report({
                    coupon: {
                        status: 'valid',
                        expired: true,
                        updatedAt: RECHECKED_AFTER,
                    },
                }),
            ),
        ).toBe(false)
    })

    it('the catalog was last written BEFORE the report → not confirmed (no recheck happened)', () => {
        // This is the load-bearing half: without the "after" requirement every
        // report about an already-valid coupon would confirm itself, and the
        // section would claim a verification that never ran.
        expect(
            isConfirmedReport(
                report({
                    coupon: {
                        status: 'valid',
                        expired: false,
                        updatedAt: RECHECKED_BEFORE,
                    },
                }),
            ),
        ).toBe(false)
    })

    it('a recheck at exactly the report timestamp → not confirmed (strictly later, not >=)', () => {
        expect(
            isConfirmedReport(
                report({
                    coupon: {
                        status: 'valid',
                        expired: false,
                        updatedAt: REPORTED_AT,
                    },
                }),
            ),
        ).toBe(false)
    })

    it('the coupon row is gone → not confirmed (we cannot agree with what we cannot see)', () => {
        expect(isConfirmedReport(report({ coupon: null }))).toBe(false)
    })

    it('an outcome outside the route vocabulary confirms nothing', () => {
        expect(isConfirmedReport(report({ outcome: 'maybe' }))).toBe(false)
    })
})

describe('summarizeReports', () => {
    it('a user with no reports gets nulls, NOT zeroes, for the derived counts', () => {
        // With nothing to confirm there is no confirmation rate to state, and
        // "0 matched what we found" reads as an accusation.
        expect(summarizeReports([])).toEqual({
            reportCount: 0,
            confirmedCount: null,
            shoppersHelped: null,
        })
    })

    it('counts reports and the subset our recheck agreed with', () => {
        const summary = summarizeReports([
            report(),
            report(),
            report({
                coupon: {
                    status: 'valid',
                    expired: false,
                    updatedAt: RECHECKED_BEFORE,
                },
            }),
        ])
        expect(summary.reportCount).toBe(3)
        expect(summary.confirmedCount).toBe(2)
    })

    it('zero confirmations out of REAL reports is a true, renderable 0', () => {
        const summary = summarizeReports([
            report({
                coupon: {
                    status: 'valid',
                    expired: false,
                    updatedAt: RECHECKED_BEFORE,
                },
            }),
        ])
        expect(summary.reportCount).toBe(1)
        expect(summary.confirmedCount).toBe(0)
    })

    it('shoppersHelped is ALWAYS null — no per-user usage attribution exists', () => {
        // Guard against a future "improvement" that derives this from
        // reportCount, Coupon.timesUsed or CouponSignal.workCount. All three
        // are anonymous aggregates; a number built from them would be a
        // fabricated public claim about other people's behaviour.
        //
        // reportCount is asserted alongside each null so the null is a claim
        // about a POPULATED summary. summarizeReports has an early return that
        // yields all-nulls for an empty input, so a bare `.shoppersHelped` is
        // null on the path this test is not about — and would stay green if
        // the populated branch broke, or if `report()` drifted out of shape.
        const one = summarizeReports([report()])
        expect(one.reportCount).toBe(1)
        expect(one.shoppersHelped).toBeNull()

        const many = summarizeReports(
            Array.from({ length: 50 }, () => report()),
        )
        expect(many.reportCount).toBe(50)
        expect(many.shoppersHelped).toBeNull()
    })
})

describe('selectReportTier — highest tier the data genuinely supports', () => {
    it('no reports → no section at all', () => {
        expect(
            selectReportTier({
                reportCount: 0,
                confirmedCount: null,
                shoppersHelped: null,
            }),
        ).toBe('none')
    })

    it('reports only → tier A (thanks framing, no impact claim)', () => {
        expect(
            selectReportTier({
                reportCount: 7,
                confirmedCount: null,
                shoppersHelped: null,
            }),
        ).toBe('A')
    })

    it('confirmedCount 0 falls back to tier A, not a "0 matched" claim', () => {
        expect(
            selectReportTier({
                reportCount: 7,
                confirmedCount: 0,
                shoppersHelped: null,
            }),
        ).toBe('A')
    })

    it('a real confirmedCount → tier B', () => {
        expect(
            selectReportTier({
                reportCount: 7,
                confirmedCount: 5,
                shoppersHelped: null,
            }),
        ).toBe('B')
    })

    it(`shoppersHelped below the floor of ${SHOPPERS_HELPED_MIN} is SUPPRESSED — falls to tier B`, () => {
        // "You helped 2 shoppers" is technically true and rhetorically worse
        // than silence: it makes a real contribution sound trivial.
        expect(
            selectReportTier({
                reportCount: 7,
                confirmedCount: 5,
                shoppersHelped: 2,
            }),
        ).toBe('B')
        expect(
            selectReportTier({
                reportCount: 7,
                confirmedCount: 5,
                shoppersHelped: SHOPPERS_HELPED_MIN - 1,
            }),
        ).toBe('B')
    })

    it('suppressed shoppersHelped with no confirmedCount falls all the way to tier A', () => {
        expect(
            selectReportTier({
                reportCount: 7,
                confirmedCount: null,
                shoppersHelped: 3,
            }),
        ).toBe('A')
    })

    it(`shoppersHelped at exactly ${SHOPPERS_HELPED_MIN} → tier C`, () => {
        expect(
            selectReportTier({
                reportCount: 7,
                confirmedCount: 5,
                shoppersHelped: SHOPPERS_HELPED_MIN,
            }),
        ).toBe('C')
    })

    it('the tier chain degrades on a MISSING field rather than rendering a hole', () => {
        // A payload that loses confirmedCount must drop to A, never render
        // tier-B copy with an empty number in it.
        expect(
            selectReportTier({
                reportCount: 4,
                confirmedCount: null,
                shoppersHelped: null,
            }),
        ).toBe('A')
    })
})
