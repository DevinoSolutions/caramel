import {
    FAILING_MIN_FAIL_COUNT,
    FAILING_WINDOW_DAYS,
    isRecentlyFailing,
    KEEPS_FAILING_MIN_FAIL_COUNT,
    keepsFailing,
} from '@/lib/coupons'
import { listCoupons, listStoreCoupons } from '@/lib/couponsRepo'
import { formatFailedAgo } from '@/lib/relativeTime'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #288 first slice: a code that keeps failing SINKS below the rest and is never
// hidden. Three layers are pinned here:
//   * isRecentlyFailing — the one TS predicate (edge cases: no signal, one
//     failure, a later success, an old failure).
//   * the SQL twin in couponsRepo — composed into ORDER BY on store-scoped
//     reads only, never into the WHERE (sink, not hide), with the same numbers.
//   * formatFailedAgo — the card's truthful "Reported not working" wording.
// The repo tests mock `@/lib/prisma` and assert on the composed `.sql` string
// (docs/agent/gotchas.md: a nested Prisma.sql fragment inlines into the parent).
const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function ago(ms: number): string {
    return new Date(NOW - ms).toISOString()
}

describe('keepsFailing (the collapse threshold, a stricter isRecentlyFailing)', () => {
    it('the collapse threshold is above the sink threshold', () => {
        expect(KEEPS_FAILING_MIN_FAIL_COUNT).toBe(3)
        expect(KEEPS_FAILING_MIN_FAIL_COUNT).toBeGreaterThan(
            FAILING_MIN_FAIL_COUNT,
        )
    })

    it('no signal, or a sink-only count (2 failures) → false', () => {
        expect(keepsFailing({}, NOW)).toBe(false)
        expect(keepsFailing({ failCount: 0, lastFailedAt: null }, NOW)).toBe(
            false,
        )
        expect(
            keepsFailing(
                { failCount: FAILING_MIN_FAIL_COUNT, lastFailedAt: ago(HOUR) },
                NOW,
            ),
        ).toBe(false)
    })

    it('the threshold itself (3 recent failures, no success) → true', () => {
        expect(
            keepsFailing(
                {
                    failCount: KEEPS_FAILING_MIN_FAIL_COUNT,
                    lastFailedAt: ago(HOUR),
                },
                NOW,
            ),
        ).toBe(true)
        expect(
            keepsFailing(
                {
                    failCount: KEEPS_FAILING_MIN_FAIL_COUNT - 1,
                    lastFailedAt: ago(HOUR),
                },
                NOW,
            ),
        ).toBe(false)
    })

    it('one later success clears it, however many failures piled up', () => {
        expect(
            keepsFailing(
                {
                    failCount: 50,
                    lastFailedAt: ago(2 * DAY),
                    lastWorkedAt: ago(DAY),
                },
                NOW,
            ),
        ).toBe(false)
        // A success BEFORE the last failure does not save it.
        expect(
            keepsFailing(
                {
                    failCount: 4,
                    lastFailedAt: ago(DAY),
                    lastWorkedAt: ago(5 * DAY),
                },
                NOW,
            ),
        ).toBe(true)
    })

    it('failures outside the 30-day window no longer count', () => {
        expect(
            keepsFailing(
                {
                    failCount: 10,
                    lastFailedAt: ago((FAILING_WINDOW_DAYS + 1) * DAY),
                },
                NOW,
            ),
        ).toBe(false)
        expect(
            keepsFailing(
                {
                    failCount: 10,
                    lastFailedAt: ago((FAILING_WINDOW_DAYS - 1) * DAY),
                },
                NOW,
            ),
        ).toBe(true)
    })

    it('an unparseable timestamp is "no signal", never "keeps failing"', () => {
        expect(
            keepsFailing({ failCount: 9, lastFailedAt: 'not a date' }, NOW),
        ).toBe(false)
    })
})

