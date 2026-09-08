import { POST as ackPOST } from '@/app/api/ingest/site-suggestions/ack/route'
import { POST as notifyPOST } from '@/app/api/ingest/site-suggestions/notify/route'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    resetTable,
    seedRow,
    siteSuggestionFake,
    table,
} from './support/siteSuggestionsPrismaFake'

// The answer half of a site suggestion: marking a request `rejected` /
// `unsupported` / `supported`, and — only for `supported` — telling the person
// who asked.
//
// The product rule these pin: NOTHING mails a requester on its own. The ack is
// driven by an automated pipeline, so with SITE_SUGGESTIONS_AUTO_NOTIFY off (the
// default) a `supported` ack only MARKS the rows and reports how many people are
// waiting; the send is an explicit act (POST .../notify). The switch decides
// whether the ACK may send, never whether the owner may.
//
// The other rule is that a closed suggestion can never be re-opened: a re-drain
// of stale ids would otherwise drag every already-answered store back to
// `imported`, and would send `supported` rows round the loop to re-notify their
// requesters.
//
// The in-memory `site_suggestions` table is an ANNOUNCED FAKE that really
// evaluates the where/select the lib sends — see support/siteSuggestionsPrismaFake.ts.
// Postgres-only facts (the migration, the FK, the indexes) live in
// tests/integration/site-suggestions.itest.ts.

const { envMock } = vi.hoisted(() => ({
    envMock: {
        INGEST_API_KEY: undefined as string | undefined,
        SITE_SUGGESTIONS_AUTO_NOTIFY: 'false' as 'true' | 'false',
    },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

const { sendEmailMock } = vi.hoisted(() => ({
    sendEmailMock: vi.fn(async (_payload: Record<string, unknown>) => {}),
}))
vi.mock('@/lib/email', async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    sendEmail: sendEmailMock,
}))

vi.mock('@/lib/prisma', async () => {
    const fake = await import('./support/siteSuggestionsPrismaFake')
    return { default: fake.prismaFake }
})

const INGEST_KEY = 'test-ingest-key-lifecycle'
const bearer = { authorization: `Bearer ${INGEST_KEY}` }

function post(path: string, body: unknown, headers: Record<string, string>) {
    return new NextRequest(
        `http://localhost/api/ingest/site-suggestions${path}`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
        },
    )
}

const ack = (body: unknown, headers: Record<string, string> = bearer) =>
    ackPOST(post('/ack', body, headers))
const notify = (body: unknown, headers: Record<string, string> = bearer) =>
    notifyPOST(post('/notify', body, headers))

/** Mail actually addressed to a requester (the ops notice goes to the operator
 * inbox and is asserted separately). */
function requesterMails() {
    return sendEmailMock.mock.calls
        .map(call => call[0] as Record<string, unknown>)
        .filter(payload => payload.to !== 'aladdin@devino.ca')
}

function opsMails() {
    return sendEmailMock.mock.calls
        .map(call => call[0] as Record<string, unknown>)
        .filter(payload => payload.to === 'aladdin@devino.ca')
}

function row(id: string) {
    return table.find(r => r.id === id)!
}

beforeEach(() => {
    envMock.INGEST_API_KEY = INGEST_KEY
    envMock.SITE_SUGGESTIONS_AUTO_NOTIFY = 'false'
    sendEmailMock.mockClear()
    sendEmailMock.mockImplementation(async () => {})
    resetTable()
})

