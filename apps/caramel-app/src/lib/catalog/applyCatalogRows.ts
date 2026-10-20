// src/lib/catalog/applyCatalogRows.ts
//
// W3b — the shared write engine for the app-owned published catalog. ONE pure
// function of (payload) -> result, with NO HTTP concerns inside, so BOTH the
// ingest endpoint (POST /api/ingest/catalog, now) and the W4 external-catalog
// bridge (later) drive the exact same code path. A 1-row push and a 23k-row
// push take the identical path.
//
// The model is a pure DELTA UPSERT, never a snapshot/replace:
//   * Each pushed row carries its own `updated_at`. A row is applied ONLY when
//     it is at least as new as the stored row (only-if-newer) — so retries and
//     out-of-order delivery are idempotent and safe: replaying an old push, or
//     receiving pushes out of sequence, never regresses the catalog.
//   * Tombstoning (a coupon going expired / non-visible) happens PER ROW, when a
//     pushed row flips a currently-visible coupon to expired/non-visible —
//     NEVER by absence. A coupon missing from a push is simply not mentioned;
//     it is never deleted or expired for being absent. There is no batch-end
//     reconciliation and no file/snapshot semantics.
//
// The whole apply runs in ONE interactive transaction: a failure part-way
// through a multi-row push (e.g. a value that overflows a column) rolls back
// everything, so the catalog is never left half-written.
//
// Values are stored RAW, with ONE deliberate exception besides `site` below:
// personal referral codes (coupons.ts isReferralCoupon: "refer a friend",
// "code in the link", ...) benefit a stranger and often only work for new
// accounts, so the owner wants them out of the catalog (T-2956). A referral row
// whose id is not stored yet is NOT inserted (counted `skippedReferral`); one
// already stored is written with `expired = true`, so it leaves the catalog
// through the ordinary per-row tombstone path (counted in `tombstoned` and
// measured by the 20% gate like any other tombstone). Only `expired` is forced:
// status and every other column stay raw. A referral row flagged
// `new_customers_only` (pushed true, or stored true and not cleared by the push)
// is NOT removed: it is a referral code the owner kept because the new customer
// gets a discount (2026-10-19), and the site labels it "New customers only".
//
// `new_customers_only` is the one coupon column where absent means "no
// opinion": a push that omits it (or sends null) keeps the stored value, via
// COALESCE in the ON CONFLICT clause, like the selector columns below.
//
// Identity guard: a pushed row is applied to a stored row ONLY when both are the
// same coupon (isSameCatalogCoupon: same site, same code ignoring case). The
// catalog's ids come from two id spaces. The 2026-08-08 bridge-sync seeded the
// app from the dev coupons DB, and the prod pipeline DB (rebuilt 2026-08-10/11)
// re-minted ids from 74351 on, so the same id can name two different coupons.
// Measured on prod 2026-10-18: 8,824 stored rows still hold a different coupon
// than the pipeline row with their id (e.g. 103346 is vitabiotics.com GPN10 here
// and unbounce.com JhonDodo88 in the pipeline), and 20,339 seeded rows had
// already been overwritten that way. A mismatched row is never written (no
// update, no referral expiry, no tombstone): it is counted `skippedIdMismatch`
// and its ids are logged. It cannot be inserted as new either, because its id is
// the stored row's primary key. The ON CONFLICT clause repeats the check, so a
// concurrent write cannot slip a different coupon onto the id.
//
// store_configs has a second, insert-only writer in this module:
// insertAutoDetectedStoreConfig (a promo box the extension found and proved on
// a store with no config, `origin = 'auto_detect'`). A pipeline push for such a
// store replaces all eight selectors and clears `origin`, whatever the saved
// row's `updated_at`; pipeline-on-pipeline upserts are unchanged.
//
// Safety gate: a single push that would tombstone/expire more than 20% of the
// currently-visible catalog is REFUSED (409, `gated`) unless `force: true`.
// This guards against a broken producer wiping the catalog with one bad push;
// a genuinely large expiry is still possible by resending with force.
import type { IngestCatalogPayload } from '@/lib/catalog/ingestSchemas'
import { VISIBLE_COUPON_STATUSES, isReferralCoupon } from '@/lib/coupons'
import prisma from '@/lib/prisma'
import { Prisma } from '@prisma/client'

