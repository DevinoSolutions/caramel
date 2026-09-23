// src/lib/siteSuggestions.ts
//
// The ONE home for the `site_suggestions` table: how a "please support this
// store" request is normalized, recorded, read back by the coupons pipeline,
// and acknowledged. Routes call these; none of them touches the model
// directly, so the shape the pipeline sees (`SiteSuggestionWire`) and the
// vocabulary of `status` are declared exactly once.
//
// This is app-owned user/ops state, like coupon_reports and favorite_stores —
// NOT the coupon catalog (couponsRepo.ts owns that, with its own write rules).
import { env } from '@/lib/env'
import prisma from '@/lib/prisma'
import {
    sendStoreSupportedNotice,
    sendSupportedOpsNotice,
} from '@/lib/siteSuggestionNotices'
import { resolveStoreDomain } from '@/lib/storeDomain'
import type { Prisma } from '@prisma/client'
import * as Sentry from '@sentry/nextjs'
import { z } from 'zod'

// The lifecycle the app and the pipeline agree on. Kept as a const tuple (not a
// Prisma enum) so a later status is a one-line change here and a data change in
// the DB, never a migration.
//
//   new         captured, not yet handed to the pipeline
//   imported    the pipeline acknowledged it (POST .../ack) and is working on it
//   rejected    not a store host — nothing to support, closed
//   unsupported we tried and cannot support it, closed
//   supported   the store is live in the catalog — the one the requester cares
//               about, and the only one that can produce a notice
const SITE_SUGGESTION_STATUSES = [
    'new',
    'imported',
    'rejected',
    'unsupported',
    'supported',
] as const

export type SiteSuggestionStatus = (typeof SITE_SUGGESTION_STATUSES)[number]

/**
 * Statuses that CLOSE a suggestion: an operator (or the pipeline) has answered
 * it, so it must never fall back into the work queue. A transition into
 * `imported`/`new` from one of these is the "backwards" move the ack refuses —
 * without that rule a re-drain of stale ids would silently re-open every store
 * we had already decided about, and `supported` rows would go round again and
 * re-notify their requesters.
 *
 * Terminal-to-terminal IS allowed and is a real operator path: a store we
 * marked `unsupported` can later become `supported`, and a `supported` store
 * whose config dies can be marked `unsupported` again.
 */
const TERMINAL_STATUSES = new Set<SiteSuggestionStatus>([
    'rejected',
    'unsupported',
    'supported',
])

/** The statuses an ack may WRITE. `new` is absent on purpose: it is the state a
 * row is born in, never one anything transitions back to. */
const ACK_TARGET_STATUSES = [
    'imported',
    'rejected',
    'unsupported',
    'supported',
] as const

export type SiteSuggestionAckStatus = (typeof ACK_TARGET_STATUSES)[number]

/**
 * Which current statuses may move to `target`.
 *
 * `imported` accepts ONLY `new` — byte-for-byte the rule the pipeline has had
 * since PR #225 (an already-imported id counts 0, a closed row is refused), so
 * the existing `{ids}`-only caller behaves exactly as before.
 */
function allowedSourcesFor(
    target: SiteSuggestionAckStatus,
): SiteSuggestionStatus[] {
    if (target === 'imported') {
        // Only a status that is NOT terminal may be handed over. Derived from
        // TERMINAL_STATUSES rather than spelled `['new']`, so a fifth closing
        // status inherits the no-re-opening rule the day it is added instead of
        // silently becoming re-importable. Evaluates to ['new'] today.
        return SITE_SUGGESTION_STATUSES.filter(
            status => status !== 'imported' && !TERMINAL_STATUSES.has(status),
        )
    }
    // Any other current status may be answered, including another terminal one
    // — except the target itself, which is a no-op rather than a transition.
    return SITE_SUGGESTION_STATUSES.filter(status => status !== target)
}

/** Where a suggestion was submitted from. The extension has no suggest form
 * today; `extension` is reserved so a future caller needs no schema change. */
export const SiteSuggestionSourceSchema = z.enum(['web', 'extension'])

