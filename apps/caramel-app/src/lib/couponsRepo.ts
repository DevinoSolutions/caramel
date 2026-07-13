// lib/couponsRepo.ts
//
// The application queries against `caramel_coupons` — 13 named read/write
// fns built on couponsDb.ts's boundary primitives (connection, SQL fragment
// factories, zod row schemas, parseCouponRows). Every route that touches
// the coupons DB calls a fn here instead of writing inline `couponsSql`
// SQL — this is now the ONE place that SQL text lives, so a query can be
// found, reasoned about, and drift-checked in one file instead of scattered
// across 10 route files + 1 SSR page.
//
// Every fn takes an OPTIONAL trailing `sql` executor (defaults to the
// module `couponsSql`) so the drift gate (tests/drift/coupons-schema.drift.ts)
// can thread a single rolled-back transaction through every probe without
// ever touching real data — see `couponsQueryProbes` at the bottom of this
// file. The couponsDb.ts-exported fragment factories (`visibleCouponsWhere`,
// `rankingOrderSql`, `verifiedCensusSql`) are NOT re-parameterized: they
// always close over the module `couponsSql` (they always have — see
// couponsDb.ts's own doc comment), which is safe because a fragment is
// inert data until the OUTER tagged-template call (on the injected `sql`)
// actually executes it — never awaited standalone.
//
// HTTP-only concerns stay OUT of this file by design: param parsing/caps,
// `getBaseDomain`/domain-validation 400s, response envelopes, cache
// headers, `hasMore`/`active` computed fields, and auth/rate-limit/origin
// gates all stay in the calling route (`withRoute` config + the route body)
// exactly as before this file existed — see PLAN-COUPONS-BOUNDARY.md's
// "Call-site edit pattern" for the full split.
import {
    type CouponListRow,
    CouponListRowSchema,
    type DiscountTypeRow,
    DiscountTypeRowSchema,
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
    couponsSql,
    parseCouponRows,
    rankingOrderSql,
    verifiedCensusSql,
    visibleCouponsWhere,
} from '@/lib/couponsDb'

