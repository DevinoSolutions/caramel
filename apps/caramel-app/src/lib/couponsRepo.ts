// lib/couponsRepo.ts
//
// The 10 coupon-catalog READS now run against the app's OWN published Prisma
// catalog (models Coupon/StoreConfig/Source, mapped to the coupons/
// store_configs/sources tables in DATABASE_URL) via `prisma.$queryRaw` —
// W4 of the Coupons Ownership Inversion. They deliberately use RAW SQL, not
// the Prisma query-builder: keeping the SELECT column list + aliases verbatim
// (`times_used AS "timesUsed"`, `verification_message AS "verificationMessage"`)
// means couponsDb.ts's zod row schemas + parseCouponRows() still parse every
// row unchanged, so the HTTP response shapes are byte-identical to the
// pre-W4 porsager reads. `findMany` would return camelCase model fields and
// break every schema — never use it here.
//
// Every read still zod-parses its rows through parseCouponRows() before
// returning, so a schema/type drift in the catalog throws loudly (→ Sentry
// via handleRouteError on API routes, → onRequestError on the SSR page)
// instead of silently serving malformed data. Every `::int` cast in an
// aggregate SELECT is preserved on purpose: `$queryRaw` maps Postgres
// int8/bigint → JS BigInt, which the `z.number()` count/stats schemas reject —
// the `::int` casts return int4 → JS `number`, so the casts are load-bearing.
//
// The sanctioned WRITES now run on the app's OWN Prisma tables too (W4-D2):
// expireCoupons UPDATEs the app `coupons` table and requestSource INSERTs an
// app `sources` row (both via `prisma.$executeRaw` / the Prisma query-builder,
// DATABASE_URL). The old incrementCouponUsage was RETIRED — usage telemetry
// moved OUT of the catalog into the app-owned coupon_signals table
// (couponSignals.recordUsage): an `UPDATE coupons SET times_used…` would bump
// the row's updated_at and freeze it under the ingest only-if-newer rule
// (RULING C′). No write touches the external `caramel_coupons` DB anymore.
//
// HTTP-only concerns stay OUT of this file by design: param parsing/caps,
// `getBaseDomain`/domain-validation 400s, response envelopes, cache
// headers, `hasMore`/`active` computed fields, and auth/rate-limit/origin
// gates all stay in the calling route (`withRoute` config + the route body).
import { VISIBLE_COUPON_STATUSES } from '@/lib/coupons'
import {
    type CouponListRow,
    CouponListRowSchema,
    type DiscountTypeRow,
    DiscountTypeRowSchema,
    type RecentStoreRow,
    RecentStoreRowSchema,
    type SiteCountRow,
    SiteCountRowSchema,
    type SiteRow,
    SiteRowSchema,
    type SourceRow,
    SourceRowSchema,
    type StatsRow,
    StatsRowSchema,
    type StoreConfigRow,
    StoreConfigRowSchema,
    TotalCountRowSchema,
    parseCouponRows,
} from '@/lib/couponsDb'
import prisma from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Coupon-domain SQL fragments (F-006), relocated here from couponsDb.ts as
// `Prisma.sql` fragments when the reads flipped onto the app-owned catalog
// (W4). Nested into a `$queryRaw` template via `${...}`, sql-template-tag
// inlines each fragment's text and merges its bound parameters into the parent
// query — so the composed query is still fully parameterized (injection-safe).
// Factories, not consts, purely to mirror the pre-W4 shape (a fragment is
// immutable data either way).

/**
 * The visibility predicate every listing read shares: verified,
 * restriction-tagged, AND not-yet-verified coupons (VISIBLE_COUPON_STATUSES),
 * excluding expired. `Prisma.join([...VISIBLE_COUPON_STATUSES])` expands to a
 * parameterized `?,?,...` list (our own constants, never user input).
 */
const visibleCouponsWhere = () =>
    Prisma.sql`status IN (${Prisma.join([...VISIBLE_COUPON_STATUSES])}) AND expired = FALSE`