/** The tombstone-gate detail returned (409) when a push is refused. */
export interface CatalogGate {
    /** How many currently-visible coupons this push would tombstone. */
    wouldTombstone: number
    /** The whole-catalog visible-coupon count the threshold is measured against. */
    visibleBefore: number
    /** The percentage threshold that was exceeded (currently 20). */
    thresholdPct: number
}

/** Per-coupon outcome tally. inserted+updated are rows actually written;
 * skippedOlder are rows dropped by the only-if-newer rule; tombstoned counts
 * how many of the applied rows flipped a visible coupon to non-visible;
 * skippedReferral are personal referral codes (isReferralCoupon) that were not
 * in the catalog yet and so were never inserted; skippedIdMismatch are rows
 * whose id is stored with a DIFFERENT coupon (isSameCatalogCoupon), never
 * written. */
export interface CatalogCounts {
    inserted: number
    updated: number
    skippedOlder: number
    tombstoned: number
    skippedReferral: number
    skippedIdMismatch: number
}

// Discriminated on `gated` so callers (the route) can read `.gate` after a
// `if (result.gated)` narrow without a non-null assertion. A gated result
// applied NOTHING (the transaction rolled back), hence the zeroed counts.
export type ApplyResult =
    | {
          gated: true
          gate: CatalogGate
          coupons: CatalogCounts
          storeConfigs: { upserted: number }
          sources: { upserted: number }
      }
    | {
          gated: false
          gate?: undefined
          coupons: CatalogCounts
          storeConfigs: { upserted: number }
          sources: { upserted: number }
      }

const VISIBLE = new Set<string>(VISIBLE_COUPON_STATUSES)

// A push tombstoning more than this share of the visible catalog is refused
// without force. See the module header for the rationale.
const TOMBSTONE_THRESHOLD_PCT = 20

// Bulk-write chunk size. Each coupon tuple binds 17 parameters; 500 * 17 = 8500
// is comfortably under Postgres' 65535-parameter statement cap, with the same
// headroom for the narrower store_config/source tuples.
const WRITE_CHUNK = 500

// The current-state SELECT binds one parameter per id. 23k (the design max)
// fits one statement, but chunk anyway so an unexpectedly huge push can't blow
// the parameter cap (the "guard" the contract calls for).
const SELECT_ID_CHUNK = 10_000

/**
 * Thrown INSIDE the transaction when the tombstone gate trips, to roll the
 * whole apply back. Caught immediately OUTSIDE the transaction and converted to
 * a `gated` ApplyResult — it never escapes applyCatalogRows. A private sentinel
 * (not exported) so nothing else can accidentally produce or catch it.
 */
class TombstoneGateError extends Error {
    readonly gate: CatalogGate
    constructor(gate: CatalogGate) {
        super(
            `catalog ingest tombstone gate: ${gate.wouldTombstone} of ${gate.visibleBefore} visible coupons (>${gate.thresholdPct}%)`,
        )
        this.name = 'TombstoneGateError'
        this.gate = gate
    }
}

/**
 * The ONE write-side normalization in this engine: `site` is stored lowercase.
 * Domains are case-insensitive, but every store read matches
 * `site = $base OR <site ends in '.' || $base>` (couponsRepo's onStoreSql)
 * case-SENSITIVELY (plain equality keeps `coupons_site_idx` usable) against a base resolveStoreDomain has
 * lowercased — so a mixed-case producer value was unreachable from its own
 * canonical page (prod 2026-09-11: `eNasco.com`, `Brooklinen.com`). The
 * `lowercase_coupon_sites` migration backfilled existing rows; this keeps new
 * ones honest. Everything else (status, discount_type, code) stays RAW per
 * ingestSchemas.ts — this is a domain-name identity, not a vocabulary.
 */
function normalizeSite(site: string | null): string | null {
    return site == null ? null : site.toLowerCase()
}

/** The stored side of the identity check: the row already holding the id. */
interface StoredCouponIdentity {
    site: string | null
    code: string
}

/**
 * True when a row is a kept new-customer offer: the push flags it, or the push
 * has no opinion (absent/null) and the stored row is flagged. Such a row is
 * exempt from the referral removal (see the module header).
 */
