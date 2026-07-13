// lib/couponsDb.ts
//
// Read-only connection to the `caramel_coupons` database owned by the
// Python verification service. All mutations to the coupon catalog flow
// through that service — Next.js only reads (plus three narrow mutations,
// all in src/lib/couponsRepo.ts: usage-increment and expire, both exposed
// to the extension, and inserting a REQUESTED `sources` row from the
// public "request a store" form). The Python service owns everything else
// and must treat those specific columns as co-written — never clobber
// `times_used`/`last_time_used`, honor `expired`/`expiry` once set. See
// DESIGN.md §2 "Write-ownership" for the full coordination contract.
//
// This file owns the boundary primitives only: the connection, the SQL
// fragment factories below, and the zod row schemas + parseCouponRows().
// The actual query text (13 read/write fns) and the structural drift-gate
// registry live in src/lib/couponsRepo.ts, built on these primitives —
// routes import from couponsRepo, never call couponsSql directly.
import { VISIBLE_COUPON_STATUSES } from '@/lib/coupons'
import { env } from '@/lib/env'
import postgres from 'postgres'
import { z } from 'zod'

const connectionString = env.COUPONS_DATABASE_URL

// Reuse one client across hot-reloads in dev to avoid pool leaks.
const globalForSql = globalThis as unknown as {
    couponsSql?: ReturnType<typeof postgres>
}

export const couponsSql =
    globalForSql.couponsSql ??
    postgres(connectionString, {
        max: 10,
        idle_timeout: 20,
        connect_timeout: 10,
        prepare: false,
        // F-011 — coarse cross-hop trace correlation. This hop has no
        // header channel (raw SQL, not an instrumented HTTP call), so a
        // real trace/request ID can't cross it; application_name is the
        // closest attribution available, surfacing "caramel-app" in
        // pg_stat_activity / DB logs instead of the porsager default
        // ('postgres.js') so a slow/blocking query can be traced back to
        // this process. See RUNBOOK.md "Trace correlation" for the
        // documented limitation (not per-request, known debt).
        connection: { application_name: 'caramel-app' },
    })

if (process.env.NODE_ENV !== 'production') {
    globalForSql.couponsSql = couponsSql
}

// ---------------------------------------------------------------------------
// Coupon-domain SQL fragments (F-006).
//
// Factories, not module-level consts: each call builds a fresh postgres.js
// query fragment. A const would work too (fragments are stateless data,
// and this codebase already reuses one across 2 queries — see the
// marketing store page), but a factory sidesteps any doubt about safe
// fragment reuse across concurrent requests.
//
// visibleCouponsWhere() replaces the WHERE predicate that used to be
// hand-copied — with silent drift — across coupons/route.ts, the marketing
// store page, sites/top-sites, sites/search-supported, coupons/stores
// (x2), and coupons/filters (which had drifted to a narrower 'valid'-only
// predicate; F-006 unifies it — see PLAN-F-006.md's "per-site drift
// ruling" table for that one deliberate, flagged behavior change).
// `couponsSql([...VISIBLE_COUPON_STATUSES])` is postgres.js's documented
// "dynamic values" helper: it expands to a properly parameterized
// `IN ($1,$2,...)` list rather than baking the statuses into literal SQL
// text — behavior-identical to the inline literals it replaces, since the
// values are our own constants, never user input.
export function visibleCouponsWhere() {
    return couponsSql`status IN ${couponsSql([...VISIBLE_COUPON_STATUSES])} AND expired = FALSE`
}

/** Shared ranking order — coupons/route.ts's list query and the marketing store page both sorted by this identical (previously hand-copied) order. */
export function rankingOrderSql() {
    return couponsSql`rating DESC, created_at DESC`
}

/**
 * coupons/stats/route.ts's census predicate. Deliberately NOT
 * visibleCouponsWhere(): stats reports a trust census (total vs. expired)
 * among *verified* ('valid') coupons specifically, so it must INCLUDE
 * expired ones (to count them) and EXCLUDE pending/restricted ones (not
 * yet a verified fact) — the opposite shape from the visibility
 * predicate. The name states that intent so a future editor doesn't "fix"
 * this into visibleCouponsWhere() by mistake. Behavior unchanged from
 * pre-F-006 (still the bare `status = 'valid'` this route always used).
 */
export function verifiedCensusSql() {
    return couponsSql`status = 'valid'`
}