/**
 * Shared ranking order — the list query and the marketing store page both sort
 * by this identical order.
 *
 * `id` is a TIEBREAKER, not a ranking signal, and it is load-bearing for
 * OFFSET pagination. `rating DESC, created_at DESC` alone is not a total order:
 * a store's coupons routinely share a rating (0 is the default) and can share a
 * created_at down to the ingest batch, and Postgres is free to return tied rows
 * in a different physical order per query. Two requests that differ only by
 * OFFSET are two separate queries, so a tied row could be returned by both
 * (a duplicate) or by neither (a row the shopper can never reach — the failure
 * mode a client-side dedupe cannot see). Appending the primary key makes the
 * sort total, so page N+1 resumes exactly where page N stopped.
 */
const rankingOrderSql = () => Prisma.sql`rating DESC, created_at DESC, id DESC`

/**
 * coupons/stats/route.ts's census predicate. Deliberately NOT
 * visibleCouponsWhere(): stats reports a trust census (total vs. expired)
 * among *verified* ('valid') coupons specifically, so it must INCLUDE
 * expired ones (to count them) and EXCLUDE pending/restricted ones (not
 * yet a verified fact) — the opposite shape from the visibility predicate.
 */
const verifiedCensusSql = () => Prisma.sql`status = 'valid'`

// ---------------------------------------------------------------------------
// Reads

export type ListCouponsOpts = {
    /** Already-resolved base domain (post getBaseDomain() — the route 400s before calling this on an invalid raw `site`). */
    baseSite?: string
    search?: string
    type?: string
    keyWords?: string
    limit: number
    skip: number
}

/** api/coupons/route.ts GET — the main paginated listing. */
export async function listCoupons(
    opts: ListCouponsOpts,
): Promise<{ coupons: CouponListRow[]; total: number }> {
    const { baseSite, search, type, keyWords, limit, skip } = opts

    // Visible-status predicate (verified, restriction-tagged, and
    // not-yet-verified coupons) — see lib/coupons.ts's
    // VISIBLE_COUPON_STATUSES doc comment for the full rationale.
    const conditions: Prisma.Sql[] = [visibleCouponsWhere()]

    if (baseSite) {
        conditions.push(
            Prisma.sql`(site = ${baseSite} OR site LIKE ${'%.' + baseSite})`,
        )
    }

    if (search) {
        const s = `%${search}%`
        conditions.push(
            Prisma.sql`(site ILIKE ${s} OR title ILIKE ${s} OR description ILIKE ${s} OR code ILIKE ${s})`,
        )
    }

    if (keyWords) {
        const patterns = keyWords
            .split(',')
            .map(k => `%${k.trim()}%`)
            .filter(k => k.length > 2)
        if (patterns.length > 0) {
            // Prisma's raw layer won't reliably bind a JS array to an
            // array-typed parameter, so build `ANY(ARRAY[?,?,...]::text[])`
            // explicitly (same pattern as catalog/applyCatalogRows.ts's
            // pgTextArray) instead of the porsager `ANY(${patterns})` form.
            conditions.push(
                Prisma.sql`description ILIKE ANY(ARRAY[${Prisma.join(patterns)}]::text[])`,
            )
        }
    }

    if (type && type !== 'all') {
        // Case-insensitive match: the external producer writes discount_type
        // in varying casing (the read boundary uppercase-normalizes it — see
        // couponsDb.ts's CouponListRowSchema), so a case-sensitive `=`
        // silently dropped lowercase rows (e.g. 'percentage') from filtered
        // listings. Normalize both sides.
        conditions.push(Prisma.sql`UPPER(discount_type) = UPPER(${type})`)
    }

    const whereClause = Prisma.join(conditions, ' AND ')

    const [rawCoupons, rawTotalRow] = await Promise.all([
        prisma.$queryRaw(Prisma.sql`
            SELECT id, code, site, title, description, rating,
                   discount_type, discount_amount, expiry, expired,
                   times_used AS "timesUsed",
                   status, verification_message AS "verificationMessage"
            FROM coupons
            WHERE ${whereClause}
            ORDER BY ${rankingOrderSql()}
            LIMIT ${limit} OFFSET ${skip}
        `),
        prisma.$queryRaw(
            Prisma.sql`SELECT COUNT(*)::int AS total FROM coupons WHERE ${whereClause}`,
        ),
    ])
    const coupons = parseCouponRows(
        CouponListRowSchema,
        rawCoupons,
        'coupons.list',
    )
    const totalRow = parseCouponRows(
        TotalCountRowSchema,
        rawTotalRow,
        'coupons.count',
    )

    return { coupons, total: totalRow[0]?.total ?? 0 }
}

