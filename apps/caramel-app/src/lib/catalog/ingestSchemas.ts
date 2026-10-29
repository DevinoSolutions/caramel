// src/lib/catalog/ingestSchemas.ts
//
// W3b — the WRITE contract for the app-owned published catalog. These zod
// schemas validate the body of POST /api/ingest/catalog (the trusted supplier
// push) and, later, the W4 bridge that replays the external catalog through the
// same applyCatalogRows() engine. They describe the INGEST shape (what a
// producer may send), which mirrors the `coupons` / `store_configs` / `sources`
// TABLE columns (prisma/schema.prisma + the catalog_tables migration), NOT the
// tighter READ projections in couponsDb.ts.
//
// Deliberate nullability rule: a field is `.nullable()` here exactly when the
// TABLE column is nullable (per the migration), even where a specific READ query
// in couponsDb.ts tightens it (e.g. CouponListRowSchema.site is non-null because
// that query only selects sited coupons — the column itself is nullable, so
// ingest accepts null). Values are stored RAW: discount_type/status stay open
// strings and are NEVER normalized here (uppercasing discount_type is a W4 READ
// concern; the pipeline's own values are the source of truth on write).
//
// snake_case keys throughout: they are the payload wire format and map 1:1 to
// the SQL column names applyCatalogRows.ts writes, so there is no silent
// rename layer between the producer and the INSERT.
import { SHOPPER_COUPON_ID_FLOOR } from '@/lib/shopperCoupons'
import { z } from 'zod'

// Coupon ids are pipeline bigints; every id-taking route in this app
// (coupons/[id]/report, coupons/increment, coupons/expire) enforces the same
// /^\d{1,18}$/ integer shape. Reuse couponsDb.ts's couponIdSchema idea
// (accept string|number, normalize to string) but ALSO constrain to that shape
// via `.pipe()` so a garbage id is rejected at the write boundary (a bad id
// would otherwise become a permanent, un-addressable catalog row).
const ingestCouponIdSchema = z
    .union([z.string(), z.number()])
    .transform(value => String(value))
    .pipe(
        z
            .string()
            .regex(/^\d{1,18}$/, { error: 'coupon id must be 1-18 digits' }),
    )
    // A SECOND pipe stage, so it only ever sees an id the regex accepted (BigInt
    // throws on a non-numeric string). Ids from SHOPPER_COUPON_ID_FLOOR up are
    // minted by the app's shopper_coupon_id_seq (submitShopperCoupon); a supplier
    // row in that range could be upserted over a shopper's row, so refuse it
    // here, at the write boundary, before any SQL runs.
    .pipe(
        z.string().refine(id => BigInt(id) < SHOPPER_COUPON_ID_FLOOR, {
            error: 'coupon id is in the reserved shopper range',
        }),
    )

// One coupon row = the `coupons` table columns. `updated_at` is the ONLY
// mandatory timestamp: it is the only-if-newer ordering key applyCatalogRows
// uses, so a row without it can't be ordered against the stored row and is
// rejected outright (rather than silently defaulting and clobbering fresher
// data). `created_at` is set on INSERT only and defaults to now() when omitted.
const IngestCouponSchema = z.object({
    id: ingestCouponIdSchema,
    code: z.string(),
    // Column is nullable (migration: `site TEXT`) — the read projection's
    // non-null site is a per-query guarantee, not a table constraint.
    site: z.string().nullable(),
    title: z.string(),
    description: z.string(),
    // numeric/int columns arrive from many producers as strings or numbers;
    // coerce and default like the read boundary does. rating defaults to 0
    // (the column default) when the producer hasn't rated the coupon yet.
    rating: z.coerce.number().default(0),
    // OPEN string, RAW — no enum, no transform. The Python producer extends
    // this vocabulary ('PERCENTAGE'/'CASH'/'fixed'/lowercase/null) freely.
    discount_type: z.string().nullable(),
    discount_amount: z.coerce.number().nullable(),
    // TEXT column (the pipeline writes free-form / NOW()::text values), never a
    // real DateTime — kept as a string.
    expiry: z.string().nullable(),
    expired: z.boolean().default(false),
    // int4 column. Validated as a non-negative integer but NOT clamped to the
    // int4 max: the contract is "values already fit int4", and the DB is the
    // authority that enforces it (an out-of-range value fails the INSERT loudly
    // inside the transaction rather than being silently truncated here).
    times_used: z.coerce.number().int().nonnegative().default(0),
    // Optional + nullable → Date | null | undefined; applyCatalogRows writes
    // `?? null` so an omitted value becomes a SQL NULL.
    last_time_used: z.coerce.date().nullable().optional(),
    // OPEN string, required (a coupon always has a lifecycle status).
    status: z.string(),
    verification_message: z.string().nullable(),
    created_at: z.coerce.date().optional(),
    updated_at: z.coerce.date(),
    // "New customers only" label (owner decision 2026-10-19). OPTIONAL, and
    // absent or null means "no opinion": applyCatalogRows keeps the stored
    // value, so a producer that does not know the flag never clears one the
    // app set. An explicit false clears it.
    new_customers_only: z.boolean().nullable().optional(),
})