/** Any executor a query fn can run on — the module singleton by default, or a `couponsSql.begin()` transaction (cast by the caller — see the drift gate). */
export type Sql = typeof couponsSql

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
    sql: Sql = couponsSql,
): Promise<{ coupons: CouponListRow[]; total: number }> {
    const { baseSite, search, type, keyWords, limit, skip } = opts

    // Visible-status predicate (verified, restriction-tagged, and
    // not-yet-verified coupons) — see lib/coupons.ts's
    // VISIBLE_COUPON_STATUSES doc comment for the full rationale.
    const conditions = [visibleCouponsWhere()]

    if (baseSite) {
        conditions.push(
            sql`(site = ${baseSite} OR site LIKE ${'%.' + baseSite})`,
        )
    }

    if (search) {
        const s = `%${search}%`
        conditions.push(
            sql`(site ILIKE ${s} OR title ILIKE ${s} OR description ILIKE ${s} OR code ILIKE ${s})`,
        )
    }

    if (keyWords) {
        const patterns = keyWords
            .split(',')
            .map(k => `%${k.trim()}%`)
            .filter(k => k.length > 2)
        if (patterns.length > 0) {
            conditions.push(sql`description ILIKE ANY(${patterns})`)
        }
    }

    if (type && type !== 'all') {
        conditions.push(sql`discount_type = ${type}`)
    }

    const whereClause = conditions.reduce(
        (acc, cond) => sql`${acc} AND ${cond}`,
    )

    const [rawCoupons, rawTotalRow] = await Promise.all([
        sql`
            SELECT id, code, site, title, description, rating,
                   discount_type, discount_amount, expiry, expired,
                   times_used AS "timesUsed",
                   status, verification_message AS "verificationMessage"
            FROM coupons
            WHERE ${whereClause}
            ORDER BY ${rankingOrderSql()}
            LIMIT ${limit} OFFSET ${skip}
        `,
        sql`SELECT COUNT(*)::int AS total FROM coupons WHERE ${whereClause}`,
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
    sql: Sql = couponsSql,
): Promise<{ coupons: CouponListRow[]; total: number }> {
    // Match /api/coupons: same visibility predicate, so SSR HTML and the
    // client fetch agree (no hydration flash) — see lib/coupons.ts's
    // VISIBLE_COUPON_STATUSES doc comment for the full rationale.
    const VISIBLE_STATUSES = visibleCouponsWhere()
    const [rawCoupons, rawTotalRow] = await Promise.all([
        sql`
            SELECT id, code, site, title, description, rating,
                   discount_type, discount_amount, expiry, expired,
                   times_used AS "timesUsed",
                   status, verification_message AS "verificationMessage"
            FROM coupons
            WHERE ${VISIBLE_STATUSES}
              AND (site = ${baseSite} OR site LIKE ${'%.' + baseSite})
            ORDER BY ${rankingOrderSql()}
            LIMIT ${limit}
        `,
        sql`
            SELECT COUNT(*)::int AS total FROM coupons
            WHERE ${VISIBLE_STATUSES}
              AND (site = ${baseSite} OR site LIKE ${'%.' + baseSite})
        `,
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

/** api/coupons/stats/route.ts GET — trust census (verifiedCensusSql, NOT visibleCouponsWhere — see couponsDb.ts's doc comment). Falls back to a zeroed row (no `{total:0,expired:0}` shaping left for the route). */
export async function getCouponStats(sql: Sql = couponsSql): Promise<StatsRow> {
    const rawRows = await sql`
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE expired = TRUE)::int AS expired
        FROM coupons
        WHERE ${verifiedCensusSql()}
    `
    const rows = parseCouponRows(StatsRowSchema, rawRows, 'coupons.stats')
    return rows[0] ?? { total: 0, expired: 0 }
}

/** api/coupons/stores/route.ts GET — store-name autocomplete; q-present/absent branch is a genuinely different query (ILIKE vs. no filter), not just an optional param. */
export async function listStoreOptions(
    q: string,
    limit: number,
    sql: Sql = couponsSql,
): Promise<SiteRow[]> {
    const rawRows = q
        ? await sql`
              SELECT DISTINCT site FROM coupons
              WHERE ${visibleCouponsWhere()}
                AND (site ILIKE ${'%' + q + '%'} OR site ILIKE ${q + '%'})
              ORDER BY site ASC
              LIMIT ${limit}
          `
        : await sql`
              SELECT DISTINCT site FROM coupons
              WHERE ${visibleCouponsWhere()}
              ORDER BY site ASC
              LIMIT ${limit}
          `
    return parseCouponRows(SiteRowSchema, rawRows, 'coupons.stores')
}

/** api/coupons/filters/route.ts GET — sites half. The route's `includeSites` gate stays there (calls this only when true); this fn only owns its own `sitesLimit<=0` short-circuit. */
export async function listFilterSites(
    sitesLimit: number,
    sql: Sql = couponsSql,
): Promise<SiteRow[]> {
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
    const rawSites = await sql`
        SELECT DISTINCT site FROM coupons
        WHERE ${visibleCouponsWhere()} AND site IS NOT NULL
        ORDER BY site ASC
        LIMIT ${sitesLimit}
    `
    return parseCouponRows(SiteRowSchema, rawSites, 'coupons.filters.sites')
}

/** api/coupons/filters/route.ts GET — types half, always runs (no gate). */
export async function listFilterDiscountTypes(
    sql: Sql = couponsSql,
): Promise<DiscountTypeRow[]> {
    const rawDiscountTypes = await sql`
        SELECT DISTINCT discount_type FROM coupons
        WHERE ${visibleCouponsWhere()} AND discount_type IS NOT NULL
    `
    return parseCouponRows(
        DiscountTypeRowSchema,
        rawDiscountTypes,
        'coupons.filters.types',
    )
}

/** api/sites/top-sites/route.ts GET — fixed LIMIT 4, no `.filter(Boolean)` (pre-existing behavior, preserved as-is). */
export async function listTopSites(
    sql: Sql = couponsSql,
): Promise<SiteCountRow[]> {
    const rawRows = await sql`
        SELECT site, COUNT(*)::int AS coupon_count
        FROM coupons
        WHERE ${visibleCouponsWhere()}
        GROUP BY site
        ORDER BY coupon_count DESC
        LIMIT 4
    `
    return parseCouponRows(SiteCountRowSchema, rawRows, 'sites.top-sites')
}

/** api/sites/search-supported/route.ts POST — fixed LIMIT 20. The route's empty-query early return (`{sites:[]}` without querying) stays there; this fn assumes a non-empty `q`. */
export async function searchSupportedSites(
    q: string,
    sql: Sql = couponsSql,
): Promise<SiteRow[]> {
    const rawRows = await sql`
        SELECT DISTINCT site FROM coupons
        WHERE ${visibleCouponsWhere()}
          AND (site ILIKE ${'%' + q + '%'} OR site ILIKE ${q + '%'})
        ORDER BY site ASC
        LIMIT 20
    `
    return parseCouponRows(SiteRowSchema, rawRows, 'sites.search-supported')
}

/** api/extension/supported-stores/route.ts GET — one row per store, highest-priority active config with the 2 xpaths the extension's apply engine genuinely cannot work without. */
export async function listSupportedStoreConfigs(
    sql: Sql = couponsSql,
): Promise<StoreConfigRow[]> {
    const rawRows = await sql`
        SELECT DISTINCT ON (s.store_name)
            s.store_name,
            cfg.show_input_xpath,
            cfg.dismiss_button_xpath,
            cfg.coupon_input_xpath,
            cfg.apply_button_xpath,
            cfg.price_container_xpath,
            cfg.success_indicator_xpath,
            cfg.error_indicator_xpath,
            cfg.coupon_remove_xpath
        FROM store_verification_configs cfg
        JOIN verification_stores s ON s.id = cfg.store_id
        WHERE cfg.is_active = TRUE
          -- Require only the 2 fields the extension's apply engine
          -- (coupon-apply.js) genuinely cannot work without: it fills
          -- coupon_input then clicks apply_button, and bails early with
          -- no fallback if either is missing/hidden. The other 3 xpaths
          -- this predicate used to require ALL have generic fallbacks in
          -- the apply engine (findAppliedSelector/detectCouponError/
          -- findRemoveSelector -> GENERIC_APPLIED_SELECTORS /
          -- GENERIC_ERROR_TEXT_RE / GENERIC_REMOVE_SELECTORS), so
          -- requiring them here was over-strict: it silently excluded
          -- ~25% of active configs — including the 3 demo stores
          -- (ebay.com/amazon.com/codecademy.com) — that the generic
          -- engine can actually drive fine (E2E report D1).
          AND cfg.coupon_input_xpath      IS NOT NULL
          AND cfg.apply_button_xpath      IS NOT NULL
          -- Honor the agent's extension_compatible verdict. Stores like
          -- christianbook.com have full xpaths but they live on the
          -- checkout page, not the entry_url cart page — the extension
          -- can't reach them. Agent / manual review sets this to false
          -- when it observes that selectors don't render at entry_url.
          AND COALESCE(cfg.metadata->>'extension_compatible', 'true') <> 'false'
        ORDER BY s.store_name, cfg.priority DESC, cfg.updated_at DESC
    `
    return parseCouponRows(
        StoreConfigRowSchema,
        rawRows,
        'extension.supported-stores',
    )
}

/**
 * api/sources/route.ts GET — coupons has no source_id column — never did
 * (verified against the live coupons DB schema: `\d coupons`). This route
 * 500'd on every call before this join was fixed. sources doesn't own its
 * own coupon-aggregate columns either (only id/source/websites/status/
 * created_at/updated_at — verified via `\d sources`), and there is no FK
 * between the two tables. The one real, schema-grounded relationship is
 * sources.websites[] (the domains a source covers, populated out-of-band
 * once a REQUESTED source is approved — requestSource() below inserts it
 * empty) against coupons.site (each coupon's own domain) — an
 * array-membership join, not a scalar FK. A source with an empty/no-match
 * websites[] simply, correctly, aggregates to zero.
 */
export async function listActiveSources(
    sql: Sql = couponsSql,
): Promise<SourceRow[]> {
    const rawRows = await sql`
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
    `
    return parseCouponRows(SourceRowSchema, rawRows, 'sources.list')
}

// ---------------------------------------------------------------------------
// Writes — the 3 sanctioned exceptions to "coupons DB is read-only by
// discipline" (see couponsDb.ts's header + CLAUDE.md's Hard boundaries).
// No zod on these: they preserve the pre-existing untyped passthrough
// (increment) / plain-count (expire) / void (sources insert) shapes rather
// than introducing new validation as a drive-by.

/** api/coupons/increment/route.ts POST — usage counter, extension-facing. */
export async function incrementCouponUsage(
    id: number,
    sql: Sql = couponsSql,
): Promise<Record<string, unknown> | undefined> {
    const rows = await sql`
        UPDATE coupons
        SET times_used = times_used + 1,
            last_time_used = NOW(),
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING id, code, site,
                  times_used AS "timesUsed",
                  last_time_used AS "last_time_used"
    `
    return rows[0]
}

/** api/coupons/expire/route.ts POST — bulk-expire, COUPONS_ADMIN_SECRET-gated. Caller is expected to have already deduped/validated/capped `ids`. */
export async function expireCoupons(
    ids: number[],
    sql: Sql = couponsSql,
): Promise<number> {
    const rows = await sql`
        UPDATE coupons
        SET expired = TRUE,
            expiry = NOW()::text,
            updated_at = NOW()
        WHERE id = ANY(${ids}) AND expired = FALSE
        RETURNING id
    `
    return rows.length
}

/** api/sources/route.ts POST — "request a store"; caller has already validated `website` is a plausible domain. */
export async function requestSource(
    website: string,
    sql: Sql = couponsSql,
): Promise<void> {
    await sql`
        INSERT INTO sources (id, source, websites, status, created_at, updated_at)
        VALUES (
            gen_random_uuid()::text,
            ${website},
            ${[] as string[]},
            'REQUESTED',
            NOW(),
            NOW()
        )
    `
}

// ---------------------------------------------------------------------------
// Structural drift gate registry (replaces the old hand-typed
// EXPECTED_COLUMNS mirror — see tests/drift/coupons-schema.drift.ts). Every
// registered query runs for real against the live/clone DB; Postgres plans
// every column/table/predicate before returning rows, so a missing/renamed
// column throws regardless of row count — the queries themselves are the
// only contract, the DB the only source of truth. Nothing schema-descriptive
// is committed here. Sentinel params (id 0, 'drift-probe*' strings) are
// chosen to match zero real rows for the routes that accept a caller value,
// so read probes are non-mutating by construction and write probes are
// wrapped in the gate's own rolled-back transaction.
export const couponsQueryProbes: ReadonlyArray<{
    label: string
    write?: boolean
    run: (sql: Sql) => Promise<unknown>
}> = [
    // Bare {limit:1,skip:0} — the plan's original probe, exercising the
    // real default /api/coupons path (no site/search/type/keyword filter).
    // An earlier executor had temporarily pinned `type:'PERCENTAGE'` here
    // instead, to dodge a real ~86-row data-quality slice (lowercase/4th-
    // value/null discount_type, null expiry — see couponsDb.ts's
    // CouponListRowSchema comment) that the old, over-strict enum schema
    // flagged as drift; since that slice sorts to the very top of the
    // unfiltered listing (`ORDER BY rating DESC` puts NULLS FIRST), the
    // dodge was actually masking a live 500 on page 1 of the real
    // production listing. Now that CouponListRowSchema itself tolerates
    // that vocabulary, the dodge is no longer needed — reverted to bare so
    // this probe exercises the same query real users hit, still getting a
    // real row and the full zod numeric/id coercion path.
    {
        label: 'coupons.list',
        run: s => listCoupons({ limit: 1, skip: 0 }, s),
    },
    {
        label: 'store-page.coupons',
        run: s => listStoreCoupons('drift-probe.invalid', 1, s),
    },
    { label: 'coupons.stats', run: s => getCouponStats(s) },
    {
        label: 'coupons.stores',
        run: s => listStoreOptions('drift-probe', 1, s),
    },
    { label: 'coupons.filters.sites', run: s => listFilterSites(1, s) },
    { label: 'coupons.filters.types', run: s => listFilterDiscountTypes(s) },
    { label: 'sites.top-sites', run: s => listTopSites(s) },
    {
        label: 'sites.search-supported',
        run: s => searchSupportedSites('drift-probe', s),
    },
    {
        label: 'extension.supported-stores',
        run: s => listSupportedStoreConfigs(s),
    },
    { label: 'sources.list', run: s => listActiveSources(s) },
    {
        label: 'coupons.increment',
        write: true,
        run: s => incrementCouponUsage(0, s),
    },
    {
        label: 'coupons.expire',
        write: true,
        run: s => expireCoupons([0], s),
    },
    {
        label: 'sources.insert',
        write: true,
        run: s => requestSource('drift-probe.invalid', s),
    },
]