/** (marketing)/coupons/[store]/page.tsx — SSR store page, fixed PAGE_SIZE, no pagination/search/type/keyword. */
export async function listStoreCoupons(
    baseSite: string,
    limit: number,
): Promise<{ coupons: CouponListRow[]; total: number }> {
    // Match /api/coupons: same visibility predicate, so SSR HTML and the
    // client fetch agree (no hydration flash) — see lib/coupons.ts's
    // VISIBLE_COUPON_STATUSES doc comment for the full rationale.
    const visible = visibleCouponsWhere()
    const [rawCoupons, rawTotalRow] = await Promise.all([
        prisma.$queryRaw(Prisma.sql`
            SELECT id, code, site, title, description, rating,
                   discount_type, discount_amount, expiry, expired,
                   times_used AS "timesUsed",
                   status, verification_message AS "verificationMessage"
            FROM coupons
            WHERE ${visible}
              AND (site = ${baseSite} OR site LIKE ${'%.' + baseSite})
            ORDER BY ${rankingOrderSql()}
            LIMIT ${limit}
        `),
        prisma.$queryRaw(Prisma.sql`
            SELECT COUNT(*)::int AS total FROM coupons
            WHERE ${visible}
              AND (site = ${baseSite} OR site LIKE ${'%.' + baseSite})
        `),
    ])
    const coupons = parseCouponRows(
        CouponListRowSchema,
        rawCoupons,
        'store-page.coupons',
    )
    const totalRow = parseCouponRows(
        TotalCountRowSchema,
        rawTotalRow,
        'store-page.count',
    )

    return { coupons, total: totalRow[0]?.total ?? 0 }
}

/** api/coupons/stats/route.ts GET — trust census (verifiedCensusSql, NOT visibleCouponsWhere — see the fragment doc comment). Falls back to a zeroed row (no `{total:0,expired:0}` shaping left for the route). */
export async function getCouponStats(): Promise<StatsRow> {
    const rawRows = await prisma.$queryRaw(Prisma.sql`
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE expired = TRUE)::int AS expired
        FROM coupons
        WHERE ${verifiedCensusSql()}
    `)
    const rows = parseCouponRows(StatsRowSchema, rawRows, 'coupons.stats')
    return rows[0] ?? { total: 0, expired: 0 }
}

/**
 * api/account/overview GET — live "12 codes right now" counts for the stores a
 * user follows, one query for the whole list.
 *
 * Lives here rather than in the account route for the same reason every other
 * catalog read does: it must share `visibleCouponsWhere()` and the
 * `site = store OR site LIKE '%.' || store` store-matching predicate with
 * listStoreCoupons, or the count under a favorite would disagree with the
 * store page that favorite links to. A second hand-written copy of either
 * predicate is exactly the F-006 drift this module exists to prevent.
 *
 * `stores` are already-normalized registrable domains (resolveStoreDomain
 * output, the same vocabulary favorite_stores.store_name stores). UNNEST turns
 * the array into rows so a LEFT JOIN can report a genuine 0 for a followed
 * store with no live codes — the caller distinguishes "0 codes" from "no count
 * available" and the UI renders neither as a placeholder.
 */
