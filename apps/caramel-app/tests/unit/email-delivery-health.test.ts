import {
    checkEmailDeliveryHealth,
    collectEmailLogWindow,
    extractEmailDomain,
    formatEmailDeliveryHealthLine,
    resolveEmailDomainId,
    summariseEmailDeliveryWindow,
    toEmailLogEntry,
    type EmailLogEntry,
} from '@/lib/emailDeliveryHealth'
import { describe, expect, it } from 'vitest'

// The gap this module closes: useSend can 2xx-ACCEPT a send and later mark it
// BOUNCED / FAILED / SUPPRESSED, or leave it in QUEUED forever. sendEmail()
// returns success in every one of those cases, so the app's only loud path
// (auth.ts's captureException on a throw) never fires. grabcaramel.com carries
// 55 BOUNCED + 2 FAILED rows in useSend's log that reached no Sentry issue.
//
// What is pinned here:
//   * the classification table (which statuses are failures vs delayed vs
//     stuck) — the whole verdict, testable with no network and no clock;
//   * the PII boundary: the send log carries `to`, `subject`, `html`, `text`,
//     and NONE of them may survive into an entry, a report or a log line;
//   * the window + pagination walk (stop at the window edge, cap at maxPages,
//     mark truncation) so a busy hour can't turn the check into a log crawl;
//   * never-throws: a 500, a bad key or a shape change is a REPORT with
//     status 'error', not an exception inside a boot-time interval.

const BASE = 'https://usesend.example.com'
const KEY = 'us_test_key'
const FROM = 'Caramel <no_reply@grabcaramel.com>'

interface RawRowOverrides {
    id?: string
    createdAt?: string
    latestStatus?: string
    domainId?: number
}

/** A realistic useSend row — PII fields included, exactly as the API sends. */
function rawRow(overrides: RawRowOverrides = {}) {
    return {
        id: overrides.id ?? 'cm_row_1',
        to: ['shopper@example.com'],
        replyTo: [],
        cc: [],
        bcc: [],
        from: FROM,
        subject: 'Verify your email for Caramel',
        html: '<p>secret link</p>',
        text: 'secret link',
        createdAt: overrides.createdAt ?? '2026-09-16T12:30:00.000Z',
        updatedAt: '2026-09-16T12:30:01.000Z',
        latestStatus: overrides.latestStatus ?? 'DELIVERED',
        scheduledAt: null,
        domainId: overrides.domainId ?? 14,
    }
}

function entry(overrides: RawRowOverrides = {}): EmailLogEntry {
    const row = rawRow(overrides)
    return {
        id: row.id,
        createdAt: row.createdAt,
        latestStatus: row.latestStatus,
        domainId: row.domainId,
    }
}

interface FakeApiOptions {
    /** Pages of rows, newest-first, in the order the API would return them. */
    pages: ReturnType<typeof rawRow>[][]
    domains?: unknown
    emailsStatus?: number
    domainsStatus?: number
}

function fakeFetch(options: FakeApiOptions) {
    const calls: string[] = []
    const impl = (async (input: string | URL | Request) => {
        const url = String(input)
        calls.push(url)
        if (url.includes('/domains')) {
            if (options.domainsStatus && options.domainsStatus !== 200) {
                return new Response('nope', { status: options.domainsStatus })
            }
            return Response.json(
                options.domains ?? [{ id: 14, name: 'grabcaramel.com' }],
            )
        }
        if (options.emailsStatus && options.emailsStatus !== 200) {
            return new Response(
                'shopper@example.com could not be reached', // body must never leak
                { status: options.emailsStatus },
            )
        }
        const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1')
        const rows = options.pages[page - 1] ?? []
        return Response.json({ data: rows, count: 999 })
    }) as unknown as typeof fetch
    return { impl, calls }
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
    it('keeps only id/createdAt/latestStatus/domainId — every PII field is dropped', () => {
        const parsed = toEmailLogEntry(rawRow())
        expect(parsed).toEqual({
            id: 'cm_row_1',
            createdAt: '2026-09-16T12:30:00.000Z',
            latestStatus: 'DELIVERED',
            domainId: 14,
        })
        expect(Object.keys(parsed ?? {})).not.toContain('to')
        expect(Object.keys(parsed ?? {})).not.toContain('subject')
        expect(Object.keys(parsed ?? {})).not.toContain('html')
        expect(Object.keys(parsed ?? {})).not.toContain('text')
    })

    it('returns null for a row missing the fields the summary needs', () => {
        expect(toEmailLogEntry(null)).toBeNull()
        expect(toEmailLogEntry('a string')).toBeNull()
        expect(toEmailLogEntry({ id: 1 })).toBeNull()
        expect(toEmailLogEntry({ id: 'x', createdAt: 'y' })).toBeNull()
    })

    it('tolerates a missing domainId rather than dropping the row', () => {
        const row: Record<string, unknown> = { ...rawRow() }
        delete row.domainId
        expect(toEmailLogEntry(row)?.domainId).toBeNull()
    })
})