// One flattened store apply-config = the `store_configs` table (PK store_name).
// All 8 xpath fields are nullable AND optional: the table columns are nullable,
// and a producer may push a partial config (only the fields it re-derived).
const IngestStoreConfigSchema = z.object({
    store_name: z.string().min(1),
    show_input_xpath: z.string().nullable().optional(),
    dismiss_button_xpath: z.string().nullable().optional(),
    coupon_input_xpath: z.string().nullable().optional(),
    apply_button_xpath: z.string().nullable().optional(),
    price_container_xpath: z.string().nullable().optional(),
    success_indicator_xpath: z.string().nullable().optional(),
    error_indicator_xpath: z.string().nullable().optional(),
    coupon_remove_xpath: z.string().nullable().optional(),
    // Optional: store_configs carry no mandatory ordering key. When omitted,
    // applyCatalogRows coalesces to now() (last-write-wins) — see its comment.
    updated_at: z.coerce.date().optional(),
    created_at: z.coerce.date().optional(),
})

// One source row = the STORED `sources` columns (PK id — a UUID/text, NOT the
// numeric coupon-id shape). The read-time aggregates (total_coupons/…) are
// computed by a JOIN, never stored, so they're absent here.
const IngestSourceSchema = z.object({
    id: z.string().min(1),
    source: z.string(),
    websites: z.array(z.string()).default([]),
    status: z.string(),
    updated_at: z.coerce.date().optional(),
    created_at: z.coerce.date().optional(),
})

// Request-body ceiling for POST /api/ingest/catalog (withRoute maxBodyBytes),
// the one route that takes a bulk push. It equals the ceiling Next itself
// enforces on EVERY request body (next.config `experimental.proxyClientMaxBodySize`,
// 4mb): past that, Next truncates the body before any route sees it, so a
// larger number here would be a claim nothing honours. tests/unit/
// withRoute-body-cap.test.ts reads next.config and fails if the two drift.
// Sized from the real producer, measured 2026-10-20 (next.config comment): the
// coupon pipeline pushes in chunks, a 1000-row store-config chunk is ~0.45 MB
// (1 MB worst case), so 4 MiB keeps ~4x headroom. A push of more rows than that
// in ONE request must be split by the producer (applyCatalogRows itself has no
// row limit; its design maximum is 23k coupons, docs/INGEST.md). The cap sits
// behind the INGEST_API_KEY bearer, so only the supplier (or a leaked key) can
// reach it.
export const INGEST_CATALOG_MAX_BODY_BYTES = 4 * 1024 * 1024

// Array ceilings: ~4x the 23k design maximum for coupons, and far above any
// real store/source count. They bound the work one push can ask for.
const INGEST_COUPONS_MAX = 100_000
const INGEST_STORE_CONFIGS_MAX = 50_000
const INGEST_SOURCES_MAX = 50_000

// The whole push. Each array defaults to [] so a producer can send only the
// entity it changed (coupons-only, sources-only, …). `force` bypasses the
// tombstone sanity gate (see applyCatalogRows). The `.refine` rejects a
// fully-empty payload as 422 rather than accepting it as a silent no-op — an
// empty push is almost always a producer bug, and surfacing it loudly is the
// point of the whole "no silent failures" rule.
export const IngestCatalogPayloadSchema = z
    .object({
        coupons: z
            .array(IngestCouponSchema)
            .max(INGEST_COUPONS_MAX)
            .default([]),
        storeConfigs: z
            .array(IngestStoreConfigSchema)
            .max(INGEST_STORE_CONFIGS_MAX)
            .default([]),
        sources: z
            .array(IngestSourceSchema)
            .max(INGEST_SOURCES_MAX)
            .default([]),
        force: z.boolean().default(false),
    })
    .refine(
        payload =>
            payload.coupons.length +
                payload.storeConfigs.length +
                payload.sources.length >
            0,
        {
            error: 'Ingest payload is empty — provide at least one coupons/storeConfigs/sources row',
        },
    )

/** Parsed ingest push — the input contract for applyCatalogRows() and the
 * POST /api/ingest/catalog route body. */
export type IngestCatalogPayload = z.infer<typeof IngestCatalogPayloadSchema>