export async function countCouponsForStores(
    stores: string[],
): Promise<Map<string, number>> {
    if (stores.length === 0) return new Map()
    const rawRows = await prisma.$queryRaw(Prisma.sql`
        SELECT f.store AS site, COUNT(c.id)::int AS coupon_count
        FROM UNNEST(${stores}::text[]) AS f(store)
        LEFT JOIN coupons c
               ON (c.site = f.store OR c.site LIKE '%.' || f.store)
              AND ${visibleCouponsWhere()}
        GROUP BY f.store
    `)
    const rows = parseCouponRows(
        SiteCountRowSchema,
        rawRows,
        'account.favorite-counts',
    )
    const counts = new Map<string, number>()
    for (const row of rows) {
        if (row.site) counts.set(row.site, row.coupon_count)
    }
    return counts
}

/** api/coupons/stores/route.ts GET — store-name autocomplete; q-present/absent branch is a genuinely different query (ILIKE vs. no filter), not just an optional param. */
export async function listStoreOptions(
    q: string,
    limit: number,
): Promise<SiteRow[]> {
    const rawRows = q
        ? await prisma.$queryRaw(Prisma.sql`
              SELECT DISTINCT site FROM coupons
              WHERE ${visibleCouponsWhere()}
                AND (site ILIKE ${'%' + q + '%'} OR site ILIKE ${q + '%'})
              ORDER BY site ASC
              LIMIT ${limit}
          `)
        : await prisma.$queryRaw(Prisma.sql`
              SELECT DISTINCT site FROM coupons
              WHERE ${visibleCouponsWhere()}
              ORDER BY site ASC
              LIMIT ${limit}
          `)
    return parseCouponRows(SiteRowSchema, rawRows, 'coupons.stores')
}

/** api/coupons/filters/route.ts GET — sites half. The route's `includeSites` gate stays there (calls this only when true); this fn only owns its own `sitesLimit<=0` short-circuit. */
export async function listFilterSites(sitesLimit: number): Promise<SiteRow[]> {
    if (sitesLimit <= 0) return []
    // F-006 — unified to the same visibleCouponsWhere() predicate every
    // other coupon read route uses. Previously this route alone used a
    // narrower 'valid'-only + expired=FALSE filter, an accidental drift
    // that made these dropdowns under-represent sites/types whose
    // coupons are pending/restricted-but-real (visible in /api/coupons
    // and the store page, but absent from these filter options).
    // Deliberate, flagged behavior change: broadens the site/type
    // filter lists to match the listing they filter. Rollback (if ever
    // needed): swap visibleCouponsWhere() back to `status = 'valid'`
    // (+ `AND expired = FALSE`) in both queries below.
    const rawSites = await prisma.$queryRaw(Prisma.sql`
        SELECT DISTINCT site FROM coupons
        WHERE ${visibleCouponsWhere()} AND site IS NOT NULL
        ORDER BY site ASC
        LIMIT ${sitesLimit}
    `)
    return parseCouponRows(SiteRowSchema, rawSites, 'coupons.filters.sites')
}

/** api/coupons/filters/route.ts GET — types half, always runs (no gate). */
export async function listFilterDiscountTypes(): Promise<DiscountTypeRow[]> {
    const rawDiscountTypes = await prisma.$queryRaw(Prisma.sql`
        SELECT DISTINCT discount_type FROM coupons
        WHERE ${visibleCouponsWhere()} AND discount_type IS NOT NULL
    `)
    return parseCouponRows(
        DiscountTypeRowSchema,
        rawDiscountTypes,
        'coupons.filters.types',
    )
}