function isNewCustomersOnly(
    pushed: boolean | null | undefined,
    stored: boolean | null | undefined,
): boolean {
    return (pushed ?? stored) === true
}

/**
 * True when a pushed row and the stored row with its id are the same coupon:
 * the same site (normalizeSite, so stored rows, which are lowercase, compare
 * against the lowercased push) and the same code ignoring case (the same rule
 * as submitShopperCoupon's lower(code) dedupe). The upsert's ON CONFLICT WHERE
 * repeats this in SQL; keep the two in step.
 */
function isSameCatalogCoupon(
    stored: StoredCouponIdentity,
    pushed: { site: string | null; code: string },
): boolean {
    return (
        normalizeSite(stored.site) === normalizeSite(pushed.site) &&
        stored.code.toLowerCase() === pushed.code.toLowerCase()
    )
}

/** At most this many mismatched ids are named in the warning line. */
const MISMATCH_LOG_ID_LIMIT = 50

/**
 * One summary line per applied push, plus a warning naming the mismatched ids
 * (never codes) when any were skipped. Counts and ids only.
 */
function logCouponOutcome(counts: CatalogCounts, mismatchedIds: string[]) {
    console.info(
        `[ingest/catalog] coupons inserted=${counts.inserted} updated=${counts.updated} skippedOlder=${counts.skippedOlder} tombstoned=${counts.tombstoned} skippedReferral=${counts.skippedReferral} skippedIdMismatch=${counts.skippedIdMismatch}`,
    )
    if (mismatchedIds.length === 0) return
    const named = mismatchedIds.slice(0, MISMATCH_LOG_ID_LIMIT).join(',')
    const more =
        mismatchedIds.length > MISMATCH_LOG_ID_LIMIT
            ? ` (+${mismatchedIds.length - MISMATCH_LOG_ID_LIMIT} more)`
            : ''
    console.warn(
        `[ingest/catalog] skippedIdMismatch=${mismatchedIds.length}: these ids hold a different coupon (site or code) in the catalog and were not written: ${named}${more}`,
    )
}

function chunk<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size))
    }
    return out
}

/**
 * Collapse duplicate keys within a single push, keeping the row with the
 * greatest `updated_at`. A producer legitimately can send the same id twice in
 * one batch, but a bulk `INSERT ... ON CONFLICT DO UPDATE` errors ("ON CONFLICT
 * DO UPDATE command cannot affect row a second time") on an intra-statement
 * duplicate, so the duplicates MUST be resolved before writing. Keeping the
 * newest mirrors the only-if-newer rule applied across the batch itself.
 */
function dedupeByKey<T>(
    rows: readonly T[],
    keyOf: (row: T) => string,
    updatedAtOf: (row: T) => Date,
): T[] {
    const byKey = new Map<string, T>()
    for (const row of rows) {
        const key = keyOf(row)
        const existing = byKey.get(key)
        if (!existing || updatedAtOf(row) >= updatedAtOf(existing)) {
            byKey.set(key, row)
        }
    }
    return Array.from(byKey.values())
}

/**
 * Resolve the timestamps for a store_config / source row. Unlike coupons
 * (whose `updated_at` is mandatory), these entities carry no required ordering
 * key, so when the supplier omits `updated_at` we stamp `now` — last-write-wins
 * — and reuse that same instant for `created_at` when it too is omitted (so a
 * first insert has matching timestamps). Computed ONCE here so the dedupe order,
 * the only-if-newer WHERE guard, and the written value all agree. `new Date()`
 * is ordinary runtime code here — this is a Next.js request handler, not a
 * deterministic workflow step.
 */
function withResolvedTimestamps<
    T extends { updated_at?: Date; created_at?: Date },
>(row: T): T & { updated_at: Date; created_at: Date } {
    const now = new Date()
    const updated_at = row.updated_at ?? now
    const created_at = row.created_at ?? updated_at
    return { ...row, updated_at, created_at }
}

/**
 * Build a parameterized Postgres `text[]` literal. Prisma's raw layer does not
 * reliably bind a JS array to an array-typed parameter, so construct
 * `ARRAY[$1, $2, ...]::text[]` explicitly (empty array -> `ARRAY[]::text[]`,
 * which still needs the cast to type the empty literal).
 */