describe('isRecentlyFailing', () => {
    it('no signal at all → false (absent is never "failing")', () => {
        expect(isRecentlyFailing({}, NOW)).toBe(false)
        expect(
            isRecentlyFailing(
                { failCount: 0, lastFailedAt: null, lastWorkedAt: null },
                NOW,
            ),
        ).toBe(false)
    })

    it('a single failure is noise → false; the threshold itself → true', () => {
        expect(
            isRecentlyFailing(
                {
                    failCount: FAILING_MIN_FAIL_COUNT - 1,
                    lastFailedAt: ago(HOUR),
                },
                NOW,
            ),
        ).toBe(false)
        expect(
            isRecentlyFailing(
                { failCount: FAILING_MIN_FAIL_COUNT, lastFailedAt: ago(HOUR) },
                NOW,
            ),
        ).toBe(true)
    })

    it('failures with no success ever → true', () => {
        expect(
            isRecentlyFailing(
                { failCount: 5, lastFailedAt: ago(DAY), lastWorkedAt: null },
                NOW,
            ),
        ).toBe(true)
    })

    it('a success AFTER the last failure resets it → false', () => {
        expect(
            isRecentlyFailing(
                {
                    failCount: 9,
                    lastFailedAt: ago(2 * DAY),
                    lastWorkedAt: ago(DAY),
                },
                NOW,
            ),
        ).toBe(false)
    })

    it('a success BEFORE the last failure does not save it → true', () => {
        expect(
            isRecentlyFailing(
                {
                    failCount: 3,
                    lastFailedAt: ago(DAY),
                    lastWorkedAt: ago(5 * DAY),
                },
                NOW,
            ),
        ).toBe(true)
    })

    it('a success at the very same instant as the failure counts as a reset', () => {
        const same = ago(DAY)
        expect(
            isRecentlyFailing(
                { failCount: 3, lastFailedAt: same, lastWorkedAt: same },
                NOW,
            ),
        ).toBe(false)
    })

    it('a failure older than the window expires → false; just inside → true', () => {
        const windowMs = FAILING_WINDOW_DAYS * DAY
        expect(
            isRecentlyFailing(
                { failCount: 10, lastFailedAt: ago(windowMs + 1) },
                NOW,
            ),
        ).toBe(false)
        expect(
            isRecentlyFailing(
                { failCount: 10, lastFailedAt: ago(windowMs - 1) },
                NOW,
            ),
        ).toBe(true)
    })

    it('an unparseable or far-future lastFailedAt → false', () => {
        expect(
            isRecentlyFailing({ failCount: 4, lastFailedAt: 'garbage' }, NOW),
        ).toBe(false)
        expect(
            isRecentlyFailing(
                {
                    failCount: 4,
                    lastFailedAt: new Date(NOW + DAY).toISOString(),
                },
                NOW,
            ),
        ).toBe(false)
    })

    it('accepts Date values as well as ISO strings', () => {
        expect(
            isRecentlyFailing(
                {
                    failCount: 2,
                    lastFailedAt: new Date(NOW - HOUR),
                    lastWorkedAt: new Date(NOW - 3 * DAY),
                },
                NOW,
            ),
        ).toBe(true)
    })
})

describe('formatFailedAgo', () => {
    it('absent / unparseable → null', () => {
        expect(formatFailedAgo(null, NOW)).toBeNull()
        expect(formatFailedAgo(undefined, NOW)).toBeNull()
        expect(formatFailedAgo('nope', NOW)).toBeNull()
    })

    it('under an hour → "just now" (never "0h ago")', () => {
        expect(formatFailedAgo(ago(0), NOW)).toBe(
            'Reported not working just now',
        )
        expect(formatFailedAgo(ago(HOUR - 1), NOW)).toBe(
            'Reported not working just now',
        )
    })

    it('hours, then days', () => {
        expect(formatFailedAgo(ago(3 * HOUR), NOW)).toBe(
            'Reported not working 3h ago',
        )
        expect(formatFailedAgo(ago(DAY), NOW)).toBe(
            'Reported not working 1d ago',
        )
        expect(formatFailedAgo(ago(20 * DAY), NOW)).toBe(
            'Reported not working 20d ago',
        )
    })
})

let capturedQueries: { sql: string; values: unknown[] }[] = []

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (arg: { sql: string; values: unknown[] }) => {
            capturedQueries.push({ sql: arg.sql, values: arg.values })
            return Promise.resolve([])
        },
    },
}))

beforeEach(() => {
    capturedQueries = []
})