/** api/sites/top-sites/route.ts GET — fixed LIMIT 4, no `.filter(Boolean)` (pre-existing behavior, preserved as-is). */
export async function listTopSites(): Promise<SiteCountRow[]> {
    const rawRows = await prisma.$queryRaw(Prisma.sql`
        SELECT site, COUNT(*)::int AS coupon_count
        FROM coupons
        WHERE ${visibleCouponsWhere()}
        GROUP BY site
        ORDER BY coupon_count DESC
        LIMIT 4
    `)
    return parseCouponRows(SiteCountRowSchema, rawRows, 'sites.top-sites')
}

/**
 * supported-stores/page.tsx — the newest `limit` stores to become supported,
 * newest first. See RecentStoreRowSchema for why `store_configs.created_at` is
 * the signal and `MIN(coupons.created_at)` is not.
 *
 * The EXISTS gate is not decoration: `store_configs` and the page's store
 * universe are different populations (the page searches `coupons.site`, and
 * every tile links to `/coupons/<site>`), so a config whose store has no
 * visible coupons would render a tile that claims coupons and lands the
 * shopper on an empty page. Gating on the SAME visibility predicate every
 * other listing read uses keeps the two in step by construction. Measured on
 * prod: 28ms, index-only probes via `coupons_site_idx`, against the 145ms the
 * page's existing listTopSites read already costs — and the page issues both
 * concurrently, so first paint waits on the slower one, unchanged.
 *
 * Unqualified `status`/`expired` inside the subquery resolve to `coupons` (its
 * innermost FROM); `store_configs` has neither column, so there is nothing for
 * them to bind to in the outer scope either.
 */
export async function listRecentlyAddedStores(
    limit: number,
): Promise<RecentStoreRow[]> {
    const rawRows = await prisma.$queryRaw(Prisma.sql`
        SELECT sc.store_name, sc.created_at AS added_at
        FROM store_configs sc
        WHERE EXISTS (
            SELECT 1 FROM coupons c
            WHERE c.site = sc.store_name AND ${visibleCouponsWhere()}
        )
        ORDER BY sc.created_at DESC
        LIMIT ${limit}
    `)
    return parseCouponRows(
        RecentStoreRowSchema,
        rawRows,
        'sites.recently-added',
    )
}

/** api/sites/search-supported/route.ts POST — fixed LIMIT 20. The route's empty-query early return (`{sites:[]}` without querying) stays there; this fn assumes a non-empty `q`. */
export async function searchSupportedSites(q: string): Promise<SiteRow[]> {
    const rawRows = await prisma.$queryRaw(Prisma.sql`
        SELECT DISTINCT site FROM coupons
        WHERE ${visibleCouponsWhere()}
          AND (site ILIKE ${'%' + q + '%'} OR site ILIKE ${q + '%'})
        ORDER BY site ASC
        LIMIT 20
    `)
    return parseCouponRows(SiteRowSchema, rawRows, 'sites.search-supported')
}

/**
 * api/extension/supported-stores/route.ts GET — one row per store with the
 * xpaths the extension's apply engine needs. W4 remap (RULING B): the app's
 * `store_configs` is the FLATTENED published shape — one row per store_name,
 * the 8 xpaths as columns, and NONE of the pipeline-internal
 * is_active/priority/store_id/metadata that the pre-W4 external query joined
 * across store_verification_configs ⋈ verification_stores. That selection
 * logic (highest-priority active config, extension_compatible verdict) is
 * PRE-RESOLVED at ingest time, so this read is a plain one-row-per-store
 * projection. The only predicate kept is the business filter the extension
 * genuinely can't work without: coupon_input + apply_button non-null
 * (coupon-apply.js fills the input then clicks apply and bails with no
 * fallback if either is missing; the other xpaths all have generic fallbacks).
 * Still parses under StoreConfigRowSchema (identical column names).
 */
export async function listSupportedStoreConfigs(): Promise<StoreConfigRow[]> {
    const rawRows = await prisma.$queryRaw(Prisma.sql`
        SELECT store_name,
               show_input_xpath,
               dismiss_button_xpath,
               coupon_input_xpath,
               apply_button_xpath,
               price_container_xpath,
               success_indicator_xpath,
               error_indicator_xpath,
               coupon_remove_xpath
        FROM store_configs
        WHERE coupon_input_xpath IS NOT NULL
          AND apply_button_xpath IS NOT NULL
        ORDER BY store_name
    `)
    return parseCouponRows(
        StoreConfigRowSchema,
        rawRows,
        'extension.supported-stores',
    )
}