describe('ack — the status machine', () => {
    it('an ids-only body still means `imported`, and still flips ONLY `new` rows (the shipped caramel-coupons caller)', async () => {
        seedRow('a')
        seedRow('b', { status: 'imported' })
        const res = await ack({ ids: ['a', 'b'] })
        expect(res.status).toBe(200)
        const payload = await res.json()
        expect(payload.status).toBe('imported')
        expect(payload.acknowledged).toBe(1)
        expect(payload.changed).toEqual(['a'])
        expect(payload.refused).toEqual([
            { id: 'b', from: 'imported', reason: 'already' },
        ])
        expect(row('a').status).toBe('imported')
        expect(row('a').importedAt).toBeInstanceOf(Date)
        expect(row('a').statusChangedAt).toBeInstanceOf(Date)
    })

    it('`rejected` and `unsupported` close a request and stamp statusChangedAt, never importedAt', async () => {
        seedRow('junk')
        seedRow('hopeless', { status: 'imported' })
        await ack({ ids: ['junk'], status: 'rejected' })
        await ack({ ids: ['hopeless'], status: 'unsupported' })
        expect(row('junk').status).toBe('rejected')
        expect(row('hopeless').status).toBe('unsupported')
        for (const id of ['junk', 'hopeless']) {
            expect(row(id).statusChangedAt).toBeInstanceOf(Date)
            // importedAt dates the pipeline's FIRST hand-over. A later answer
            // must not rewrite it, and must not invent one where there was none.
            expect(row(id).importedAt).toBeNull()
        }
    })

    it('a closed row can NEVER be dragged back to `imported` — the PAIR: refused backwards, but a terminal-to-terminal answer is allowed', async () => {
        seedRow('live', { status: 'supported' })
        seedRow('dead', { status: 'unsupported' })
        seedRow('junk', { status: 'rejected' })

        const backwards = await ack({
            ids: ['live', 'dead', 'junk'],
            status: 'imported',
        })
        const refusedPayload = await backwards.json()
        expect(refusedPayload.changed).toEqual([])
        expect(refusedPayload.acknowledged).toBe(0)
        expect(refusedPayload.refused).toEqual([
            { id: 'live', from: 'supported', reason: 'backwards' },
            { id: 'dead', from: 'unsupported', reason: 'backwards' },
            { id: 'junk', from: 'rejected', reason: 'backwards' },
        ])
        expect(row('live').status).toBe('supported')

        // Same rows, a terminal target: a store we could not support becoming
        // supported (and a supported store dying) is the ordinary operator path.
        const forwards = await ack({ ids: ['dead'], status: 'supported' })
        expect((await forwards.json()).changed).toEqual(['dead'])
        expect(row('dead').status).toBe('supported')
    })

    it('an unknown id is reported `not_found`, never counted as acknowledged', async () => {
        const res = await ack({ ids: ['ghost'], status: 'supported' })
        const payload = await res.json()
        expect(payload.acknowledged).toBe(0)
        expect(payload.refused).toEqual([
            { id: 'ghost', from: null, reason: 'not_found' },
        ])
    })

    it('an unknown status is 422 and nothing is written', async () => {
        seedRow('a')
        const res = await ack({ ids: ['a'], status: 'archived' })
        expect(res.status).toBe(422)
        expect(siteSuggestionFake.updateManyAndReturn).not.toHaveBeenCalled()
        expect(row('a').status).toBe('new')
    })

    it('no bearer → 401, nothing written', async () => {
        seedRow('a')
        const res = await ack({ ids: ['a'], status: 'supported' }, {})
        expect(res.status).toBe(401)
        expect(row('a').status).toBe('new')
    })
})