/**
 * Normalize what a person typed into the bare host the pipeline keys on:
 * lowercased hostname with a leading `www.` removed. Returns null when the
 * input does not name a real store — no registrable domain in front of the
 * public suffix (`co.uk`), an unknown TLD (`localhost`, `.test`), or garbage
 * that is not a hostname at all — reusing resolveStoreDomain's Public-Suffix
 * check so the same inputs the catalog refuses are refused here.
 *
 * The SUBDOMAIN is kept (`sell.worldofbooks.com` stays as typed, only `www.`
 * goes): the pipeline's own normalizer decides how far to fold, and folding
 * here would erase a distinction it may want.
 */
export function normalizeSuggestedDomain(rawUrl: string): string | null {
    const input = rawUrl.trim()
    let hostname: string
    try {
        hostname = new URL(
            /^https?:\/\//i.test(input) ? input : `https://${input}`,
        ).hostname.toLowerCase()
    } catch {
        return null
    }
    // The Public-Suffix check runs on the HOSTNAME (already lowercased and
    // scheme-free), not the raw input: resolveStoreDomain's own scheme sniff
    // is case-sensitive, so "HTTPS://…" typed by a shopper would otherwise be
    // refused as garbage.
    if (!resolveStoreDomain(hostname)) return null
    const bare = hostname.replace(/^www\./, '')
    return bare.length > 0 ? bare : null
}

export interface RecordSiteSuggestionInput {
    domain: string
    rawUrl: string
    /** From the resolved better-auth session — never from the client body. */
    userId: string | null
    /** The session's email when signed in, else the optional body email. */
    requesterEmail: string | null
    source: z.infer<typeof SiteSuggestionSourceSchema>
    userAgent: string | null
}

/** Persist one suggestion; returns the new row's id. */
export async function recordSiteSuggestion(
    input: RecordSiteSuggestionInput,
): Promise<{ id: string }> {
    const row = await prisma.siteSuggestion.create({
        data: {
            domain: input.domain,
            rawUrl: input.rawUrl,
            userId: input.userId,
            requesterEmail: input.requesterEmail,
            source: input.source,
            userAgent: input.userAgent,
        },
        select: { id: true },
    })
    return { id: row.id }
}

// ---------------------------------------------------------------------------
// Pipeline-facing contract (GET /api/ingest/site-suggestions + .../ack).
//
// The coupons repo consumes this shape verbatim; changing a key here is a
// cross-repo contract change and must be coordinated with that consumer.
// ---------------------------------------------------------------------------

export const SiteSuggestionListQuerySchema = z.object({
    status: z.enum(SITE_SUGGESTION_STATUSES).default('new'),
    // ISO 8601 — rows created at or after this instant.
    since: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
})

const SiteSuggestionIdsSchema = z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(1000)

export const SiteSuggestionAckBodySchema = z.object({
    ids: SiteSuggestionIdsSchema,
    // Absent means `imported` — the pipeline's original one-key body
    // (`{ids}`, PR #225 / caramel-coupons PR #126) keeps working untouched.
    status: z.enum(ACK_TARGET_STATUSES).default('imported'),
})

export const SiteSuggestionNotifyBodySchema = z.object({
    ids: SiteSuggestionIdsSchema,
})

/** The wire projection the pipeline receives — a subset of the row, camelCase,
 * timestamps as ISO strings. Nothing here is a Prisma type: the consumer must
 * never depend on this repo's ORM. */
interface SiteSuggestionWire {
    id: string
    domain: string
    rawUrl: string
    requesterEmail: string | null
    source: string
    createdAt: string
    status: string
}

const wireSelect = {
    id: true,
    domain: true,
    rawUrl: true,
    requesterEmail: true,
    source: true,
    createdAt: true,
    status: true,
} satisfies Prisma.SiteSuggestionSelect

/** Suggestions in `status`, oldest first (the pipeline drains in arrival order). */
export async function listSiteSuggestions(
    query: z.infer<typeof SiteSuggestionListQuerySchema>,
): Promise<SiteSuggestionWire[]> {
    const rows = await prisma.siteSuggestion.findMany({
        where: {
            status: query.status,
            ...(query.since
                ? { createdAt: { gte: new Date(query.since) } }
                : {}),
        },
        orderBy: { createdAt: 'asc' },
        take: query.limit,
        select: wireSelect,
    })
    return rows.map(row => ({
        id: row.id,
        domain: row.domain,
        rawUrl: row.rawUrl,
        requesterEmail: row.requesterEmail,
        source: row.source,
        createdAt: row.createdAt.toISOString(),
        status: row.status,
    }))
}

// ---------------------------------------------------------------------------
// Status transitions (POST /api/ingest/site-suggestions/ack).
// ---------------------------------------------------------------------------