function listQuery() {
    const q = capturedQueries.find(
        c => c.sql.includes('FROM coupons') && c.sql.includes('LIMIT'),
    )
    expect(q, 'a list query was issued').toBeDefined()
    return q!
}

/** The text after ORDER BY (the whole tail of the list query). */
function orderBy(sql: string): string {
    return sql.slice(sql.indexOf('ORDER BY'))
}

/** The text before ORDER BY, i.e. the SELECT + WHERE. */
function beforeOrderBy(sql: string): string {
    return sql.slice(0, sql.indexOf('ORDER BY'))
}

describe('failing codes sink in SQL on store-scoped reads (sink, never hide)', () => {
    it('listStoreCoupons orders the failing flag first, then the ranking order', async () => {
        await listStoreCoupons('example.com', 20)

        const { sql, values } = listQuery()
        const order = orderBy(sql)
        expect(order).toMatch(/^ORDER BY \(id IN \(\s*SELECT s\.coupon_id/)
        expect(order).toContain('FROM coupon_signals s')
        expect(order).toContain('s.fail_count >= ?')
        expect(order).toContain('s.last_failed_at >')
        expect(order).toContain(
            '(s.last_worked_at IS NULL OR s.last_failed_at > s.last_worked_at)',
        )
        // false (not failing) sorts first; the ranking order breaks ties.
        expect(order).toMatch(
            /\)\) ASC, rating DESC, created_at DESC, id DESC\s+LIMIT/,
        )
        // The thresholds are the coupons.ts constants, bound as parameters.
        expect(values).toContain(FAILING_MIN_FAIL_COUNT)
        expect(values).toContain(FAILING_WINDOW_DAYS)
    })

    it('keeps-failing is the SECOND ordering key: merely-failing codes precede it, ranking breaks ties', async () => {
        await listStoreCoupons('example.com', 20)

        const { sql, values } = listQuery()
        const order = orderBy(sql)
        // Two coupon_signals subqueries (sink, then collapse), both ASC, then ranking.
        expect(order.match(/FROM coupon_signals s/g)).toHaveLength(2)
        expect(order).toMatch(
            /\)\) ASC,\s*\(id IN \(\s*SELECT s\.coupon_id[\s\S]*\)\) ASC, rating DESC, created_at DESC, id DESC\s+LIMIT/,
        )
        // Each subquery binds its own fail_count threshold, in sink-then-collapse order.
        expect(values.indexOf(FAILING_MIN_FAIL_COUNT)).toBeGreaterThanOrEqual(0)
        expect(values.indexOf(KEEPS_FAILING_MIN_FAIL_COUNT)).toBeGreaterThan(
            values.indexOf(FAILING_MIN_FAIL_COUNT),
        )
    })

    it('listCoupons with a site uses the same sinking order', async () => {
        await listCoupons({ baseSite: 'example.com', limit: 20, skip: 20 })

        const { sql } = listQuery()
        expect(orderBy(sql)).toMatch(
            /^ORDER BY \(id IN \(\s*SELECT s\.coupon_id/,
        )
        expect(orderBy(sql)).toContain(
            ') ASC, rating DESC, created_at DESC, id DESC',
        )
    })

    it('listCoupons WITHOUT a site (browse/search) keeps the plain ranking order', async () => {
        await listCoupons({ limit: 10, skip: 0 })

        const { sql } = listQuery()
        expect(orderBy(sql)).not.toContain('coupon_signals')
        expect(orderBy(sql)).toContain(
            'ORDER BY rating DESC, created_at DESC, id DESC',
        )
    })

    it('never filters: coupon_signals appears in ORDER BY only, not in WHERE, and the count is untouched', async () => {
        await listStoreCoupons('example.com', 20)
        await listCoupons({ baseSite: 'example.com', limit: 20, skip: 0 })

        for (const q of capturedQueries) {
            expect(beforeOrderBy(q.sql)).not.toContain('coupon_signals')
        }
        const counts = capturedQueries.filter(q => !q.sql.includes('LIMIT'))
        expect(counts.length).toBeGreaterThan(0)
        for (const q of counts) {
            expect(q.sql).not.toContain('coupon_signals')
        }
    })
})
