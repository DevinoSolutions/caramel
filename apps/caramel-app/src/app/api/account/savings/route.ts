import { withRoute } from '@/lib/api/withRoute'
import prisma from '@/lib/prisma'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// POST /api/account/savings — the extension's opt-in cloud savings sync.
//
// The extension records every measured win to device storage first and pushes
// here afterwards, in batches, only when BOTH the device's `syncSavings`
// setting and the account's `savings_sync_enabled` column are on. `auth:
// 'session'` rather than 'optional': a savings event with no owner is not a
// degraded record, it is a meaningless one — there is nowhere to put it and
// nobody to show it to. Rate-limited + origin-gated like every other mutation;
// no CORS/OPTIONS export for the same reason coupons/[id]/report has none —
// the MV3 service worker fetches with host_permissions and never preflights.
//
// ── BATCH SEMANTICS (decided, do not re-litigate) ────────────────────────────
// TWO layers, because they answer two different questions.
//
// 1. The ENVELOPE is all-or-nothing (422, whole batch refused). A body that is
//    not `{ events: [...] }`, an empty array, or one over SAVINGS_BATCH_MAX is
//    a broken client, not a bad row — the extension builds these batches
//    itself. Silently truncating an oversized batch would drop events the
//    caller believed it had handed over, which is exactly the failure this
//    endpoint exists to prevent.
//
// 2. Individual EVENTS are per-item. One malformed row must not cost the nine
//    good rows beside it — the client's only recovery from a 422 would be to
//    retry the same doomed batch forever, or drop all ten.
//
// Per-item does NOT mean per-item-silent. Every submitted clientEventId comes
// back in exactly one of `stored` or `rejected`, and `rejected` carries the
// reason. The client is never left to infer what happened to a row.
//
// The status code describes the REQUEST, not the rows: a well-formed batch is
// 200 even when every row in it was rejected. The rows' fates are the body.
//
// ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
// `clientEventId` is a client-generated UUID stamped once, at the moment the
// saving is recorded on the device, and reused unchanged for every retry. It
// is UNIQUE in the table, so a replayed batch — a lost response, a popup
// catch-up sweep racing the recording-moment push, two devices flushing the
// same roamed queue — writes nothing the second time and still reports those
// ids as stored.
const SAVINGS_BATCH_MAX = 100

// $100,000 in cents. Not a policy on how much a coupon may save — a tripwire
// for a price parser that read "1.299,00" as 129900 or a currency as cents.
// A saving above this is a bug report, not a saving, and banking it would
// corrupt a lifetime total the user is asked to trust.
const AMOUNT_CENTS_MAX = 10_000_000

// occurredAt is client-reported wall-clock, so it is checked against a window
// rather than trusted. Forward: a device clock may legitimately run a few
// minutes fast, but an event "happening" tomorrow would sort above every real
// one forever. Backward: `t: entry.t || Date.now()` upstream means a corrupted
// timestamp degrades to 0 (epoch), and 1970 in a savings list is noise, not
// history.
const CLOCK_SKEW_MS = 5 * 60 * 1000
const OCCURRED_AT_FLOOR_MS = Date.UTC(2020, 0, 1)

const BatchEnvelopeSchema = z.object({
    events: z.array(z.unknown()).min(1).max(SAVINGS_BATCH_MAX),
})

const SavingsEventSchema = z
    .object({
        clientEventId: z.string().trim().min(1).max(64),
        // Denormalized: the store/code/amount are the human-readable record and
        // must survive the catalog row being expired or re-ingested.
        store: z.string().trim().min(1).max(255),
        // Empty is legitimate — an automatic discount saves money with no code.
        code: z.string().trim().max(128).optional().default(''),
        // The catalog coupon this win came from, when the apply flow knew it.
        couponId: z.string().trim().min(1).max(128).nullable().optional(),
        amountCents: z.number().int().positive().max(AMOUNT_CENTS_MAX),
        currency: z
            .string()
            .trim()
            .regex(/^[A-Za-z]{3}$/),
        occurredAt: z.string().trim().min(1),
    })
    .superRefine((value, ctx) => {
        const ms = Date.parse(value.occurredAt)
        if (!Number.isFinite(ms)) {
            ctx.addIssue({
                code: 'custom',
                path: ['occurredAt'],
                message: 'is not a parseable timestamp',
            })
            return
        }
        if (ms > Date.now() + CLOCK_SKEW_MS) {
            ctx.addIssue({
                code: 'custom',
                path: ['occurredAt'],
                message: 'is in the future',
            })
        }
        if (ms < OCCURRED_AT_FLOOR_MS) {
            ctx.addIssue({
                code: 'custom',
                path: ['occurredAt'],
                message: 'is implausibly old',
            })
        }
    })

interface RejectedEvent {
    /** Position in the submitted array — the only handle a caller has on a row
     * whose clientEventId failed to parse. */
    index: number
    clientEventId: string | null
    reason: string
}