describe('ack — `supported` with SITE_SUGGESTIONS_AUTO_NOTIFY off (the default)', () => {
    it('MARKS the rows, mails NO requester, and reports the pending count', async () => {
        seedRow('r1', {
            domain: 'worldofbooks.com',
            requesterEmail: 'shopper@example.com',
        })
        seedRow('r2', {
            domain: 'worldofbooks.com',
            requesterEmail: 'other@example.com',
        })
        const res = await ack({ ids: ['r1', 'r2'], status: 'supported' })
        const payload = await res.json()

        expect(payload.notified).toEqual({ sent: 0, pending: 2, failed: 0 })
        expect(requesterMails()).toEqual([])
        expect(row('r1').notifiedAt).toBeNull()
        expect(row('r2').notifiedAt).toBeNull()
    })

    it('a supported row with NO requester email is never pending — there is nobody to tell', async () => {
        seedRow('anon', { domain: 'worldofbooks.com' })
        const payload = await (
            await ack({ ids: ['anon'], status: 'supported' })
        ).json()
        expect(payload.notified).toEqual({ sent: 0, pending: 0, failed: 0 })
    })

    it('sends ONE ops notice naming the domains, the counts, and the exact command with the pending ids in it', async () => {
        seedRow('r1', {
            domain: 'worldofbooks.com',
            requesterEmail: 'shopper@example.com',
        })
        seedRow('r2', { domain: 'peepers.com', requesterEmail: null })
        const payload = await (
            await ack({ ids: ['r1', 'r2'], status: 'supported' })
        ).json()
        expect(payload.opsNotified).toBe(true)

        const ops = opsMails()
        expect(ops).toHaveLength(1)
        const text = ops[0]!.text as string
        expect(text).toContain('worldofbooks.com')
        expect(text).toContain('peepers.com')
        expect(text).toContain('Requesters with an email: 1')
        expect(text).toContain('Auto-notified now: 0')
        expect(text).toContain('Awaiting your decision: 1')
        // The operator must not have to look an id up to act on this.
        expect(text).toContain('/api/ingest/site-suggestions/notify')
        expect(text).toContain('{"ids":["r1"]}')
        expect(text).not.toContain('"r2"')
    })

    it('an ops-notice failure NEVER fails the ack — the transitions are the system of record', async () => {
        seedRow('r1', { requesterEmail: 'shopper@example.com' })
        sendEmailMock.mockRejectedValueOnce(new Error('usesend down'))
        const res = await ack({ ids: ['r1'], status: 'supported' })
        expect(res.status).toBe(200)
        const payload = await res.json()
        expect(payload.changed).toEqual(['r1'])
        expect(payload.opsNotified).toBe(false)
        expect(row('r1').status).toBe('supported')
    })

    it('a non-supported transition sends no mail at all', async () => {
        seedRow('a', { requesterEmail: 'shopper@example.com' })
        const payload = await (
            await ack({ ids: ['a'], status: 'unsupported' })
        ).json()
        expect(payload.opsNotified).toBeNull()
        expect(sendEmailMock).not.toHaveBeenCalled()
    })
})

describe('ack — `supported` with SITE_SUGGESTIONS_AUTO_NOTIFY on', () => {
    beforeEach(() => {
        envMock.SITE_SUGGESTIONS_AUTO_NOTIFY = 'true'
    })

    it('mails each requester once, stamps notifiedAt, and reports nothing pending', async () => {
        seedRow('r1', {
            domain: 'worldofbooks.com',
            requesterEmail: 'shopper@example.com',
        })
        seedRow('r2', {
            domain: 'peepers.com',
            requesterEmail: 'other@example.com',
        })
        const payload = await (
            await ack({ ids: ['r1', 'r2'], status: 'supported' })
        ).json()

        expect(payload.notified).toEqual({ sent: 2, pending: 0, failed: 0 })
        expect(new Set(requesterMails().map(m => m.to))).toEqual(
            new Set(['shopper@example.com', 'other@example.com']),
        )
        expect(row('r1').notifiedAt).toBeInstanceOf(Date)
        expect(row('r2').notifiedAt).toBeInstanceOf(Date)
    })

    it('a requester send failure leaves the row PENDING, reports it, and the ops notice still names the id to retry', async () => {
        seedRow('r1', {
            domain: 'worldofbooks.com',
            requesterEmail: 'shopper@example.com',
        })
        // First call is the requester notice; the ops notice that follows works.
        sendEmailMock.mockRejectedValueOnce(new Error('usesend down'))
        const payload = await (
            await ack({ ids: ['r1'], status: 'supported' })
        ).json()

        expect(payload.notified).toEqual({ sent: 0, pending: 1, failed: 1 })
        // The claim is RELEASED. A row that says the person was told when
        // nobody told them would bury the notice forever.
        expect(row('r1').notifiedAt).toBeNull()
        const text = opsMails()[0]!.text as string
        expect(text).toContain('Send FAILED')
        expect(text).toContain('{"ids":["r1"]}')
    })

    it('an accidental `SITE_SUGGESTIONS_AUTO_NOTIFY` value the env schema would reject is not read as ON here either', async () => {
        // env.ts fail-fasts at boot on anything but 'true'/'false'; this pins
        // that the read is an equality against 'true', never a truthiness test
        // that would treat 'no' or '0' as permission to mail a stranger.
        envMock.SITE_SUGGESTIONS_AUTO_NOTIFY = 'no' as 'true' | 'false'
        seedRow('r1', { requesterEmail: 'shopper@example.com' })
        const payload = await (
            await ack({ ids: ['r1'], status: 'supported' })
        ).json()
        expect(payload.notified.sent).toBe(0)
        expect(requesterMails()).toEqual([])
    })
})

