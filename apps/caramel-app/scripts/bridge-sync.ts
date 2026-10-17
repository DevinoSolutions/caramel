// scripts/bridge-sync.ts
//
// W4-D4 — the coupons BRIDGE SYNC job (the migration-period feed). Reads the
// still-live external, Python-owned `caramel_coupons` Postgres (STRICTLY
// read-only: SELECTs only, NEVER a write) and replays its catalog into the app's
// OWN published catalog (coupons / store_configs / sources in DATABASE_URL)
// through the SAME applyCatalogRows() engine POST /api/ingest/catalog uses — a
// pure only-if-newer delta upsert guarded by the >20% tombstone safety gate.
// Runs on a schedule (out-of-repo cron / Dokploy scheduled job) until the
// external Python pipeline is switched to push directly (a later workstream).
//
//   pnpm --filter caramel-app run bridge:sync   (needs COUPONS_DATABASE_URL set)
//
// COUPONS_DATABASE_URL is the read-only connection string to that external DB —
// OPTIONAL for the app itself (unset in local dev), REQUIRED for this job. It is
// read straight from process.env: @/lib/prisma imports only @prisma/client (no
// `server-only`, no @/lib/env), so importing applyCatalogRows does NOT boot the
// zod env — the bridge deliberately does not depend on the app's env schema.
//
// runBridge() takes the external client as an ARGUMENT so the integration test
// can drive the real end-to-end path (SELECT -> map -> applyCatalogRows -> app
// tables) against a local synthetic schema, with no real external DB. main()
// (invoked ONLY when this file is executed directly) opens the real read client,
// runs once, reports the counts, and exits non-zero + LOUD on any failure or a
// refused mass-tombstone — never a silent no-op.
import {
    applyCatalogRows,
    type ApplyResult,
} from '@/lib/catalog/applyCatalogRows'
import {
    buildIngestPayload,
    type ExternalCouponRow,
    type ExternalSourceRow,
    type ExternalStoreConfigRow,
} from '@/lib/catalog/bridgeMap'
import prisma from '@/lib/prisma'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'

/**
 * Read the external catalog through `externalSql` and replay it into the app
 * catalog via applyCatalogRows(). The three SELECTs are the VERBATIM pre-W4 read
 * queries (recovered from commit 20f82f8):
 *   - coupons: EVERY stored row (the app stores the whole catalog; visibility is
 *     a read-time filter);
 *   - store configs: the one best active + extension-compatible config per store
 *     (DISTINCT ON), carrying `cfg.updated_at` for only-if-newer;
 *   - sources: the stored source rows (no status filter, no aggregates).
 * `externalSql` is injected so the integration test can point it at a local
 * synthetic schema without the real external DB.
 */
export async function runBridge(
    externalSql: postgres.Sql,
    opts?: { force?: boolean },
): Promise<ApplyResult> {
    const coupons = await externalSql<ExternalCouponRow[]>`
        SELECT id, code, site, title, description, rating, discount_type,
               discount_amount, expiry, expired, times_used, last_time_used,
               status, verification_message, updated_at, created_at
        FROM coupons
    `

    const storeConfigs = await externalSql<ExternalStoreConfigRow[]>`
        SELECT DISTINCT ON (s.store_name)
            s.store_name,
            cfg.show_input_xpath, cfg.dismiss_button_xpath, cfg.coupon_input_xpath,
            cfg.apply_button_xpath, cfg.price_container_xpath, cfg.success_indicator_xpath,
            cfg.error_indicator_xpath, cfg.coupon_remove_xpath,
            cfg.updated_at
        FROM store_verification_configs cfg
        JOIN verification_stores s ON s.id = cfg.store_id
        WHERE cfg.is_active = TRUE
          AND cfg.coupon_input_xpath IS NOT NULL
          AND cfg.apply_button_xpath IS NOT NULL
          AND COALESCE(cfg.metadata->>'extension_compatible', 'true') <> 'false'
        ORDER BY s.store_name, cfg.priority DESC, cfg.updated_at DESC
    `

    const sources = await externalSql<ExternalSourceRow[]>`
        SELECT id, source, websites, status, updated_at, created_at
        FROM sources
    `

    const payload = buildIngestPayload({ coupons, storeConfigs, sources }, opts)
    return applyCatalogRows(payload)
}

async function main(): Promise<void> {
    const url = process.env.COUPONS_DATABASE_URL
    if (!url || url.trim() === '') {
        console.error(
            '[bridge-sync] COUPONS_DATABASE_URL is not set — the bridge has no ' +
                'external caramel_coupons DB to read from, so there is nothing to ' +
                'sync. This is a hard error, not a no-op: set COUPONS_DATABASE_URL ' +
                '(the read-only external Postgres connection string) and re-run. ' +
                'See apps/caramel-app/.env.example + RUNBOOK.md.',
        )
        process.exit(1)
    }

    // Read-only client to the external DB. prepare:false + a small pool: this is
    // a short-lived batch job, not a server. application_name tags it in pg_stat.
    const sql = postgres(url, {
        max: 5,
        idle_timeout: 20,
        connect_timeout: 10,
        prepare: false,
        connection: { application_name: 'caramel-bridge-sync' },
    })

    // TODO: thread a `--force` flag through to runBridge({ force: true }) for the
    // operator re-run after a gated mass-tombstone is confirmed legitimate. Left
    // out for now (argv parsing kept trivial); a human re-runs with force once
    // that path is actually needed.
    let exitCode = 0
    try {
        const result = await runBridge(sql)
        if (result.gated) {
            console.error(
                '[bridge-sync] REFUSED — tombstone gate tripped: this sync would ' +
                    `tombstone ${result.gate.wouldTombstone} of ${result.gate.visibleBefore} ` +
                    `currently-visible coupons (>${result.gate.thresholdPct}%). NOTHING was ` +
                    'written (the transaction rolled back). A human must confirm this ' +
                    'mass-expiry is legitimate and re-run with force.',
            )
            exitCode = 1
        } else {
            console.log(
                `[bridge-sync] OK — coupons: ${result.coupons.inserted} inserted, ` +
                    `${result.coupons.updated} updated, ${result.coupons.skippedOlder} skipped (older), ` +
                    `${result.coupons.skippedReferral} skipped (referral), ` +
                    `${result.coupons.tombstoned} tombstoned; storeConfigs: ` +
                    `${result.storeConfigs.upserted} upserted; sources: ` +
                    `${result.sources.upserted} upserted.`,
            )
            exitCode = 0
        }
    } catch (err) {
        // LOUD, never swallowed — the transaction already rolled back, so the
        // catalog is untouched; surface the real error and fail the job.
        console.error(
            '[bridge-sync] FAILED — the sync errored and wrote nothing:',
            err,
        )
        exitCode = 1
    } finally {
        // Close the read client and the prisma pool cleanly so a scheduled run
        // doesn't leak connections. process.exit is deliberately AFTER this
        // finally — calling it inside the try/catch would abort these awaits
        // before the connections drain.
        await sql.end({ timeout: 5 })
        await prisma.$disconnect()
    }

    process.exit(exitCode)
}

// Run main() ONLY when this file is executed directly (tsx scripts/bridge-sync.ts)
// — so the integration test can `import { runBridge }` without triggering any IO.
if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    void main()
}