/** Why an id did NOT move. Reported per id so the caller can tell "I sent a
 * stale list" (`already`/`backwards`) from "I sent a wrong id" (`not_found`). */
export type SiteSuggestionRefusalReason =
    | 'not_found'
    | 'already'
    | 'backwards'
    | 'raced'

export interface SiteSuggestionRefusal {
    id: string
    /** The status the row is actually in; null when there is no such row. */
    from: string | null
    reason: SiteSuggestionRefusalReason
}

export interface SiteSuggestionTransitionResult {
    status: SiteSuggestionAckStatus
    /** Ids that really moved into `status` on THIS call. */
    changed: string[]
    refused: SiteSuggestionRefusal[]
    /** Requester notices this call sent (auto-notify only; 0 when it is off). */
    notifiedSent: number
    /** `supported` rows with an email still awaiting the owner's decision. */
    notifiedPending: number
    /** Notices this call tried to send and could not. Those rows stay pending. */
    notifiedFailed: number
    /** Did the ops notice go out? Null when this transition sends none. */
    opsNotified: boolean | null
}

/** Is the machine allowed to mail a requester by itself? OFF by default - see
 * SITE_SUGGESTIONS_AUTO_NOTIFY in src/lib/env.ts. */
export function siteSuggestionAutoNotifyEnabled(): boolean {
    return env.SITE_SUGGESTIONS_AUTO_NOTIFY === 'true'
}

/**
 * Move the named suggestions into `status`.
 *
 * The write is ONE guarded `updateManyAndReturn`: the allowed-source list sits
 * in the WHERE clause, so the rule is enforced by the database rather than by
 * the read that preceded it, and a row someone else moved in between is
 * reported as `raced` instead of being counted as changed. The pre-read exists
 * only to tell the refusal reasons apart - a plain count could not say whether
 * an id was unknown, already there, or being dragged backwards.
 *
 * `supported` is the only transition that can produce mail; every other target
 * just stamps the row. Neither the requester notice nor the ops notice can fail
 * this call: the transitions are the system of record and are committed before
 * any mail is attempted, so a send failure is REPORTED (and the row left
 * pending) rather than turned into a 500 that would make the pipeline retry a
 * transition it has already completed.
 */
export async function transitionSiteSuggestions(
    ids: string[],
    status: SiteSuggestionAckStatus,
): Promise<SiteSuggestionTransitionResult> {
    const allowedSources = allowedSourcesFor(status)
    const existing = await prisma.siteSuggestion.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true },
    })
    const currentById = new Map(existing.map(row => [row.id, row.status]))

    const refused: SiteSuggestionRefusal[] = []
    const eligible: string[] = []
    for (const id of ids) {
        const current = currentById.get(id)
        if (current === undefined) {
            refused.push({ id, from: null, reason: 'not_found' })
        } else if (current === status) {
            refused.push({ id, from: current, reason: 'already' })
        } else if (!allowedSources.includes(current as SiteSuggestionStatus)) {
            // The only way to reach here is a CLOSED row aimed back at
            // `imported` - the backwards move the whole rule exists to stop.
            refused.push({ id, from: current, reason: 'backwards' })
        } else {
            eligible.push(id)
        }
    }

    const now = new Date()
    const moved =
        eligible.length === 0
            ? []
            : await prisma.siteSuggestion.updateManyAndReturn({
                  where: {
                      id: { in: eligible },
                      status: { in: allowedSources },
                  },
                  data: {
                      status,
                      statusChangedAt: now,
                      // importedAt is the LEGACY stamp for the first hand-over
                      // only; every other transition is dated by
                      // statusChangedAt, so a later ack cannot rewrite the day
                      // the pipeline first took the row.
                      ...(status === 'imported' ? { importedAt: now } : {}),
                  },
                  select: { id: true, domain: true, requesterEmail: true },
              })
    const movedIds = new Set(moved.map(row => row.id))
    for (const id of eligible) {
        if (!movedIds.has(id)) {
            refused.push({
                id,
                from: currentById.get(id) ?? null,
                reason: 'raced',
            })
        }
    }

    const result: SiteSuggestionTransitionResult = {
        status,
        changed: moved.map(row => row.id),
        refused,
        notifiedSent: 0,
        notifiedPending: 0,
        notifiedFailed: 0,
        opsNotified: null,
    }
    if (status !== 'supported' || moved.length === 0) return result

    const withEmail = moved.filter(row => Boolean(row.requesterEmail))
    if (siteSuggestionAutoNotifyEnabled()) {
        const notice = await notifySupportedRequesters(
            withEmail.map(row => row.id),
        )
        result.notifiedSent = notice.sent
        result.notifiedFailed = notice.failed
    }

    // Read the pending set back from the ROWS rather than deriving it from the
    // counters above: a failed send releases its claim, and a row someone else
    // notified in between is not waiting on us. This is the number the operator
    // acts on, so it is measured, not inferred.
    const pendingIds = await pendingNoticeIds(moved.map(row => row.id))
    result.notifiedPending = pendingIds.length

    const domains: string[] = []
    for (const row of moved) {
        if (!domains.includes(row.domain)) domains.push(row.domain)
    }
    try {
        await sendSupportedOpsNotice({
            domains,
            requesters: withEmail.length,
            autoNotified: result.notifiedSent,
            pending: pendingIds.length,
            pendingIds,
            failed: result.notifiedFailed,
        })
        result.opsNotified = true
    } catch (error) {
        // The rows ARE marked; only the operator's notification failed. Loud
        // (Sentry, with the ids) but never a 500.
        result.opsNotified = false
        Sentry.captureException(error, {
            tags: {
                operation: 'site_suggestion_ops_notice',
                route: 'ingest/site-suggestions/ack',
            },
            extra: { domains, changed: result.changed },
        })
    }
    return result
}

