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
import prisma from '@/lib/prisma'
import { resolveStoreDomain } from '@/lib/storeDomain'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'

// The lifecycle the app and the pipeline agree on. `new` = captured and not yet
// handed over; `imported` = the pipeline acknowledged it (POST .../ack). Kept as
// a const tuple (not a Prisma enum) so a later status ("supported", "rejected")
// is a one-line change here and a data change in the DB, never a migration.
const SITE_SUGGESTION_STATUSES = ['new', 'imported'] as const

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

export const SiteSuggestionAckBodySchema = z.object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(1000),
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

/**
 * Flip `new` rows to `imported`. ONLY `new` rows move — an id already past
 * `new` is left alone, so a pipeline retry (or a stale id list) is idempotent
 * and can never drag a row backwards. Returns how many rows actually flipped;
 * the caller compares that against what it sent if it cares.
 */
export async function acknowledgeSiteSuggestions(
    ids: string[],
): Promise<{ acknowledged: number }> {
    const result = await prisma.siteSuggestion.updateMany({
        where: { id: { in: ids }, status: 'new' },
        data: { status: 'imported', importedAt: new Date() },
    })
    return { acknowledged: result.count }
}