function pgTextArray(values: readonly string[]): Prisma.Sql {
    if (values.length === 0) return Prisma.sql`ARRAY[]::text[]`
    return Prisma.sql`ARRAY[${Prisma.join([...values])}]::text[]`
}

/**
 * Apply an ingest push to the app-owned catalog and report what happened.
 *
 * Control flow (all inside one interactive transaction):
 *  1. Coupons (if any): dedupe by id; read the current {expired,status,
 *     updated_at} of every pushed id; count the whole-catalog visible total;
 *     classify each row (skip-older / insert / update, and whether it
 *     tombstones a visible coupon); if the tombstone total trips the gate and
 *     `force` is false, throw (rolls back) BEFORE any write; otherwise bulk
 *     upsert the applying rows only-if-newer.
 *  2. store_configs, then sources (same transaction): dedupe, bulk upsert
 *     only-if-newer.
 *
 * Concurrency caveat: the tombstone count is computed from a snapshot read, so
 * under two SIMULTANEOUS pushes it can be marginally stale — it is a safety
 * heuristic against a wholesale wipe, not a strict invariant. The pipeline
 * pushes serially, so this does not arise in practice; the per-row ON CONFLICT
 * `WHERE excluded.updated_at >= …` guard still prevents a concurrent write from
 * being clobbered by an older one regardless.
 */
/**
 * `store_configs.origin` of a row the extension saved (insertAutoDetectedStoreConfig). A
 * pipeline row's origin is NULL. A pipeline push replaces a saved row whatever its
 * `updated_at` (see SELECTOR_UPSERT_ASSIGNMENTS and the store_configs upsert below).
 */
export const AUTO_DETECT_ORIGIN = 'auto_detect'

/**
 * The eight extension-consumed selector columns, in the order the upsert writes them.
 */
const SELECTOR_COLUMNS = [
    'show_input_xpath',
    'dismiss_button_xpath',
    'coupon_input_xpath',
    'apply_button_xpath',
    'price_container_xpath',
    'success_indicator_xpath',
    'error_indicator_xpath',
    'coupon_remove_xpath',
] as const

/**
 * `ON CONFLICT` assignments for the selector columns, where **absent means "no opinion",
 * not "delete"**.
 *
 * These used to be a plain `col = excluded.col`, which made a push authoritative for every
 * column including the ones the producer knows nothing about. The producer's served rows are
 * SPARSE — measured 2026-08-14 over 2,132 stores: `dismiss_button_xpath` is null on 97.8% of
 * them, `show_input_xpath` on 74.6%, `price_container_xpath` on 18.2% — so a routine sync
 * silently DELETED values this table was serving. Eight domains lost a field that day
 * (mikasa.com, oralb.com, plae.co, simpli-home.com, thegldshop.com, theoutnet.com,
 * uspoloassn.com, venus.com); four of them because a freshly discovered config with fewer
 * populated fields became the producer's served row. Nothing else writes this table, so a
 * dropped value never came back on its own.
 *
 * A NULL is therefore treated as "I have no value for this field" and leaves the stored value
 * alone. Deleting a selector is still possible, but it must be SAID rather than implied: the
 * empty string is an explicit tombstone and clears the column. Plain COALESCE was rejected for
 * exactly that reason — it would have made a wrong selector unremovable by any push.
 *
 * One exception, the first WHEN: a row the extension saved (`origin = 'auto_detect'`, see
 * AUTO_DETECT_ORIGIN below) is REPLACED whole by a pipeline push. Every selector takes the
 * pushed value, a NULL stays NULL and '' clears, so a pipeline config never mixes with the
 * saved one. A pipeline row (`origin` NULL) never reaches that branch.
 *
 * Column names come from the const array above, never from input, so `Prisma.raw` is safe here.
 */
const SELECTOR_UPSERT_ASSIGNMENTS = Prisma.raw(
    SELECTOR_COLUMNS.map(
        col =>
            `${col} = CASE` +
            ` WHEN store_configs.origin = '${AUTO_DETECT_ORIGIN}' THEN NULLIF(excluded.${col}, '')` +
            ` WHEN excluded.${col} IS NULL THEN store_configs.${col}` +
            ` WHEN excluded.${col} = '' THEN NULL` +
            ` ELSE excluded.${col} END`,
    ).join(', '),
)

