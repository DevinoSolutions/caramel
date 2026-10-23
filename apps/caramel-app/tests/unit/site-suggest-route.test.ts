import { POST } from '@/app/api/sites/suggest/route'
import {
    SUGGESTION_OPS_MAILS_PER_DAY_BUDGET,
    SUGGESTION_ROWS_PER_DAY_CAP,
} from '@/lib/siteSuggestionIntake'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Unit pins for POST /api/sites/suggest now that a suggestion is PERSISTED with
// the requester's identity, not merely mailed. House style (coupons-report /
// support-route tests): mock the DB the row lives in (@/lib/prisma), the
// better-auth session, the mail wire call and Sentry; stub only the rate-limit
// round-trip and keep isOriginAllowed real (a no-Origin request passes).
//
// ANNOUNCED FAKE: `siteSuggestion.create` appends to an in-memory table so
// every pin reads back exactly what the route wrote — the requester fields, the
// normalized domain, the source — rather than asserting a call happened.
const { prismaMock, suggestionRows, intakeState } = vi.hoisted(() => {
    interface SuggestionRow {
        id: string
        domain: string
        rawUrl: string
        userId: string | null
        requesterEmail: string | null
        source: string
        userAgent: string | null
    }
    const rows: SuggestionRow[] = []
    // Rows "created in the last 24h" by OTHER callers, on top of `rows` (the
    // route's global budgets count the table, not just this test's inserts).
    const state = { otherRecentRows: 0 }
    return {
        suggestionRows: rows,
        intakeState: state,
        prismaMock: {
            siteSuggestion: {
                findFirst: vi.fn(
                    async (args: {
                        where: {
                            domain: string
                            requesterEmail: string | null
                            userId?: string | null
                        }
                    }) => {
                        const hit = rows.find(
                            row =>
                                row.domain === args.where.domain &&
                                row.requesterEmail ===
                                    args.where.requesterEmail &&
                                (!('userId' in args.where) ||
                                    row.userId === args.where.userId),
                        )
                        return hit ? { id: hit.id } : null
                    },
                ),
                count: vi.fn(
                    async () => rows.length + state.otherRecentRows,
                ),
                create: vi.fn(
                    async (args: {
                        data: Omit<SuggestionRow, 'id'>
                        select: { id: true }
                    }) => {
                        const row = {
                            id: `suggestion-${rows.length + 1}`,
                            ...args.data,
                        }
                        rows.push(row)
                        return { id: row.id }
                    },
                ),
            },
        },
    }
})
vi.mock('@/lib/prisma', () => ({ default: prismaMock }))

const { getSessionMock } = vi.hoisted(() => ({
    getSessionMock: vi.fn(
        async (_opts: { headers: Headers }) => null as unknown,
    ),
}))
vi.mock('@/lib/auth/auth', () => ({
    auth: { api: { getSession: getSessionMock } },
}))

const { sendEmailMock } = vi.hoisted(() => ({
    sendEmailMock: vi.fn(async (_payload: Record<string, unknown>) => {}),
}))
vi.mock('@/lib/email', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    sendEmail: sendEmailMock,
}))

const { captureExceptionMock, captureMessageMock, setUserMock } = vi.hoisted(() => ({
    captureExceptionMock: vi.fn(
        (_error: unknown, _context?: Record<string, unknown>) => 'evt_test',
    ),
    // The ops-mail budget crossing is reported once with captureMessage.
    captureMessageMock: vi.fn(
        (_message: string, _context?: Record<string, unknown>) => 'evt_msg',
    ),
    // `withRoute` calls Sentry.setUser on every request since the stable-user-id
    // work; a mock without it throws "No setUser export is defined".
    setUserMock: vi.fn((_user: unknown) => undefined),
}))
vi.mock('@sentry/nextjs', () => ({
    captureException: captureExceptionMock,
    captureMessage: captureMessageMock,
    setUser: setUserMock,
}))

vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

function suggestRequest(body: unknown, headers: Record<string, string> = {}) {
    return new NextRequest('http://localhost/api/sites/suggest', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'user-agent': 'vitest-ua/1.0',
            ...headers,
        },
        body: JSON.stringify(body),
    })
}

function signedInAs(userId: string, email: string) {
    getSessionMock.mockImplementation(async () => ({
        session: { id: `session-${userId}` },
        user: { id: userId, email },
    }))
}

/** The plain-text body of the ONE ops email the route sent. */
function sentEmailText(): string {
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const payload = sendEmailMock.mock.calls[0]![0]
    return String(payload.text)
}

beforeEach(() => {
    suggestionRows.length = 0
    intakeState.otherRecentRows = 0
    captureMessageMock.mockClear()
    prismaMock.siteSuggestion.create.mockClear()
    getSessionMock.mockReset()
    getSessionMock.mockResolvedValue(null)
    sendEmailMock.mockReset()
    sendEmailMock.mockResolvedValue(undefined)
    captureExceptionMock.mockClear()
})

describe('POST /api/sites/suggest — persistence + requester identity', () => {
    it('anonymous, url only → 200 {ok,id,notified:true}; row persisted with NO requester, source web, the user agent', async () => {
        const res = await POST(
            suggestRequest({ url: 'https://www.Example-Store.com/sale' }),
        )
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            ok: true,
            id: 'suggestion-1',
            notified: true,
        })
        expect(suggestionRows).toEqual([
            {
                id: 'suggestion-1',
                domain: 'example-store.com',
                rawUrl: 'https://www.Example-Store.com/sale',
                userId: null,
                requesterEmail: null,
                source: 'web',
                userAgent: 'vitest-ua/1.0',
            },
        ])
    })

    it('the ops email keeps its first line VERBATIM (the manual import mines it) and names the requester as anonymous', async () => {
        await POST(suggestRequest({ url: 'https://example-store.com' }))
        const text = sentEmailText()
        const payload = sendEmailMock.mock.calls[0]![0]
        expect(payload.to).toBe('aladdin@devino.ca')
        expect(payload.subject).toBe('Caramel Site Suggestion')
        expect(text.split('\n')[0]).toBe(
            'A user suggested a new site: https://example-store.com',
        )
        expect(text).toContain('Domain: example-store.com')
        expect(text).toContain('Requested by: anonymous')
        expect(text).toContain('Source: web')
        expect(text).toContain('Suggestion id: suggestion-1')
    })

    it('anonymous with a body email → the email is recorded and named in the ops mail', async () => {
        const res = await POST(
            suggestRequest({
                url: 'example-store.com',
                email: 'shopper@example.com',
            }),
        )
        expect(res.status).toBe(200)
        expect(suggestionRows[0]).toMatchObject({
            domain: 'example-store.com',
            userId: null,
            requesterEmail: 'shopper@example.com',
        })
        expect(sentEmailText()).toContain('Requested by: shopper@example.com')
    })

    it('signed in → user id + SESSION email are recorded; a body email is ignored (client identity is never trusted)', async () => {
        signedInAs('user-7', 'member@example.com')
        const res = await POST(
            suggestRequest({
                url: 'https://example-store.com',
                email: 'someone-else@example.com',
            }),
        )
        expect(res.status).toBe(200)
        expect(suggestionRows[0]).toMatchObject({
            userId: 'user-7',
            requesterEmail: 'member@example.com',
        })
        expect(sentEmailText()).toContain(
            'Requested by: member@example.com (user user-7)',
        )
    })

    it('the domain is the bare host: lowercased, www. stripped, path dropped, subdomain KEPT', async () => {
        await POST(suggestRequest({ url: 'HTTPS://WWW.Shop.Example.CO.UK/x' }))
        expect(suggestionRows[0]!.domain).toBe('shop.example.co.uk')
    })

    it('source "extension" is accepted and recorded (reserved for a future extension caller)', async () => {
        await POST(
            suggestRequest({ url: 'example-store.com', source: 'extension' }),
        )
        expect(suggestionRows[0]!.source).toBe('extension')
        expect(sentEmailText()).toContain('Source: extension')
    })

    it.each([
        ['a bare public suffix', 'co.uk'],
        ['localhost', 'http://localhost:3000'],
        ['not a hostname', 'not a url at all'],
    ])(
        '%s → 400, nothing persisted, no email (the pipeline cannot act on it)',
        async (_label, url) => {
            const res = await POST(suggestRequest({ url }))
            expect(res.status).toBe(400)
            expect(suggestionRows).toEqual([])
            expect(sendEmailMock).not.toHaveBeenCalled()
        },
    )

    it('a malformed email → 422 before anything is written', async () => {
        const res = await POST(
            suggestRequest({ url: 'example-store.com', email: 'nope' }),
        )
        expect(res.status).toBe(422)
        expect(suggestionRows).toEqual([])
        expect(sendEmailMock).not.toHaveBeenCalled()
    })

    it('missing url → 422 (unchanged from F-007)', async () => {
        const res = await POST(suggestRequest({}))
        expect(res.status).toBe(422)
        expect(suggestionRows).toEqual([])
    })

    it('the row is the system of record: a failed ops email is reported to Sentry, the suggestion is still saved, the caller sees notified:false', async () => {
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        sendEmailMock.mockRejectedValueOnce(new Error('sendly down'))
        const res = await POST(
            suggestRequest({
                url: 'example-store.com',
                email: 'shopper@example.com',
            }),
        )
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            ok: true,
            id: 'suggestion-1',
            notified: false,
        })
        expect(suggestionRows).toHaveLength(1)
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
        const [error, context] = captureExceptionMock.mock.calls[0]!
        expect((error as Error).message).toBe('sendly down')
        expect(context).toMatchObject({
            tags: { operation: 'site_suggestion_email' },
            extra: { suggestionId: 'suggestion-1' },
        })
        // A trace that does not depend on Sentry being reachable.
        expect(consoleError).toHaveBeenCalledWith(
            '[sites/suggest] ops email failed for suggestion suggestion-1 (example-store.com):',
            error,
        )
        consoleError.mockRestore()
    })
})

