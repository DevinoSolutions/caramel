// tests/unit/support/siteSuggestionsPrismaFake.ts
//
// ANNOUNCED FAKE — not a mock that returns canned values.
//
// A tiny in-memory `site_suggestions` table that really honours the
// where/orderBy/take/select the lib sends, so the rules under test (the
// allowed-source guard in the transition's WHERE clause, the `notifiedAt: null`
// claim, the only-`new`-flips-to-imported contract, the `since` cut) are
// genuinely EXERCISED rather than asserted from a stubbed return value. A
// recording-only mock would let a wrong WHERE clause pass every assertion,
// which is exactly the class of bug these suites exist to catch.
//
// It is NOT a Postgres: a window function, a real index or an FK is not
// something this can judge. Those live in tests/integration/site-suggestions.itest.ts.
import { vi } from 'vitest'

export interface FakeSuggestionRow {
    id: string
    domain: string
    rawUrl: string
    userId: string | null
    requesterEmail: string | null
    source: string
    userAgent: string | null
    status: string
    createdAt: Date
    importedAt: Date | null
    statusChangedAt: Date | null
    notifiedAt: Date | null
}

/** The shared table. `vi.mock('@/lib/prisma')` and the test file import the
 * SAME module instance, so both see these rows. */
export const table: FakeSuggestionRow[] = []

type Condition = unknown

/** The subset of Prisma's filter grammar this lib actually uses. Anything the
 * lib starts sending that is not handled here THROWS, so the fake can never
 * silently ignore a clause and report a pass it did not earn. */
function matchesField(value: unknown, cond: Condition): boolean {
    if (cond === null) return value === null
    if (cond instanceof Date) {
        return value instanceof Date && value.getTime() === cond.getTime()
    }
    if (typeof cond === 'object') {
        const record = cond as Record<string, unknown>
        for (const key of Object.keys(record)) {
            if (key === 'in') {
                if (!(record.in as unknown[]).includes(value)) return false
            } else if (key === 'gte') {
                if (!(value instanceof Date)) return false
                if (value < (record.gte as Date)) return false
            } else if (key === 'not') {
                if (matchesField(value, record.not)) return false
            } else {
                throw new Error(`fake prisma: unsupported operator "${key}"`)
            }
        }
        return true
    }
    return value === cond
}

export function matchesWhere(
    row: FakeSuggestionRow,
    where: Record<string, unknown> | undefined,
): boolean {
    if (!where) return true
    for (const [key, cond] of Object.entries(where)) {
        if (key === 'NOT') {
            if (matchesWhere(row, cond as Record<string, unknown>)) return false
            continue
        }
        if (!(key in row)) {
            throw new Error(`fake prisma: unknown column "${key}"`)
        }
        if (!matchesField(row[key as keyof FakeSuggestionRow], cond)) {
            return false
        }
    }
    return true
}

function project(
    row: FakeSuggestionRow,
    select: Record<string, true> | undefined,
): Record<string, unknown> {
    if (!select) return { ...row }
    const picked: Record<string, unknown> = {}
    for (const key of Object.keys(select)) {
        picked[key] = row[key as keyof FakeSuggestionRow]
    }
    return picked
}

/** Oldest-first insertion sort — the tsconfig lib predates toSorted, and
 * Array#sort would mutate the table itself. */
function orderedByCreatedAt(rows: FakeSuggestionRow[]): FakeSuggestionRow[] {
    const ordered: FakeSuggestionRow[] = []
    for (const row of rows) {
        const after = ordered.findIndex(r => r.createdAt > row.createdAt)
        if (after === -1) ordered.push(row)
        else ordered.splice(after, 0, row)
    }
    return ordered
}

export const siteSuggestionFake = {
    findMany: vi.fn(
        async (args: {
            where?: Record<string, unknown>
            orderBy?: { createdAt: 'asc' }
            take?: number
            select?: Record<string, true>
        }) => {
            let rows = table.filter(row => matchesWhere(row, args.where))
            if (args.orderBy) rows = orderedByCreatedAt(rows)
            if (typeof args.take === 'number') rows = rows.slice(0, args.take)
            return rows.map(row => project(row, args.select))
        },
    ),
    updateMany: vi.fn(
        async (args: {
            where?: Record<string, unknown>
            data: Partial<FakeSuggestionRow>
        }) => {
            let count = 0
            for (const row of table) {
                if (!matchesWhere(row, args.where)) continue
                Object.assign(row, args.data)
                count += 1
            }
            return { count }
        },
    ),
    updateManyAndReturn: vi.fn(
        async (args: {
            where?: Record<string, unknown>
            data: Partial<FakeSuggestionRow>
            select?: Record<string, true>
        }) => {
            const updated: Record<string, unknown>[] = []
            for (const row of table) {
                if (!matchesWhere(row, args.where)) continue
                Object.assign(row, args.data)
                updated.push(project(row, args.select))
            }
            return updated
        },
    ),
    create: vi.fn(
        async (args: {
            data: Partial<FakeSuggestionRow>
            select?: Record<string, true>
        }) => {
            const row = makeRow(`created-${table.length}`, args.data)
            table.push(row)
            return project(row, args.select)
        },
    ),
}

export const prismaFake = { siteSuggestion: siteSuggestionFake }

/** A row with every column present — a partial row would let a test pass
 * against a filter that reads a column the real table always has. */
export function makeRow(
    id: string,
    overrides: Partial<FakeSuggestionRow> = {},
): FakeSuggestionRow {
    return {
        id,
        domain: `${id}.example.com`,
        rawUrl: `https://www.${id}.example.com/`,
        userId: null,
        requesterEmail: null,
        source: 'web',
        userAgent: 'ua',
        status: 'new',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        importedAt: null,
        statusChangedAt: null,
        notifiedAt: null,
        ...overrides,
    }
}

export function seedRow(
    id: string,
    overrides: Partial<FakeSuggestionRow> = {},
): FakeSuggestionRow {
    const row = makeRow(id, overrides)
    table.push(row)
    return row
}

export function resetTable(): void {
    table.length = 0
    siteSuggestionFake.findMany.mockClear()
    siteSuggestionFake.updateMany.mockClear()
    siteSuggestionFake.updateManyAndReturn.mockClear()
    siteSuggestionFake.create.mockClear()
}