export async function applyCatalogRows(
    payload: IngestCatalogPayload,
): Promise<ApplyResult> {
    const { force } = payload
    // Filled inside the transaction, logged only once it commits.
    const mismatchedIds: string[] = []

    try {
        const result = await prisma.$transaction(
            async tx => {
                // ---- coupons -------------------------------------------------
                const coupons = dedupeByKey(
                    payload.coupons,
                    c => c.id,
                    c => c.updated_at,
                )
                const couponCounts: CatalogCounts = {
                    inserted: 0,
                    updated: 0,
                    skippedOlder: 0,
                    tombstoned: 0,
                    skippedReferral: 0,
                    skippedIdMismatch: 0,
                }

                if (coupons.length > 0) {
                    // Current state of every pushed id (chunked so a huge push
                    // can't exceed the parameter cap).
                    const current = new Map<
                        string,
                        StoredCouponIdentity & {
                            expired: boolean
                            status: string
                            updated_at: Date
                            new_customers_only: boolean | null
                        }
                    >()
                    for (const idChunk of chunk(
                        coupons.map(c => c.id),
                        SELECT_ID_CHUNK,
                    )) {
                        const rows = await tx.$queryRaw<
                            Array<{
                                id: string
                                site: string | null
                                code: string
                                expired: boolean
                                status: string
                                updated_at: Date
                                new_customers_only: boolean | null
                            }>
                        >(
                            Prisma.sql`SELECT id, site, code, expired, status, updated_at, new_customers_only FROM coupons WHERE id IN (${Prisma.join(idChunk)})`,
                        )
                        for (const row of rows) {
                            current.set(row.id, {
                                site: row.site,
                                code: row.code,
                                expired: row.expired,
                                status: row.status,
                                updated_at: row.updated_at,
                                new_customers_only: row.new_customers_only,
                            })
                        }
                    }

                    // Whole-catalog visible count the gate threshold is measured
                    // against (matches couponsRepo's visible predicate).
                    const visibleBefore = await tx.coupon.count({
                        where: {
                            expired: false,
                            status: { in: [...VISIBLE_COUPON_STATUSES] },
                        },
                    })

                    // Classify each row against the snapshot. Only applying rows
                    // (insert/update) are written; older rows are skipped, and
                    // only an applying row can tombstone (a skipped older row
                    // changes nothing).
                    const toWrite: typeof coupons = []
                    for (const pushed of coupons) {
                        const cur = current.get(pushed.id)
                        // A different coupon under the same id is never
                        // touched, whatever its timestamps or referral wording.
                        if (cur && !isSameCatalogCoupon(cur, pushed)) {
                            couponCounts.skippedIdMismatch++
                            mismatchedIds.push(pushed.id)
                            continue
                        }
                        const isReferral =
                            isReferralCoupon(pushed) &&
                            !isNewCustomersOnly(
                                pushed.new_customers_only,
                                cur?.new_customers_only,
                            )
                        // A referral row never enters the catalog; an already
                        // stored one is expired (the only forced value) so the
                        // tombstone path below removes it. A kept new-customer
                        // offer is not a referral to remove.
                        const row = isReferral
                            ? { ...pushed, expired: true }
                            : pushed
                        const willApply =
                            !cur || row.updated_at >= cur.updated_at
                        if (!willApply) {
                            couponCounts.skippedOlder++
                            continue
                        }
                        if (isReferral && !cur) {
                            couponCounts.skippedReferral++
                            continue
                        }
                        if (cur) couponCounts.updated++
                        else couponCounts.inserted++

                        const curVisible =
                            !!cur && !cur.expired && VISIBLE.has(cur.status)
                        const rowVisible =
                            !row.expired && VISIBLE.has(row.status)
                        if (curVisible && !rowVisible) couponCounts.tombstoned++

                        toWrite.push(row)
                    }

                    // Gate BEFORE any write. Throwing here rolls the whole
                    // transaction back, so a gated push applies nothing.
                    if (
                        !force &&
                        visibleBefore > 0 &&
                        couponCounts.tombstoned >
                            (TOMBSTONE_THRESHOLD_PCT / 100) * visibleBefore
                    ) {
                        throw new TombstoneGateError({
                            wouldTombstone: couponCounts.tombstoned,
                            visibleBefore,
                            thresholdPct: TOMBSTONE_THRESHOLD_PCT,
                        })
                    }

                    // Bulk upsert the applying rows. The ON CONFLICT ... WHERE
                    // excluded.updated_at >= coupons.updated_at is the
                    // authoritative only-if-newer guard (belt-and-suspenders
                    // with the classification above, and the thing that makes a
                    // concurrent newer write win). created_at is set on INSERT
                    // only — deliberately NOT in the DO UPDATE SET — so it is
                    // preserved forever after the first insert.
                    for (const rowChunk of chunk(toWrite, WRITE_CHUNK)) {
                        const tuples = rowChunk.map(
                            r =>
                                Prisma.sql`(${r.id}, ${r.code}, ${normalizeSite(r.site)}, ${r.title}, ${r.description}, ${r.rating}, ${r.discount_type}, ${r.discount_amount}, ${r.expiry}, ${r.expired}, ${r.times_used}, ${r.last_time_used ?? null}, ${r.status}, ${r.verification_message}, ${r.created_at ?? new Date()}, ${r.updated_at}, ${r.new_customers_only ?? null})`,
                        )
                        await tx.$executeRaw(
                            Prisma.sql`
                                INSERT INTO coupons (id, code, site, title, description, rating, discount_type, discount_amount, expiry, expired, times_used, last_time_used, status, verification_message, created_at, updated_at, new_customers_only)
                                VALUES ${Prisma.join(tuples)}
                                ON CONFLICT (id) DO UPDATE SET
                                    code = excluded.code,
                                    site = excluded.site,
                                    title = excluded.title,
                                    description = excluded.description,
                                    rating = excluded.rating,
                                    discount_type = excluded.discount_type,
                                    discount_amount = excluded.discount_amount,
                                    expiry = excluded.expiry,
                                    expired = excluded.expired,
                                    times_used = excluded.times_used,
                                    last_time_used = excluded.last_time_used,
                                    status = excluded.status,
                                    verification_message = excluded.verification_message,
                                    updated_at = excluded.updated_at,
                                    new_customers_only = COALESCE(excluded.new_customers_only, coupons.new_customers_only)
                                WHERE excluded.updated_at >= coupons.updated_at
                                    AND lower(coupons.site) IS NOT DISTINCT FROM excluded.site
                                    AND lower(coupons.code) = lower(excluded.code)
                            `,
                        )
                    }
                }

                // ---- store_configs ------------------------------------------
                const storeConfigs = dedupeByKey(
                    payload.storeConfigs.map(withResolvedTimestamps),
                    s => s.store_name,
                    s => s.updated_at,
                )
                for (const scChunk of chunk(storeConfigs, WRITE_CHUNK)) {
                    const tuples = scChunk.map(
                        s =>
                            Prisma.sql`(${s.store_name}, ${s.show_input_xpath ?? null}, ${s.dismiss_button_xpath ?? null}, ${s.coupon_input_xpath ?? null}, ${s.apply_button_xpath ?? null}, ${s.price_container_xpath ?? null}, ${s.success_indicator_xpath ?? null}, ${s.error_indicator_xpath ?? null}, ${s.coupon_remove_xpath ?? null}, ${s.created_at}, ${s.updated_at})`,
                    )
                    await tx.$executeRaw(
                        Prisma.sql`
                            INSERT INTO store_configs (store_name, show_input_xpath, dismiss_button_xpath, coupon_input_xpath, apply_button_xpath, price_container_xpath, success_indicator_xpath, error_indicator_xpath, coupon_remove_xpath, created_at, updated_at)
                            VALUES ${Prisma.join(tuples)}
                            ON CONFLICT (store_name) DO UPDATE SET
                                ${SELECTOR_UPSERT_ASSIGNMENTS},
                                updated_at = excluded.updated_at,
                                origin = NULL
                            WHERE excluded.updated_at >= store_configs.updated_at
                                OR store_configs.origin = ${AUTO_DETECT_ORIGIN}
                        `,
                    )
                }

                // ---- sources -------------------------------------------------
                const sources = dedupeByKey(
                    payload.sources.map(withResolvedTimestamps),
                    s => s.id,
                    s => s.updated_at,
                )
                for (const srcChunk of chunk(sources, WRITE_CHUNK)) {
                    const tuples = srcChunk.map(
                        s =>
                            Prisma.sql`(${s.id}, ${s.source}, ${pgTextArray(s.websites)}, ${s.status}, ${s.created_at}, ${s.updated_at})`,
                    )
                    await tx.$executeRaw(
                        Prisma.sql`
                            INSERT INTO sources (id, source, websites, status, created_at, updated_at)
                            VALUES ${Prisma.join(tuples)}
                            ON CONFLICT (id) DO UPDATE SET
                                source = excluded.source,
                                websites = excluded.websites,
                                status = excluded.status,
                                updated_at = excluded.updated_at
                            WHERE excluded.updated_at >= sources.updated_at
                        `,
                    )
                }

                return {
                    gated: false as const,
                    coupons: couponCounts,
                    // upserted = rows offered after dedupe. A row the
                    // only-if-newer WHERE skipped is a no-op re-affirmation, not
                    // a failure, so counting the offered rows is the honest,
                    // simple measure (rows-affected would under-count an
                    // idempotent re-push of unchanged configs).
                    storeConfigs: { upserted: storeConfigs.length },
                    sources: { upserted: sources.length },
                }
            },
            {
                // Large pushes (up to ~23k coupons → dozens of chunked INSERTs)
                // exceed Prisma's 5s interactive-transaction default. Give the
                // whole apply generous headroom; maxWait bounds how long we
                // queue for a connection before failing loudly.
                maxWait: 15_000,
                timeout: 120_000,
            },
        )
        logCouponOutcome(result.coupons, mismatchedIds)
        return result
    } catch (error) {
        if (error instanceof TombstoneGateError) {
            return {
                gated: true,
                gate: error.gate,
                coupons: {
                    inserted: 0,
                    updated: 0,
                    skippedOlder: 0,
                    tombstoned: 0,
                    skippedReferral: 0,
                    skippedIdMismatch: 0,
                },
                storeConfigs: { upserted: 0 },
                sources: { upserted: 0 },
            }
        }
        // Any real failure (bad data mid-batch, connection loss, …) propagates
        // — the transaction already rolled back, and the caller (withRoute)
        // routes it to Sentry. NEVER swallowed.
        throw error
    }
}