// ---------------------------------------------------------------------------
// Runtime-validated read boundary (F-001).
//
// couponsSql is untyped raw SQL against a database this repo doesn't own —
// prior call sites papered over that with a TS generic
// (`couponsSql<Array<{site:string}>>`), which is a compile-time cast with
// zero runtime enforcement (top-sites even omitted `coupon_count` from its
// generic while selecting it). These schemas replace those casts: every
// read call site parses its raw rows through parseCouponRows() before
// touching the data, so a schema/type drift in the Python-owned DB throws
// loudly (→ Sentry via handleRouteError on API routes, → onRequestError on
// the SSR page) instead of silently serving malformed/zeroed data.
//
// Traps mirrored here (postgres.js RUNTIME types, not the DB's nominal
// column types):
//   - int8 (bigint) columns arrive as JS strings, int4 as JS numbers. `id`
//     uses couponIdSchema (below) rather than z.coerce.string(): plain
//     coercion turns a missing/null id into the literal string
//     "undefined"/"null" (`String(undefined) === 'undefined'`) instead of
//     failing — exactly the silent-wrong-data this boundary exists to
//     prevent. The union rejects null/undefined outright and only
//     normalizes an already-present number|string.
//   - numeric/decimal columns (rating, discount_amount) can arrive as JS
//     strings (postgres.js doesn't parse `numeric` to `number` by default,
//     to avoid float-precision loss) — coerced to number since the app
//     does arithmetic/formatting on them. z.coerce.number() correctly
//     rejects a missing key (Number(undefined) = NaN, invalid) while still
//     letting an explicit `null` through untouched via `.nullable()`.
//   - `::int`-cast aggregate columns (COUNT(*)::int, etc.) are guaranteed
//     JS numbers by the cast itself — plain z.number(), no coercion.
//   - nullability mirrors the specific query's guarantees / consuming-code
//     handling, not the full table schema: filters/route.ts's
//     `discount_type IS NOT NULL` makes that query's discount_type
//     non-null; stores/route.ts and search-supported's `.filter(Boolean)`
//     on site signals the consuming code already treats it as
//     possibly-nullish, so `site` stays nullable here too — a legitimate
//     null is never mistaken for drift. `status` and `discount_type` on
//     DiscountTypeRow, and (as of the CouponListRowSchema fix below)
//     `discount_type` on CouponListRow too, are deliberately loose
//     (z.string(), normalized rather than enum-constrained): they're
//     business data the Python producer can extend without that being
//     schema "drift" — see CouponListRowSchema's own field comment for why
//     the enum had to go.
const couponIdSchema = z
    .union([z.string(), z.number()])
    .transform(value => String(value))

export const CouponListRowSchema = z.object({
    id: couponIdSchema,
    code: z.string(),
    site: z.string(),
    title: z.string(),
    description: z.string(),
    rating: z.coerce.number(),
    // Tolerant + normalized, NOT enum-constrained. Was
    // `z.enum(['PERCENTAGE','CASH','SAVE'])`, which 500'd the main
    // /api/coupons listing against real data: verified against the oracle
    // (23,167-row snapshot), 86 VISIBLE rows carry a discount_type the
    // enum rejects outright — 34 lowercase ('percentage'), 44 a 4th
    // producer value ('fixed'), 8 null (genuinely unrated 'pending'
    // coupons) — and because the default listing's `ORDER BY rating DESC`
    // sorts NULLS FIRST, those rows sit at the very top of the unfiltered
    // catalog, so a bare, no-filter `/api/coupons` call throws on page 1,
    // every time. coupon-card.tsx only ever checks
    // `discount_type === 'PERCENTAGE'` (everything else renders
    // `$amount`) and no consumer needs a closed vocabulary, so
    // uppercase-normalizing (so lowercase producer values still satisfy
    // that one comparison) and allowing null is enough — this now matches
    // DiscountTypeRowSchema's existing "business data the Python producer
    // can extend" philosophy (see the doc comment above), just applied to
    // CouponListRow too. STRUCTURAL drift is still caught: a
    // missing/renamed column or a genuinely non-string value (e.g. a
    // number) still throws — only the closed vocabulary is gone. See
    // tests/unit/couponsDb-schemas.test.ts for the accept/reject pins.
    discount_type: z
        .string()
        .nullable()
        .transform(value => (value == null ? null : value.toUpperCase())),
    discount_amount: z.coerce.number().nullable(),
    // Nullable — was `z.string()`. Same real-data slice as discount_type
    // above: the 86 genuinely-unrated 'pending' visible rows have no
    // expiry yet either (100% overlap with the bad-discount_type rows).
    // coupon-card.tsx never reads `expiry` at all, so there's no UI reason
    // to require it.
    expiry: z.string().nullable(),
    expired: z.boolean(),
    timesUsed: z.coerce.number(),
    status: z.string(),
    verificationMessage: z.string().nullable(),
})
export type CouponListRow = z.infer<typeof CouponListRowSchema>