/** Of these rows, which are `supported`, carry an email, and have NOT been
 * notified - i.e. exactly the notices a human still has to authorise. */
async function pendingNoticeIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return []
    const rows = await prisma.siteSuggestion.findMany({
        where: {
            id: { in: ids },
            status: 'supported',
            notifiedAt: null,
            NOT: { requesterEmail: null },
        },
        select: { id: true },
    })
    return rows.map(row => row.id)
}

// ---------------------------------------------------------------------------
// The requester notice (POST /api/ingest/site-suggestions/notify).
// ---------------------------------------------------------------------------

export type SiteSuggestionNotifyOutcome =
    | 'sent'
    | 'already_notified'
    | 'not_eligible'
    | 'failed'

export interface SiteSuggestionNotifyResult {
    id: string
    outcome: SiteSuggestionNotifyOutcome
    /** Present on `not_eligible` and `failed`; names WHY, so an operator is not
     * left guessing which of several refusals they hit. */
    reason?: string
}

export interface SiteSuggestionNotifySummary {
    results: SiteSuggestionNotifyResult[]
    sent: number
    alreadyNotified: number
    notEligible: number
    failed: number
}

/** One mail per requester email per domain, so the key folds case: a person who
 * typed `Shopper@x.com` once and `shopper@x.com` the next time is one person,
 * and must not be mailed twice about one store. */
function noticeKey(domain: string, email: string): string {
    return `${domain} ${email.trim().toLowerCase()}`
}

/**
 * Send the "your store is supported" notice for exactly these ids.
 *
 * Eligible = the row is `supported`, carries a requester email, and has never
 * been notified. Everything else is REPORTED, never silently skipped.
 *
 * Idempotency is a CLAIM, not a check: `notified_at` is stamped BEFORE the mail
 * goes out, under a `notifiedAt: null` guard, so two callers racing the same row
 * cannot both send. If the send then fails the claim is RELEASED (back to NULL)
 * and the id is reported `failed` - a row that says the person was told when
 * nobody told them would bury the notice forever, because nothing ever re-reads
 * a stamped row.
 */