/** The four selectors of a box the extension saved, in store_configs terms. */
export interface AutoDetectedStoreConfig {
    /** The store's catalog name (couponBoxSave.resolveSaveStoreName). */
    storeName: string
    couponInputXpath: string
    applyButtonXpath: string
    showInputXpath: string | null
    priceContainerXpath: string | null
}

/**
 * Write a coupon box the extension found and proved on a store with no config
 * as that store's `store_configs` row (POST /api/extension/coupon-box-save).
 * The same row and the same columns the pipeline's push writes, read back by
 * the same GET /api/extension/supported-stores. The other four selectors are
 * NULL, `origin` is AUTO_DETECT_ORIGIN and `updated_at` is now, so a later
 * pipeline push replaces the row whole (applyCatalogRows above).
 *
 * Insert-only: when the store already has a row (the pipeline's, served or
 * not, or an earlier save that won a race) nothing is written and the answer
 * is `{ inserted: false }`.
 */
export async function insertAutoDetectedStoreConfig(
    config: AutoDetectedStoreConfig,
): Promise<{ inserted: boolean }> {
    const rows = await prisma.$queryRaw<Array<{ store_name: string }>>(
        Prisma.sql`
            INSERT INTO store_configs (store_name, show_input_xpath, dismiss_button_xpath, coupon_input_xpath, apply_button_xpath, price_container_xpath, success_indicator_xpath, error_indicator_xpath, coupon_remove_xpath, origin, created_at, updated_at)
            VALUES (${config.storeName}, ${config.showInputXpath}, NULL, ${config.couponInputXpath}, ${config.applyButtonXpath}, ${config.priceContainerXpath}, NULL, NULL, NULL, ${AUTO_DETECT_ORIGIN}, now(), now())
            ON CONFLICT (store_name) DO NOTHING
            RETURNING store_name
        `,
    )
    return { inserted: rows.length === 1 }
}