/** `SELECT COUNT(*)::int AS total` — coupons/route.ts + [store]/page.tsx. */
export const TotalCountRowSchema = z.object({
    total: z.number(),
})

/** coupons/stats/route.ts's total+expired aggregate. */
export const StatsRowSchema = z.object({
    total: z.number(),
    expired: z.number(),
})
export type StatsRow = z.infer<typeof StatsRowSchema>

/** Bare `{site}` rows — stores/, filters/ (sites half), search-supported/. */
export const SiteRowSchema = z.object({
    site: z.string().nullable(),
})
export type SiteRow = z.infer<typeof SiteRowSchema>

/** top-sites/route.ts — site grouped with its `::int`-cast coupon count. */
export const SiteCountRowSchema = z.object({
    site: z.string().nullable(),
    coupon_count: z.number(),
})
export type SiteCountRow = z.infer<typeof SiteCountRowSchema>

/** filters/route.ts's types half (`discount_type IS NOT NULL` in the WHERE). */
export const DiscountTypeRowSchema = z.object({
    discount_type: z.string(),
})
export type DiscountTypeRow = z.infer<typeof DiscountTypeRowSchema>

/** sources/route.ts GET — sources LEFT JOIN coupons, aggregated per source. */
export const SourceRowSchema = z.object({
    id: z.string(),
    source: z.string(),
    websites: z.array(z.string()),
    status: z.string(),
    total_coupons: z.number(),
    total_used: z.number(),
    total_expired: z.number(),
})
export type SourceRow = z.infer<typeof SourceRowSchema>

/** extension/supported-stores/route.ts — all 8 xpath fields are nullable at
 * the schema level even though that query's WHERE requires 5 of them
 * non-null: the schema describes the table shape, the WHERE clause is a
 * business filter on top of it, and keeping the schema itself unconditional
 * is more robust to that filter changing than duplicating its logic here. */
export const StoreConfigRowSchema = z.object({
    store_name: z.string(),
    show_input_xpath: z.string().nullable(),
    dismiss_button_xpath: z.string().nullable(),
    coupon_input_xpath: z.string().nullable(),
    apply_button_xpath: z.string().nullable(),
    price_container_xpath: z.string().nullable(),
    success_indicator_xpath: z.string().nullable(),
    error_indicator_xpath: z.string().nullable(),
    coupon_remove_xpath: z.string().nullable(),
})
export type StoreConfigRow = z.infer<typeof StoreConfigRowSchema>

/**
 * Parse raw couponsSql rows through `schema`, throwing loudly on the first
 * shape/type mismatch instead of letting malformed data reach a caller.
 * `queryLabel` identifies which query drifted (e.g. `'coupons.list'`) —
 * it's the only breadcrumb available once this throw reaches Sentry.
 *
 * ```ts
 * const rawCoupons = await couponsSql`SELECT id, code, ... FROM coupons`
 * const coupons = parseCouponRows(CouponListRowSchema, rawCoupons, 'coupons.list')
 * ```
 */
export function parseCouponRows<Output>(
    schema: z.ZodType<Output>,
    rows: unknown,
    queryLabel: string,
): Output[] {
    const result = z.array(schema).safeParse(rows)
    if (!result.success) {
        const issues = result.error.issues
            .map(
                issue =>
                    `${issue.path.join('.') || '(root)'}: ${issue.message}`,
            )
            .join('; ')
        throw new Error(`coupons-db schema drift [${queryLabel}]: ${issues}`)
    }
    return result.data
}

/** Liveness probe for /api/health/db (F-001) — mirrors prisma.$queryRaw`SELECT 1`. */
export async function pingCouponsDb(): Promise<void> {
    await couponsSql`SELECT 1`
}
