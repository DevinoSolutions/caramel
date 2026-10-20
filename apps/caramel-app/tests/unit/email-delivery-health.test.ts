import {
    checkEmailDeliveryHealth,
    collectEmailLogWindow,
    extractEmailDomain,
    formatEmailDeliveryHealthLine,
    summariseEmailDeliveryWindow,
    toEmailLogEntry,
    type EmailLogEntry,
} from '@/lib/emailDeliveryHealth'
import { describe, expect, it } from 'vitest'

// The gap this module closes: the provider can 2xx-ACCEPT a send (Sendly
// answers 202 PENDING) and later mark it BOUNCED / FAILED / REJECTED, or leave
// it in PENDING/SENDING forever. sendEmail() returns success in every one of
// those cases, so the app's only loud path (auth.ts's captureException on a
// throw) never fires. (On the previous provider, useSend, grabcaramel.com
// carried 55 BOUNCED + 2 FAILED rows that reached no Sentry issue.)
//
// What is pinned here:
//   * the classification table (which statuses are failures vs delayed vs
//     stuck) — the whole verdict, testable with no network and no clock;
//   * the PII boundary: the list rows carry `subject` (and possibly `to`), and
//     NONE of them may survive into an entry, a report or a log line;
//   * the window + cursor walk (stop at the window edge, cap at maxPages, mark
//     truncation) so a busy hour can't turn the check into a log crawl;
//   * never-throws: a 500, a bad key or a shape change is a REPORT with
//     status 'error', not an exception inside a boot-time interval.
//
// MOCK ANNOUNCEMENT: `sendly-sdk` is the REAL SDK here. Only the network is
// faked, via the SDK's own `fetch` injection point (fakeSendlyFetch below).

const KEY = 'sk_test_fake_key_for_unit_tests'
const FROM = 'Caramel <no_reply@grabcaramel.com>'

interface RawRowOverrides {
    id?: string
    createdAt?: string
    status?: string
    from?: string
    complainedAt?: string | null
}

/** A realistic Sendly list row — PII-bearing fields included, as the API sends. */
function rawRow(overrides: RawRowOverrides = {}) {
    return {
        id: overrides.id ?? 'row_1',
        to: 'shopper@example.com',
        from: overrides.from ?? FROM,
        subject: 'Verify your email for Caramel',
        status: overrides.status ?? 'DELIVERED',
        createdAt: overrides.createdAt ?? '2026-09-16T12:30:00.000Z',
        updatedAt: '2026-09-16T12:30:01.000Z',
        sentAt: '2026-09-16T12:30:01.000Z',
        deliveredAt: null,
        bouncedAt: null,
        openedAt: null,
        clickedAt: null,
        complainedAt: overrides.complainedAt ?? null,
        opens: 0,
        clicks: 0,
        tags: [],
        projectId: 'proj_1',
    }
}

function entry(overrides: Partial<EmailLogEntry> = {}): EmailLogEntry {
    return {
        id: 'row_1',
        createdAt: '2026-09-16T12:30:00.000Z',
        latestStatus: 'DELIVERED',
        fromDomain: 'grabcaramel.com',
        complained: false,
        ...overrides,
    }
}

interface FakeSendlyOptions {
    /** Pages of rows, newest-first, in the order the API would return them. */
    pages: ReturnType<typeof rawRow>[][]
    listStatus?: number
}

/**
 * MOCK: a fake `fetch` standing in for api.sendly.now. It answers
 * `GET /api/emails` with the legacy `{ success, data, nextCursor }` envelope,
 * paging by an opaque `cursor` ("p2", "p3", …) exactly as the real list does.
 */
function fakeSendlyFetch(options: FakeSendlyOptions) {
    const calls: URL[] = []
    const auth: string[] = []
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        calls.push(url)
        auth.push(new Headers(init?.headers).get('authorization') ?? '')
        if (options.listStatus && options.listStatus !== 200) {
            return new Response(
                JSON.stringify({
                    success: false,
                    error: {
                        message: 'shopper@example.com could not be reached',
                        code: 'internal_error',
                    },
                }),
                {
                    status: options.listStatus,
                    headers: { 'content-type': 'application/json' },
                },
            )
        }
        const cursor = url.searchParams.get('cursor')
        const page = cursor ? Number(cursor.slice(1)) : 1
        const rows = options.pages[page - 1] ?? []
        const hasNext = page < options.pages.length
        return Response.json({
            success: true,
            data: rows,
            nextCursor: hasNext ? `p${page + 1}` : null,
        })
    }) as unknown as typeof fetch
    return { impl, calls, auth }
}