interface PreparedEvent {
    userId: string
    couponId: string | null
    store: string
    code: string
    amountCents: number
    currency: string
    occurredAt: Date
    clientEventId: string
}

/** The clientEventId of a row that failed validation, when it is readable at
 * all — so a client can mark THAT entry rejected instead of guessing by index. */
function readClientEventId(raw: unknown): string | null {
    if (typeof raw !== 'object' || raw === null) return null
    const value = (raw as { clientEventId?: unknown }).clientEventId
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'account/savings',
        rateLimit: 'mutation',
        origin: true,
        auth: 'session',
        body: BatchEnvelopeSchema,
    },
    async ({ body, session }) => {
        if (!session?.user) {
            // withRoute's auth gate already 401s a missing session; this guard
            // covers the malformed-session edge (and narrows the type).
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const userId = session.user.id

        const candidates: PreparedEvent[] = []
        const rejected: RejectedEvent[] = []
        // A batch that repeats an id is not an error — the id still ends up
        // stored, from its first occurrence — but it must not reach createMany
        // twice. Deduping here rather than leaning on ON CONFLICT keeps the
        // behavior ours and testable instead of a Postgres implementation
        // detail.
        const seenInBatch = new Set<string>()

        body.events.forEach((raw, index) => {
            const parsed = SavingsEventSchema.safeParse(raw)
            if (!parsed.success) {
                const issue = parsed.error.issues[0]
                const field = issue?.path.join('.') || 'event'
                rejected.push({
                    index,
                    clientEventId: readClientEventId(raw),
                    reason: `${field}: ${issue?.message ?? 'is invalid'}`,
                })
                return
            }
            const event = parsed.data
            if (seenInBatch.has(event.clientEventId)) return
            seenInBatch.add(event.clientEventId)
            candidates.push({
                userId,
                couponId: event.couponId ?? null,
                store: event.store,
                code: event.code,
                amountCents: event.amountCents,
                // Uppercased at the boundary so 'usd' and 'USD' never become two
                // currency groups on the profile page's per-currency totals.
                currency: event.currency.toUpperCase(),
                occurredAt: new Date(event.occurredAt),
                clientEventId: event.clientEventId,
            })
        })

        const storedIds = candidates.map(candidate => candidate.clientEventId)
        if (!storedIds.length) {
            return NextResponse.json({
                accepted: 0,
                duplicates: 0,
                stored: [],
                rejected,
            })
        }

        // savings_events.coupon_id is a real FK onto the catalog `coupons`
        // table, and the extension reports whatever id the apply flow held —
        // which can name a row that has since been expired out of the catalog,
        // or one this deployment has not ingested yet. Inserting it would raise
        // a foreign-key violation that fails the ENTIRE createMany, losing
        // every good event in the batch over a broken link. So unknown ids are
        // dropped to null: store/code/amount are denormalized precisely so the
        // saving survives the catalog row not existing. Nothing user-visible is
        // lost, so this is not a per-item rejection.
        const referencedCouponIds = Array.from(
            new Set(
                candidates
                    .map(candidate => candidate.couponId)
                    .filter((id): id is string => Boolean(id)),
            ),
        )
        if (referencedCouponIds.length) {
            const known = new Set(
                (
                    await prisma.coupon.findMany({
                        where: { id: { in: referencedCouponIds } },
                        select: { id: true },
                    })
                ).map(row => row.id),
            )
            for (const candidate of candidates) {
                if (candidate.couponId && !known.has(candidate.couponId)) {
                    candidate.couponId = null
                }
            }
        }

        // Deliberately NOT scoped by userId: client_event_id is globally
        // unique, so a row belonging to anyone at all blocks the insert. Asking
        // the question the constraint actually asks is what keeps `accepted`
        // and `duplicates` honest.
        const alreadyStored = new Set(
            (
                await prisma.savingsEvent.findMany({
                    where: { clientEventId: { in: storedIds } },
                    select: { clientEventId: true },
                })
            ).map(row => row.clientEventId),
        )
        const toInsert = candidates.filter(
            candidate => !alreadyStored.has(candidate.clientEventId),
        )

        // skipDuplicates still matters with the SELECT above: two concurrent
        // flushes of the same queue both read "not stored" and both insert. The
        // loser silently writes nothing instead of 500ing, and its ids are
        // still reported stored — because they are.
        const { count } = toInsert.length
            ? await prisma.savingsEvent.createMany({
                  data: toInsert,
                  skipDuplicates: true,
              })
            : { count: 0 }

        return NextResponse.json({
            accepted: count,
            duplicates: storedIds.length - count,
            // Every id here is in the table now — freshly inserted, already
            // there, or written by the request that beat us. The client marks
            // exactly these synced and never has to infer the complement of
            // `rejected`.
            stored: storedIds,
            rejected,
        })
    },
)
