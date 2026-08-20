// lib/couponsDb.ts
//
// The published coupon catalog's zod ROW SCHEMAS + parseCouponRows() — the
// runtime-validated READ BOUNDARY every coupon read in couponsRepo.ts flows
// through. This module owns NO database connection: since W4 the catalog lives
// in the app's OWN Postgres (DATABASE_URL), read via `prisma.$queryRaw` in
// couponsRepo.ts (the 3 sanctioned WRITES flipped onto Prisma there too). The
// external, Python-owned caramel_coupons Postgres and its porsager
// `couponsSql` client were retired in W4-D3, together with the whole local
// "degraded mode" — the app serves its own migrated + seeded (and, once wired,
// bridge-synced) catalog.
//
// Every read still parses its raw rows through parseCouponRows() before the
// data reaches a caller, so a schema/type drift in the catalog throws loudly
// (→ Sentry via handleRouteError on API routes, → onRequestError on the SSR
// page) instead of silently serving malformed/zeroed data. See
// DESIGN.md §2 "Write-ownership" for the catalog coordination contract.
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Runtime-validated read boundary (F-001).
//
// The reads are untyped raw SQL (`prisma.$queryRaw` against the app catalog) —
// prior porsager call sites papered over that with a TS generic
// (`couponsSql<Array<{site:string}>>`), a compile-time cast with zero runtime
// enforcement (top-sites even omitted `coupon_count` from its generic while
// selecting it). These schemas replace those casts: every read call site parses
// its raw rows through parseCouponRows() before touching the data, so a
// schema/type drift in the catalog throws loudly (→ Sentry via handleRouteError
// on API routes, → onRequestError on the SSR page) instead of silently serving
// malformed/zeroed data.
//
// Traps mirrored here (raw-query-driver RUNTIME types, not the DB's nominal
// column types — the schemas were built against porsager's and still coerce
// defensively under Prisma `$queryRaw`):
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

/**
 * supported-stores/page.tsx's "Recently added" strip — one row per store that
 * has just become supported, newest first.
 *
 * `added_at` is `store_configs.created_at`, which is the ONLY honest
 * "became supported" signal in this catalog. The obvious alternative,
 * `MIN(coupons.created_at)` per site, is not one: 18,311 coupon rows across
 * 1,013 sites share the single instant `2026-05-13 01:40:42.656` (the catalog
 * seed import), so it would date a third of the catalog to one meaningless
 * moment. `store_configs.created_at` has zero rows at that instant, spreads
 * hour-by-hour across the pipeline's discovery runs, and is INSERT-only —
 * applyCatalogRows.ts's `ON CONFLICT (store_name) DO UPDATE` never assigns it,
 * so a re-publish of an existing store cannot make an old store look new.
 *
 * `z.coerce.date()` rather than `z.date()`: `$queryRaw` returns a JS `Date` for
 * a `timestamp(3)` column today, and coercion keeps the read working if a
 * driver ever hands the same column back as an ISO string — a shape this
 * boundary can safely normalize rather than a drift it should throw on.
 */
export const RecentStoreRowSchema = z.object({
    store_name: z.string(),
    added_at: z.coerce.date(),
})
export type RecentStoreRow = z.infer<typeof RecentStoreRowSchema>

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
 * Parse raw catalog rows through `schema`, throwing loudly on the first
 * shape/type mismatch instead of letting malformed data reach a caller.
 * `queryLabel` identifies which query drifted (e.g. `'coupons.list'`) —
 * it's the only breadcrumb available once this throw reaches Sentry.
 *
 * ```ts
 * const rawCoupons = await prisma.$queryRaw(Prisma.sql`SELECT id, code, ... FROM coupons`)
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