describe('extractEmailDomain', () => {
    it('reads the domain out of a display-name address, a bare address, and rejects junk', () => {
        expect(extractEmailDomain(FROM)).toBe('grabcaramel.com')
        expect(extractEmailDomain('no_reply@GrabCaramel.com')).toBe(
            'grabcaramel.com',
        )
        expect(extractEmailDomain('not-an-address')).toBeNull()
        expect(extractEmailDomain('trailing@')).toBeNull()
    })
})

describe('toEmailLogEntry', () => {
    it('keeps only id/createdAt/status/sender domain/complained — every PII field is dropped', () => {
        const parsed = toEmailLogEntry(rawRow())
        expect(parsed).toEqual({
            id: 'row_1',
            createdAt: '2026-09-16T12:30:00.000Z',
            latestStatus: 'DELIVERED',
            fromDomain: 'grabcaramel.com',
            complained: false,
        })
        const keys = Object.keys(parsed ?? {})
        expect(keys).not.toContain('to')
        expect(keys).not.toContain('subject')
        expect(keys).not.toContain('from')
    })

    it('marks a row with complainedAt set as complained', () => {
        expect(
            toEmailLogEntry(
                rawRow({ complainedAt: '2026-09-16T12:31:00.000Z' }),
            )?.complained,
        ).toBe(true)
    })

    it('returns null for a row missing the fields the summary needs', () => {
        expect(toEmailLogEntry(null)).toBeNull()
        expect(toEmailLogEntry('a string')).toBeNull()
        expect(toEmailLogEntry({ id: 1 })).toBeNull()
        expect(toEmailLogEntry({ id: 'x', createdAt: 'y' })).toBeNull()
    })

    it('tolerates a missing from rather than dropping the row', () => {
        const row: Record<string, unknown> = { ...rawRow() }
        delete row.from
        expect(toEmailLogEntry(row)?.fromDomain).toBeNull()
    })
})

describe('summariseEmailDeliveryWindow', () => {
    const now = new Date('2026-09-16T13:00:00.000Z')
    const stuckAfterMs = 30 * 60_000

    it('counts every terminal failure status, and a spam complaint, as a failure', () => {
        const summary = summariseEmailDeliveryWindow(
            [
                entry({ id: 'a', latestStatus: 'FAILED' }),
                entry({ id: 'b', latestStatus: 'BOUNCED' }),
                entry({ id: 'd', latestStatus: 'REJECTED' }),
                entry({ id: 'e', latestStatus: 'RENDERING_FAILURE' }),
                // Delivered, then the recipient hit "report spam".
                entry({ id: 'f', latestStatus: 'DELIVERED', complained: true }),
            ],
            { now, stuckAfterMs },
        )
        expect(summary.failed).toBe(5)
        expect(summary.delayed).toBe(0)
        expect(summary.stuckPending).toBe(0)
        expect(summary.scanned).toBe(5)
    })

    it('does not count a delivered send, and counts a delayed one separately', () => {
        const summary = summariseEmailDeliveryWindow(
            [
                entry({ id: 'a', latestStatus: 'DELIVERED' }),
                entry({ id: 'b', latestStatus: 'CANCELLED' }),
                entry({ id: 'c', latestStatus: 'DELIVERY_DELAY' }),
            ],
            { now, stuckAfterMs },
        )
        expect(summary.failed).toBe(0)
        expect(summary.delayed).toBe(1)
        expect(summary.byStatus).toEqual({
            DELIVERED: 1,
            CANCELLED: 1,
            DELIVERY_DELAY: 1,
        })
    })

    it('counts an accepted-but-unresolved send as stuck only once it is old enough', () => {
        const summary = summariseEmailDeliveryWindow(
            [
                // 45 min old and still PENDING → the silent-loss case.
                entry({
                    id: 'old',
                    latestStatus: 'PENDING',
                    createdAt: '2026-09-16T12:15:00.000Z',
                }),
                // 5 min old and still SENT → normal, the provider is working.
                entry({
                    id: 'fresh',
                    latestStatus: 'SENT',
                    createdAt: '2026-09-16T12:55:00.000Z',
                }),
            ],
            { now, stuckAfterMs },
        )
        expect(summary.stuckPending).toBe(1)
        expect(summary.failed).toBe(0)
    })
})