export async function notifySupportedRequesters(
    ids: string[],
): Promise<SiteSuggestionNotifySummary> {
    const results: SiteSuggestionNotifyResult[] = []
    if (ids.length === 0) return summariseNotifyResults(results)

    const rows = await prisma.siteSuggestion.findMany({
        where: { id: { in: ids } },
        select: {
            id: true,
            domain: true,
            requesterEmail: true,
            status: true,
            notifiedAt: true,
        },
    })
    const byId = new Map(rows.map(row => [row.id, row]))

    // Group the eligible rows by (domain, folded email): several suggestions of
    // the same store by the same person are ONE notice, and the duplicates are
    // stamped alongside the row that was actually mailed.
    const groups = new Map<
        string,
        { domain: string; email: string; ids: string[] }
    >()
    // Keys in the order they were first seen. The Map is the lookup; this is
    // what the loop below walks, so the output order follows the caller's ids
    // and the module never has to iterate a Map (the tsconfig target predates
    // downlevel iteration).
    const groupKeys: string[] = []
    const domains: string[] = []
    for (const id of ids) {
        const row = byId.get(id)
        if (!row) {
            results.push({ id, outcome: 'not_eligible', reason: 'not_found' })
            continue
        }
        if (row.status !== 'supported') {
            results.push({
                id,
                outcome: 'not_eligible',
                reason: `status_is_${row.status}`,
            })
            continue
        }
        if (!row.requesterEmail) {
            results.push({ id, outcome: 'not_eligible', reason: 'no_email' })
            continue
        }
        if (row.notifiedAt) {
            results.push({ id, outcome: 'already_notified' })
            continue
        }
        const key = noticeKey(row.domain, row.requesterEmail)
        const group = groups.get(key)
        if (group) {
            group.ids.push(id)
        } else {
            groups.set(key, {
                domain: row.domain,
                email: row.requesterEmail,
                ids: [id],
            })
            groupKeys.push(key)
            if (!domains.includes(row.domain)) domains.push(row.domain)
        }
    }
    if (groups.size === 0) return summariseNotifyResults(results)

    // ONE query for "who has already been told about these domains?", matched
    // case-insensitively in JS rather than with a per-row insensitive query.
    // Without it, a person who suggested the same store twice months apart and
    // was mailed the first time would be mailed again for the second row.
    const alreadyTold = await prisma.siteSuggestion.findMany({
        where: { domain: { in: domains }, NOT: { notifiedAt: null } },
        select: { domain: true, requesterEmail: true, notifiedAt: true },
    })
    const toldAt = new Map<string, Date>()
    for (const row of alreadyTold) {
        if (!row.requesterEmail || !row.notifiedAt) continue
        const key = noticeKey(row.domain, row.requesterEmail)
        const seen = toldAt.get(key)
        // Keep the EARLIEST stamp: a duplicate row inherits the instant the
        // person was actually told, not the moment we noticed they had been.
        if (!seen || row.notifiedAt < seen) toldAt.set(key, row.notifiedAt)
    }

    for (const key of groupKeys) {
        const group = groups.get(key)!
        const previous = toldAt.get(key)
        if (previous) {
            await prisma.siteSuggestion.updateMany({
                where: { id: { in: group.ids }, notifiedAt: null },
                data: { notifiedAt: previous },
            })
            for (const id of group.ids) {
                results.push({ id, outcome: 'already_notified' })
            }
            continue
        }

        const claimedAt = new Date()
        const claim = await prisma.siteSuggestion.updateMany({
            where: { id: { in: group.ids }, notifiedAt: null },
            data: { notifiedAt: claimedAt },
        })
        if (claim.count === 0) {
            // Another notifier claimed every row between the read and here.
            for (const id of group.ids) {
                results.push({ id, outcome: 'already_notified' })
            }
            continue
        }

        try {
            await sendStoreSupportedNotice({
                to: group.email,
                domain: group.domain,
            })
            for (const id of group.ids) results.push({ id, outcome: 'sent' })
        } catch (error) {
            // Release the claim so the notice stays visibly PENDING and the
            // same command retries it. Reported to Sentry AND to the caller.
            await prisma.siteSuggestion.updateMany({
                where: { id: { in: group.ids }, notifiedAt: claimedAt },
                data: { notifiedAt: null },
            })
            Sentry.captureException(error, {
                tags: {
                    operation: 'site_suggestion_requester_notice',
                    route: 'ingest/site-suggestions/notify',
                },
                extra: { domain: group.domain, ids: group.ids },
            })
            for (const id of group.ids) {
                results.push({ id, outcome: 'failed', reason: 'send_failed' })
            }
        }
    }
    return summariseNotifyResults(results)
}

function summariseNotifyResults(
    results: SiteSuggestionNotifyResult[],
): SiteSuggestionNotifySummary {
    return {
        results,
        sent: results.filter(r => r.outcome === 'sent').length,
        alreadyNotified: results.filter(r => r.outcome === 'already_notified')
            .length,
        notEligible: results.filter(r => r.outcome === 'not_eligible').length,
        failed: results.filter(r => r.outcome === 'failed').length,
    }
}
