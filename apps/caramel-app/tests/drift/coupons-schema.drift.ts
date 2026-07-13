import { couponsSql } from '@/lib/couponsDb'
import { type Sql, couponsQueryProbes } from '@/lib/couponsRepo'
import { describe, it } from 'vitest'

// tests/drift/coupons-schema.drift.ts — the coupons_db structural drift
// gate (replaces the old hand-typed scripts/check-coupons-schema.ts
// EXPECTED_COLUMNS mirror — see PLAN-COUPONS-BOUNDARY.md).
//
// Mechanism: run EVERY registered query (src/lib/couponsRepo.ts's
// `couponsQueryProbes`) for real against a live COUPONS_DATABASE_URL,
// inside ONE transaction, then always roll back. Postgres PLANS every
// column/table/predicate before returning rows, so a missing/renamed
// column throws regardless of row count — the queries themselves are the
// only contract, the DB the only source of truth. Nothing
// schema-descriptive (a column list, a DDL snapshot) is committed anywhere
// in this repo — see DESIGN.md's secrecy forward-rule.
//
// Reads execute with sentinel params chosen to match zero real rows where
// trivially forced ('drift-probe*' strings for store-page/stores/
// search-supported; id 0 for increment/expire) — a structural
// (column-existence/type) check only; `coupons.list` runs with a real
// limit:1 (no sentinel filter) so it also exercises the zod numeric/id
// coercion traps on an actual row. Writes (coupons.increment,
// coupons.expire, sources.insert) execute for real against the sentinel
// row/domain INSIDE this transaction, then roll back with everything
// else — genuinely non-mutating, yet proves every column they touch
// (times_used, last_time_used, updated_at, expired, expiry, every
// `sources` column) exists and typechecks — columns the OLD
// EXPECTED_COLUMNS check excluded as "write-only".
//
// Kept out of tests/unit/** (F-004's `pnpm test` glob) — see
// vitest.drift.config.ts for why this must be a vitest-config run rather
// than a plain `tsx` script (couponsRepo -> couponsDb -> env.ts imports
// `server-only`, which throws outside the "react-server" export
// condition/vitest's shim).
class Rollback extends Error {}

async function runGate(): Promise<void> {
    await couponsSql
        .begin(async tx => {
            for (const probe of couponsQueryProbes) {
                try {
                    await probe.run(tx as unknown as Sql)
                } catch (err) {
                    const message =
                        err instanceof Error ? err.message : String(err)
                    // Decorate with the label — a raw Postgres error (e.g.
                    // "column c.source_id does not exist") doesn't name
                    // which registered query it came from on its own, and
                    // the red output naming the failing label is the whole
                    // point of this gate. No `Error(msg, {cause})` — this
                    // tsconfig's `lib` (es6) predates that ES2022 addition,
                    // and this repo doesn't otherwise use it (matches
                    // parseCouponRows's own plain `throw new Error(...)`).
                    throw new Error(
                        `coupons_db schema drift [${probe.label}]: ${message}`,
                    )
                }
            }
            // Every probe ran clean — force a rollback so the write
            // probes never actually persist, even against a real
            // COUPONS_DATABASE_URL.
            throw new Rollback()
        })
        .catch(err => {
            if (err instanceof Rollback) return
            throw err
        })
}

describe('coupons_db schema drift — structural gate', () => {
    // Deliberately NOT `expect(runGate()).resolves.toBeUndefined()` — chai's
    // "promise rejected X instead of resolving" assertion message truncates
    // the rejection reason for display, which would hide exactly the
    // labeled detail (`coupons_db schema drift [<label>]: ...`) this gate
    // exists to surface. Awaiting directly lets a rejection propagate as
    // the test's own failure, which vitest prints in full.
    it('every couponsQueryProbes entry executes against the live coupons_db without error (rolled back, never persisted)', async () => {
        await runGate()
    })
})