/**
 * api/sources/route.ts GET — the published `sources` rows (id/source/websites/
 * status), each LEFT JOINed to its coupons for the per-source aggregates.
 * sources owns no coupon-aggregate columns and there is no FK to coupons; the
 * one real relationship is sources.websites[] (the domains a source covers)
 * against coupons.site (each coupon's own domain) — an array-membership join,
 * not a scalar FK. A source with an empty/no-match websites[] correctly
 * aggregates to zero. Every aggregate keeps its `::int` cast so `$queryRaw`
 * returns JS `number`, not BigInt (which SourceRowSchema's z.number() rejects).
 */
export async function listActiveSources(): Promise<SourceRow[]> {
    const rawRows = await prisma.$queryRaw(Prisma.sql`
        SELECT
            s.id,
            s.source,
            s.websites,
            s.status,
            COALESCE(COUNT(c.id), 0)::int AS total_coupons,
            COALESCE(SUM(c.times_used), 0)::int AS total_used,
            COALESCE(SUM(CASE WHEN c.expired THEN 1 ELSE 0 END), 0)::int AS total_expired
        FROM sources s
        LEFT JOIN coupons c ON c.site = ANY(s.websites)
        WHERE s.status = 'ACTIVE'
        GROUP BY s.id, s.source, s.websites, s.status
    `)
    return parseCouponRows(SourceRowSchema, rawRows, 'sources.list')
}

// ---------------------------------------------------------------------------
// Writes — the sanctioned mutations of the app-owned published catalog (W4-D2).
// They run on the app's OWN Postgres (DATABASE_URL) via prisma, NOT the external
// read-only caramel_coupons DB. No zod on these: they preserve the pre-existing
// plain-count (expire) / void (sources insert) shapes rather than introducing
// new validation as a drive-by. (incrementCouponUsage was retired — usage
// telemetry now lives in couponSignals.recordUsage; see RULING C′.)

/**
 * api/coupons/expire/route.ts POST — bulk-expire, COUPONS_ADMIN_SECRET-gated.
 * Caller has already deduped/validated/capped `ids` (numeric strings — the app
 * Coupon.id is a string). `$executeRaw` returns the affected-row count directly,
 * which — with the `AND expired = FALSE` guard — is exactly the number of
 * FALSE→TRUE transitions (the old RETURNING-id `rows.length` semantics).
 *
 * The `updated_at = NOW()` bump is the deliberate admin-override "last-writer-
 * wins": a later pipeline push carrying an OLDER updated_at won't un-expire the
 * row under the ingest only-if-newer rule (intended). `IN ()` is invalid SQL, so
 * an empty `ids` short-circuits to 0 (the route also guards this).
 */
export async function expireCoupons(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const affected = await prisma.$executeRaw(Prisma.sql`
        UPDATE coupons
        SET expired = TRUE,
            expiry = NOW()::text,
            updated_at = NOW()
        WHERE id IN (${Prisma.join(ids)}) AND expired = FALSE
    `)
    return affected
}

/**
 * api/sources/route.ts POST — "request a store"; caller has already validated
 * `website` is a plausible domain. Inserts an app `sources` row in the same
 * REQUESTED shape the pipeline uses (empty websites[]). `Source.id` has no DB
 * default, so mint a uuid app-side (mirrors the pre-W4 gen_random_uuid()::text);
 * created_at/updated_at fill via their @default(now()).
 */
export async function requestSource(website: string): Promise<void> {
    await prisma.source.create({
        data: {
            id: randomUUID(),
            source: website,
            websites: [],
            status: 'REQUESTED',
        },
    })
}