describe('POST /api/sites/suggest — anonymous-intake hardening (T-6224)', () => {
    it.each([
        ['a line feed', 'https://store.com/a\nDomain: evil.com'],
        ['a carriage return', 'https://store.com/a\rRequested by: x'],
        ['a tab', 'https://store.com/a\tb'],
        ['a NUL', 'https://store.com/a\u0000b'],
        ['a Unicode line separator', 'https://store.com/a\u2028b'],
    ])(
        'a url containing %s → 422, nothing written, no mail (the forged-line injection)',
        async (_label, url) => {
            const res = await POST(suggestRequest({ url }))
            expect(res.status).toBe(422)
            expect(suggestionRows).toEqual([])
            expect(sendEmailMock).not.toHaveBeenCalled()
        },
    )

    it('an email containing a line feed → 422, nothing written, no mail', async () => {
        const res = await POST(
            suggestRequest({
                url: 'example-store.com',
                email: 'a@example.com\nBcc: victim@example.com',
            }),
        )
        expect(res.status).toBe(422)
        expect(suggestionRows).toEqual([])
        expect(sendEmailMock).not.toHaveBeenCalled()
    })

    it('a trailing newline the form can paste is trimmed, not refused, and cannot add a mail line', async () => {
        const res = await POST(
            suggestRequest({ url: 'https://example-store.com/sale\n' }),
        )
        expect(res.status).toBe(200)
        expect(suggestionRows[0]!.rawUrl).toBe('https://example-store.com/sale')
        expect(sentEmailText().split('\n')).toHaveLength(5)
    })

    it('the same anonymous visitor asking for the same store twice → ONE row and ONE mail; the repeat is answered ok with duplicate:true', async () => {
        const first = await POST(suggestRequest({ url: 'example-store.com' }))
        const again = await POST(
            suggestRequest({ url: 'https://www.example-store.com/other' }),
        )
        expect(await first.json()).toEqual({
            ok: true,
            id: 'suggestion-1',
            notified: true,
        })
        expect(again.status).toBe(200)
        expect(await again.json()).toEqual({
            ok: true,
            id: 'suggestion-1',
            notified: false,
            duplicate: true,
        })
        expect(suggestionRows).toHaveLength(1)
        expect(sendEmailMock).toHaveBeenCalledTimes(1)
    })

    it('the same email asking again is a duplicate regardless of case; a DIFFERENT email for the same store is a new suggestion (it wants its own notice)', async () => {
        await POST(
            suggestRequest({
                url: 'example-store.com',
                email: 'Shopper@Example.com',
            }),
        )
        const repeat = await POST(
            suggestRequest({
                url: 'example-store.com',
                email: 'shopper@example.com',
            }),
        )
        expect((await repeat.json()).duplicate).toBe(true)
        const other = await POST(
            suggestRequest({
                url: 'example-store.com',
                email: 'someone-else@example.com',
            }),
        )
        expect((await other.json()).duplicate).toBeUndefined()
        expect(suggestionRows).toHaveLength(2)
    })

    it('a different store is never a duplicate', async () => {
        await POST(suggestRequest({ url: 'example-store.com' }))
        await POST(suggestRequest({ url: 'other-store.com' }))
        expect(suggestionRows.map(r => r.domain)).toEqual([
            'example-store.com',
            'other-store.com',
        ])
    })

    it('the dedupe lookup only looks 24 hours back', async () => {
        await POST(suggestRequest({ url: 'example-store.com' }))
        const where = prismaMock.siteSuggestion.findFirst.mock.calls[0]![0]
            .where as unknown as { createdAt: { gte: Date } }
        const ageMs = Date.now() - where.createdAt.gte.getTime()
        expect(ageMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5000)
        expect(ageMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000)
    })

    it('at the global daily ops-mail budget the row is STILL saved but no mail is sent, and Sentry hears about the crossing once', async () => {
        intakeState.otherRecentRows = SUGGESTION_OPS_MAILS_PER_DAY_BUDGET
        const res = await POST(suggestRequest({ url: 'example-store.com' }))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            ok: true,
            id: 'suggestion-1',
            notified: false,
        })
        expect(suggestionRows).toHaveLength(1)
        expect(sendEmailMock).not.toHaveBeenCalled()
        expect(captureMessageMock).toHaveBeenCalledTimes(1)

        // The next request is past the line, not on it: still no mail, no
        // second event.
        await POST(suggestRequest({ url: 'other-store.com' }))
        expect(sendEmailMock).not.toHaveBeenCalled()
        expect(captureMessageMock).toHaveBeenCalledTimes(1)
    })

    it('one below the mail budget still mails', async () => {
        intakeState.otherRecentRows = SUGGESTION_OPS_MAILS_PER_DAY_BUDGET - 1
        await POST(suggestRequest({ url: 'example-store.com' }))
        expect(sendEmailMock).toHaveBeenCalledTimes(1)
        expect(captureMessageMock).not.toHaveBeenCalled()
    })

    it('at the global daily row cap → 429 with Retry-After, nothing written, no mail', async () => {
        intakeState.otherRecentRows = SUGGESTION_ROWS_PER_DAY_CAP
        const res = await POST(suggestRequest({ url: 'example-store.com' }))
        expect(res.status).toBe(429)
        expect(res.headers.get('retry-after')).toBe('3600')
        expect(typeof (await res.json()).error).toBe('string')
        expect(suggestionRows).toEqual([])
        expect(sendEmailMock).not.toHaveBeenCalled()
    })
})