describe('POST /notify — the owner’s explicit send', () => {
    it('no bearer → 401, nothing mailed', async () => {
        seedRow('r1', {
            status: 'supported',
            requesterEmail: 'shopper@example.com',
        })
        const res = await notify({ ids: ['r1'] }, {})
        expect(res.status).toBe(401)
        expect(sendEmailMock).not.toHaveBeenCalled()
    })

    it('sends for an eligible id with the switch still OFF — the switch gates the ACK, not the owner', async () => {
        expect(envMock.SITE_SUGGESTIONS_AUTO_NOTIFY).toBe('false')
        seedRow('r1', {
            status: 'supported',
            domain: 'worldofbooks.com',
            requesterEmail: 'shopper@example.com',
        })
        const payload = await (await notify({ ids: ['r1'] })).json()
        expect(payload.sent).toBe(1)
        expect(payload.results).toEqual([{ id: 'r1', outcome: 'sent' }])
        expect(row('r1').notifiedAt).toBeInstanceOf(Date)
    })

    it('is idempotent: a second call re-sends NOTHING and reports already_notified', async () => {
        seedRow('r1', {
            status: 'supported',
            requesterEmail: 'shopper@example.com',
        })
        await notify({ ids: ['r1'] })
        const stampedAt = row('r1').notifiedAt
        sendEmailMock.mockClear()

        const payload = await (await notify({ ids: ['r1'] })).json()
        expect(payload).toMatchObject({
            sent: 0,
            alreadyNotified: 1,
            results: [{ id: 'r1', outcome: 'already_notified' }],
        })
        expect(sendEmailMock).not.toHaveBeenCalled()
        expect(row('r1').notifiedAt).toEqual(stampedAt)
    })

    it('refuses the ineligible with a NAMED reason rather than skipping them silently', async () => {
        seedRow('pending-import', { status: 'imported' })
        seedRow('closed', { status: 'unsupported' })
        seedRow('anon', { status: 'supported', requesterEmail: null })
        const payload = await (
            await notify({ ids: ['pending-import', 'closed', 'anon', 'ghost'] })
        ).json()

        expect(payload.sent).toBe(0)
        expect(payload.notEligible).toBe(4)
        expect(payload.results).toEqual([
            {
                id: 'pending-import',
                outcome: 'not_eligible',
                reason: 'status_is_imported',
            },
            {
                id: 'closed',
                outcome: 'not_eligible',
                reason: 'status_is_unsupported',
            },
            { id: 'anon', outcome: 'not_eligible', reason: 'no_email' },
            { id: 'ghost', outcome: 'not_eligible', reason: 'not_found' },
        ])
        expect(sendEmailMock).not.toHaveBeenCalled()
    })

    it('ONE mail per requester email per domain — duplicate suggestions are stamped alongside the row that was mailed', async () => {
        seedRow('first', {
            status: 'supported',
            domain: 'worldofbooks.com',
            requesterEmail: 'shopper@example.com',
        })
        seedRow('again', {
            status: 'supported',
            domain: 'worldofbooks.com',
            requesterEmail: 'shopper@example.com',
        })
        const payload = await (await notify({ ids: ['first', 'again'] })).json()

        expect(requesterMails()).toHaveLength(1)
        expect(payload.sent).toBe(2)
        expect(row('first').notifiedAt).toBeInstanceOf(Date)
        expect(row('again').notifiedAt).toBeInstanceOf(Date)
    })

    it('the one-mail rule folds email case and survives ACROSS calls', async () => {
        seedRow('first', {
            status: 'supported',
            domain: 'worldofbooks.com',
            requesterEmail: 'Shopper@Example.com',
        })
        await notify({ ids: ['first'] })
        const toldAt = row('first').notifiedAt
        sendEmailMock.mockClear()

        // The same person, same store, months later, lower-cased.
        seedRow('later', {
            status: 'supported',
            domain: 'worldofbooks.com',
            requesterEmail: 'shopper@example.com',
        })
        const payload = await (await notify({ ids: ['later'] })).json()

        expect(sendEmailMock).not.toHaveBeenCalled()
        expect(payload.results).toEqual([
            { id: 'later', outcome: 'already_notified' },
        ])
        // Stamped with the instant they were ACTUALLY told, not with now.
        expect(row('later').notifiedAt).toEqual(toldAt)
    })

    it('a different person, or the same person about a different store, still gets their mail', async () => {
        seedRow('mine', {
            status: 'supported',
            domain: 'worldofbooks.com',
            requesterEmail: 'shopper@example.com',
            notifiedAt: new Date('2026-09-02T00:00:00.000Z'),
        })
        seedRow('theirs', {
            status: 'supported',
            domain: 'worldofbooks.com',
            requesterEmail: 'someone-else@example.com',
        })
        seedRow('other-store', {
            status: 'supported',
            domain: 'peepers.com',
            requesterEmail: 'shopper@example.com',
        })
        const payload = await (
            await notify({ ids: ['theirs', 'other-store'] })
        ).json()

        expect(payload.sent).toBe(2)
        expect(new Set(requesterMails().map(m => m.to))).toEqual(
            new Set(['shopper@example.com', 'someone-else@example.com']),
        )
    })

    it('a failed send releases the claim so the SAME command can retry it', async () => {
        seedRow('r1', {
            status: 'supported',
            requesterEmail: 'shopper@example.com',
        })
        sendEmailMock.mockRejectedValueOnce(new Error('usesend down'))
        const failed = await (await notify({ ids: ['r1'] })).json()
        expect(failed).toMatchObject({
            sent: 0,
            failed: 1,
            results: [{ id: 'r1', outcome: 'failed', reason: 'send_failed' }],
        })
        expect(row('r1').notifiedAt).toBeNull()

        const retried = await (await notify({ ids: ['r1'] })).json()
        expect(retried.sent).toBe(1)
        expect(row('r1').notifiedAt).toBeInstanceOf(Date)
    })

    it('an empty or missing ids list → 422', async () => {
        expect((await notify({ ids: [] })).status).toBe(422)
        expect((await notify({})).status).toBe(422)
        expect(sendEmailMock).not.toHaveBeenCalled()
    })
})

describe('the notice a requester actually reads', () => {
    it('names the store in the subject and carries the SAME store link in both body parts', async () => {
        seedRow('r1', {
            status: 'supported',
            domain: 'worldofbooks.com',
            requesterEmail: 'shopper@example.com',
        })
        await notify({ ids: ['r1'] })

        const mail = requesterMails()[0]!
        expect(mail.subject).toBe(
            'worldofbooks.com is now supported in Caramel',
        )
        const text = mail.text as string
        const html = mail.html as string
        // Both parts always: a client that drops the HTML must still read it.
        expect(text.length).toBeGreaterThan(0)
        expect(html).toContain('<')
        const link = 'https://grabcaramel.com/coupons/worldofbooks.com'
        expect(text).toContain('worldofbooks.com')
        expect(text).toContain(link)
        expect(html).toContain('worldofbooks.com')
        expect(html).toContain(link)
    })
})