describe('checkEmailDeliveryHealth', () => {
    const now = new Date('2026-09-16T13:00:00.000Z')

    it('skips — without touching the network — when Sendly is not configured', async () => {
        const { impl, calls } = fakeSendlyFetch({ pages: [[]] })
        const report = await checkEmailDeliveryHealth({
            apiKey: '',
            fetchImpl: impl,
            now,
        })
        expect(report.status).toBe('skipped')
        expect(report.reason).toContain('SENDLY_API_KEY')
        expect(calls).toHaveLength(0)
    })

    it('reports ok for a clean window, sends the key as a bearer, and never carries a recipient or subject', async () => {
        const { impl, calls, auth } = fakeSendlyFetch({
            pages: [
                [
                    rawRow({ id: '1', createdAt: '2026-09-16T12:40:00.000Z' }),
                    rawRow({ id: '2', createdAt: '2026-09-16T12:10:00.000Z' }),
                ],
            ],
        })
        const report = await checkEmailDeliveryHealth({
            apiKey: KEY,
            fromEmail: FROM,
            fetchImpl: impl,
            now,
        })
        expect(report.status).toBe('ok')
        expect(report.scanned).toBe(2)
        expect(report.senderDomain).toBe('grabcaramel.com')
        expect(calls[0]!.pathname).toBe('/api/emails')
        expect(auth[0]).toBe(`Bearer ${KEY}`)
        const serialised = JSON.stringify(report)
        expect(serialised).not.toContain('shopper@example.com')
        expect(serialised).not.toContain('Verify your email')
        expect(formatEmailDeliveryHealthLine(report)).not.toContain('shopper@')
    })

    it('reports degraded when the window contains a bounce', async () => {
        const { impl } = fakeSendlyFetch({
            pages: [
                [
                    rawRow({ id: '1', status: 'BOUNCED' }),
                    rawRow({ id: '2', status: 'DELIVERED' }),
                ],
            ],
        })
        const report = await checkEmailDeliveryHealth({
            apiKey: KEY,
            fromEmail: FROM,
            fetchImpl: impl,
            now,
        })
        expect(report.status).toBe('degraded')
        expect(report.failed).toBe(1)
        expect(report.byStatus).toEqual({ BOUNCED: 1, DELIVERED: 1 })
    })

    it('reports degraded when a send is stuck unresolved, even with zero failures', async () => {
        const { impl } = fakeSendlyFetch({
            pages: [
                [
                    rawRow({
                        id: '1',
                        status: 'PENDING',
                        createdAt: '2026-09-16T12:05:00.000Z',
                    }),
                ],
            ],
        })
        const report = await checkEmailDeliveryHealth({
            apiKey: KEY,
            fromEmail: FROM,
            fetchImpl: impl,
            now,
        })
        expect(report.status).toBe('degraded')
        expect(report.failed).toBe(0)
        expect(report.stuckPending).toBe(1)
    })

    it('ignores rows outside the window and rows from another sending domain', async () => {
        const { impl } = fakeSendlyFetch({
            pages: [
                [
                    rawRow({ id: 'in', createdAt: '2026-09-16T12:30:00.000Z' }),
                    // Another app on the same Sendly project — not our mail.
                    rawRow({
                        id: 'other-domain',
                        from: 'App <hello@somewhere-else.com>',
                        status: 'BOUNCED',
                        createdAt: '2026-09-16T12:31:00.000Z',
                    }),
                    // Older than the 60-minute window.
                    rawRow({
                        id: 'old',
                        status: 'FAILED',
                        createdAt: '2026-09-16T10:00:00.000Z',
                    }),
                ],
            ],
        })
        const report = await checkEmailDeliveryHealth({
            apiKey: KEY,
            fromEmail: FROM,
            fetchImpl: impl,
            now,
        })
        expect(report.status).toBe('ok')
        expect(report.scanned).toBe(1)
        expect(report.failed).toBe(0)
    })

    it('returns an error report — not a throw — when Sendly refuses, naming the status', async () => {
        const { impl } = fakeSendlyFetch({ pages: [[]], listStatus: 500 })
        const report = await checkEmailDeliveryHealth({
            apiKey: KEY,
            fromEmail: FROM,
            fetchImpl: impl,
            now,
        })
        expect(report.status).toBe('error')
        expect(report.reason).toBeTruthy()
    })

    it('returns an error report when the transport itself throws', async () => {
        const impl = (async () => {
            throw new Error('ECONNREFUSED')
        }) as unknown as typeof fetch
        const report = await checkEmailDeliveryHealth({
            apiKey: KEY,
            fetchImpl: impl,
            now,
        })
        expect(report.status).toBe('error')
        expect(report.reason).toContain('ECONNREFUSED')
    })
})