describe('summariseEmailDeliveryWindow', () => {
    const now = new Date('2026-09-16T13:00:00.000Z')
    const stuckAfterMs = 30 * 60_000

    it('counts every terminal failure status as a failure', () => {
        const summary = summariseEmailDeliveryWindow(
            [
                entry({ id: 'a', latestStatus: 'FAILED' }),
                entry({ id: 'b', latestStatus: 'BOUNCED' }),
                entry({ id: 'c', latestStatus: 'COMPLAINED' }),
                entry({ id: 'd', latestStatus: 'REJECTED' }),
                entry({ id: 'e', latestStatus: 'RENDERING_FAILURE' }),
                entry({ id: 'f', latestStatus: 'SUPPRESSED' }),
            ],
            { now, stuckAfterMs },
        )
        expect(summary.failed).toBe(6)
        expect(summary.delayed).toBe(0)
        expect(summary.stuckPending).toBe(0)
        expect(summary.scanned).toBe(6)
    })

    it('does not count a delivered send, and counts a delayed one separately', () => {
        const summary = summariseEmailDeliveryWindow(
            [
                entry({ id: 'a', latestStatus: 'DELIVERED' }),
                entry({ id: 'b', latestStatus: 'OPENED' }),
                entry({ id: 'c', latestStatus: 'DELIVERY_DELAYED' }),
            ],
            { now, stuckAfterMs },
        )
        expect(summary.failed).toBe(0)
        expect(summary.delayed).toBe(1)
        expect(summary.byStatus).toEqual({
            DELIVERED: 1,
            OPENED: 1,
            DELIVERY_DELAYED: 1,
        })
    })

    it('counts an accepted-but-unresolved send as stuck only once it is old enough', () => {
        const summary = summariseEmailDeliveryWindow(
            [
                // 45 min old and still QUEUED → the silent-loss case.
                entry({
                    id: 'old',
                    latestStatus: 'QUEUED',
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

    it('skips — without touching the network — when useSend is not configured', async () => {
        const { impl, calls } = fakeFetch({ pages: [[]] })
        const report = await checkEmailDeliveryHealth({
            baseUrl: BASE,
            apiKey: '',
            fetchImpl: impl,
            now,
        })
        expect(report.status).toBe('skipped')
        expect(report.reason).toContain('USESEND_API_KEY')
        expect(calls).toHaveLength(0)
    })

    it('reports ok for a clean window and never carries a recipient or subject', async () => {
        const { impl } = fakeFetch({
            pages: [
                [
                    rawRow({ id: '1', createdAt: '2026-09-16T12:40:00.000Z' }),
                    rawRow({ id: '2', createdAt: '2026-09-16T12:10:00.000Z' }),
                ],
            ],
        })
        const report = await checkEmailDeliveryHealth({
            baseUrl: BASE,
            apiKey: KEY,
            fromEmail: FROM,
            fetchImpl: impl,
            pageSize: 100,
            now,
        })
        expect(report.status).toBe('ok')
        expect(report.scanned).toBe(2)
        expect(report.domainId).toBe(14)
        const serialised = JSON.stringify(report)
        expect(serialised).not.toContain('shopper@example.com')
        expect(serialised).not.toContain('Verify your email')
        expect(formatEmailDeliveryHealthLine(report)).not.toContain('shopper@')
    })

    it('reports degraded when the window contains a bounce', async () => {
        const { impl } = fakeFetch({
            pages: [
                [
                    rawRow({ id: '1', latestStatus: 'BOUNCED' }),
                    rawRow({ id: '2', latestStatus: 'DELIVERED' }),
                ],
            ],
        })
        const report = await checkEmailDeliveryHealth({
            baseUrl: BASE,
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
        const { impl } = fakeFetch({
            pages: [
                [
                    rawRow({
                        id: '1',
                        latestStatus: 'QUEUED',
                        createdAt: '2026-09-16T12:05:00.000Z',
                    }),
                ],
            ],
        })
        const report = await checkEmailDeliveryHealth({
            baseUrl: BASE,
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
        const { impl } = fakeFetch({
            pages: [
                [
                    rawRow({ id: 'in', createdAt: '2026-09-16T12:30:00.000Z' }),
                    // Another app on the same useSend team — not our mail.
                    rawRow({
                        id: 'other-domain',
                        domainId: 99,
                        latestStatus: 'BOUNCED',
                        createdAt: '2026-09-16T12:31:00.000Z',
                    }),
                    // Older than the 60-minute window.
                    rawRow({
                        id: 'old',
                        latestStatus: 'FAILED',
                        createdAt: '2026-09-16T10:00:00.000Z',
                    }),
                ],
            ],
        })
        const report = await checkEmailDeliveryHealth({
            baseUrl: BASE,
            apiKey: KEY,
            fromEmail: FROM,
            fetchImpl: impl,
            now,
        })
        expect(report.status).toBe('ok')
        expect(report.scanned).toBe(1)
        expect(report.failed).toBe(0)
    })

    it('returns an error report — not a throw — when the provider refuses, and leaks no response body', async () => {
        const { impl } = fakeFetch({ pages: [[]], emailsStatus: 500 })
        const report = await checkEmailDeliveryHealth({
            baseUrl: BASE,
            apiKey: KEY,
            fromEmail: FROM,
            fetchImpl: impl,
            now,
        })
        expect(report.status).toBe('error')
        expect(report.reason).toContain('500')
        expect(report.reason).not.toContain('shopper@example.com')
    })

    it('returns an error report when the transport itself throws', async () => {
        const impl = (async () => {
            throw new Error('ECONNREFUSED')
        }) as unknown as typeof fetch
        const report = await checkEmailDeliveryHealth({
            baseUrl: BASE,
            apiKey: KEY,
            fetchImpl: impl,
            now,
        })
        expect(report.status).toBe('error')
        expect(report.reason).toBe('ECONNREFUSED')
    })
})

describe('collectEmailLogWindow pagination', () => {
    const windowEnd = new Date('2026-09-16T13:00:00.000Z')
    const windowStart = new Date('2026-09-16T12:00:00.000Z')

    it('stops paging as soon as a row predates the window', async () => {
        const { impl, calls } = fakeFetch({
            pages: [
                [
                    rawRow({ id: '1', createdAt: '2026-09-16T12:50:00.000Z' }),
                    rawRow({ id: '2', createdAt: '2026-09-16T11:00:00.000Z' }),
                ],
                [rawRow({ id: '3', createdAt: '2026-09-16T10:00:00.000Z' })],
            ],
        })
        const result = await collectEmailLogWindow(
            { baseUrl: BASE, apiKey: KEY, pageSize: 2 },
            { windowStart, windowEnd, domainId: null, fetchImpl: impl },
        )
        expect(result.entries.map(e => e.id)).toEqual(['1'])
        expect(result.pagesFetched).toBe(1)
        expect(result.truncated).toBe(false)
        expect(calls.filter(c => c.includes('/emails'))).toHaveLength(1)
    })

    it('never asks useSend for more than 50 rows a page (its zod cap; 51 is a 400)', async () => {
        const { impl, calls } = fakeFetch({ pages: [[]] })
        await collectEmailLogWindow(
            { baseUrl: BASE, apiKey: KEY, pageSize: 500 },
            { windowStart, windowEnd, domainId: null, fetchImpl: impl },
        )
        expect(calls[0]).toContain('limit=50')
        expect(calls[0]).not.toContain('limit=500')
    })

    it('marks the result truncated when the page budget runs out mid-window', async () => {
        const fullPage = (page: number) => [
            rawRow({ id: `${page}a`, createdAt: '2026-09-16T12:50:00.000Z' }),
            rawRow({ id: `${page}b`, createdAt: '2026-09-16T12:49:00.000Z' }),
        ]
        const { impl } = fakeFetch({ pages: [fullPage(1), fullPage(2)] })
        const result = await collectEmailLogWindow(
            { baseUrl: BASE, apiKey: KEY, pageSize: 2, maxPages: 2 },
            { windowStart, windowEnd, domainId: null, fetchImpl: impl },
        )
        expect(result.pagesFetched).toBe(2)
        expect(result.truncated).toBe(true)
        expect(result.entries).toHaveLength(4)
    })
})

describe('resolveEmailDomainId', () => {
    it('finds our sending domain and returns null when it is not on the account', async () => {
        const { impl } = fakeFetch({ pages: [[]] })
        await expect(
            resolveEmailDomainId(
                { baseUrl: BASE, apiKey: KEY, fromEmail: FROM },
                impl,
            ),
        ).resolves.toBe(14)

        const other = fakeFetch({
            pages: [[]],
            domains: [{ id: 3, name: 'somewhere-else.com' }],
        })
        await expect(
            resolveEmailDomainId(
                { baseUrl: BASE, apiKey: KEY, fromEmail: FROM },
                other.impl,
            ),
        ).resolves.toBeNull()
    })

    it('returns null without a call when no from-address is configured', async () => {
        const { impl, calls } = fakeFetch({ pages: [[]] })
        await expect(
            resolveEmailDomainId({ baseUrl: BASE, apiKey: KEY }, impl),
        ).resolves.toBeNull()
        expect(calls).toHaveLength(0)
    })
})