describe('collectEmailLogWindow pagination', () => {
    const windowEnd = new Date('2026-09-16T13:00:00.000Z')
    const windowStart = new Date('2026-09-16T12:00:00.000Z')

    it('stops paging as soon as a row predates the window', async () => {
        const { impl, calls } = fakeSendlyFetch({
            pages: [
                [
                    rawRow({ id: '1', createdAt: '2026-09-16T12:50:00.000Z' }),
                    rawRow({ id: '2', createdAt: '2026-09-16T11:00:00.000Z' }),
                ],
                [rawRow({ id: '3', createdAt: '2026-09-16T10:00:00.000Z' })],
            ],
        })
        const result = await collectEmailLogWindow(
            { apiKey: KEY, pageSize: 2, fetchImpl: impl },
            { windowStart, windowEnd, senderDomain: null },
        )
        expect(result.entries.map(e => e.id)).toEqual(['1'])
        expect(result.pagesFetched).toBe(1)
        expect(result.truncated).toBe(false)
        expect(calls).toHaveLength(1)
    })

    it('follows nextCursor to the next page while rows are still inside the window', async () => {
        const { impl, calls } = fakeSendlyFetch({
            pages: [
                [rawRow({ id: '1', createdAt: '2026-09-16T12:50:00.000Z' })],
                [rawRow({ id: '2', createdAt: '2026-09-16T12:40:00.000Z' })],
            ],
        })
        const result = await collectEmailLogWindow(
            { apiKey: KEY, pageSize: 1, fetchImpl: impl },
            { windowStart, windowEnd, senderDomain: null },
        )
        expect(result.entries.map(e => e.id)).toEqual(['1', '2'])
        expect(result.pagesFetched).toBe(2)
        // The list ended (nextCursor null) before the window did → not truncated.
        expect(result.truncated).toBe(false)
        expect(calls[1]!.searchParams.get('cursor')).toBe('p2')
    })

    it('never asks Sendly for more than 50 rows a page', async () => {
        const { impl, calls } = fakeSendlyFetch({ pages: [[]] })
        await collectEmailLogWindow(
            { apiKey: KEY, pageSize: 500, fetchImpl: impl },
            { windowStart, windowEnd, senderDomain: null },
        )
        expect(calls[0]!.searchParams.get('limit')).toBe('50')
    })

    it('marks the result truncated when the page budget runs out mid-window', async () => {
        const fullPage = (page: number) => [
            rawRow({ id: `${page}a`, createdAt: '2026-09-16T12:50:00.000Z' }),
            rawRow({ id: `${page}b`, createdAt: '2026-09-16T12:49:00.000Z' }),
        ]
        const { impl } = fakeSendlyFetch({
            pages: [fullPage(1), fullPage(2), fullPage(3)],
        })
        const result = await collectEmailLogWindow(
            { apiKey: KEY, pageSize: 2, maxPages: 2, fetchImpl: impl },
            { windowStart, windowEnd, senderDomain: null },
        )
        expect(result.pagesFetched).toBe(2)
        expect(result.truncated).toBe(true)
        expect(result.entries).toHaveLength(4)
    })
})
