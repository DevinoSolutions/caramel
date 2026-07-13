# PLAN-COUPONS-BOUNDARY — repository pattern + structural drift gate + secrecy hardening

Read-only build spec for a Sonnet executor. Completes F-001/F-006: every coupons query moves OUT of route files INTO a repo module; the hand-typed `EXPECTED_COLUMNS` drift check is replaced by a **run-the-real-queries** gate; the public repo leaks no more of the Python-owned schema than the app must name at runtime. Internal refactor — expected breaking changes: **none**. All paths absolute-from-repo-root `C:\Users\alaed\Documents\Github\caramel`; app root is `apps/caramel-app`.

Decision recorded up front: **new sibling `src/lib/couponsRepo.ts`** (not appended to couponsDb.ts). Justification: couponsDb.ts owns _boundary primitives_ (connection, 8 zod row schemas, `parseCouponRows`, fragment factories) — a carefully-documented 232-line file the F-006 tests pin. couponsRepo.ts owns the _application queries_ (named read/write fns + the drift registry) built ON those primitives. Splitting keeps each file single-purpose and avoids ballooning couponsDb.ts. Routes import from couponsRepo; the gate imports the registry from couponsRepo; couponsDb.ts stays the low-level boundary.

## Scope (committed | gitignored)

CREATED · committed:

- `src/lib/couponsRepo.ts` — 13 query fns + `couponsQueryProbes` registry (below).
- `vitest.drift.config.ts` — drift-gate config (loads `.env` + `tests/setup.ts`, includes `tests/drift/**`; mirrors `vitest.eval.config.ts`).
- `tests/drift/coupons-schema.drift.ts` — the gate (rolled-back probe loop).
- `tests/unit/couponsRepo.test.ts` — replaces the deleted schema-check unit test (registry-shape + a couple fn pins via mocked couponsSql).

CREATED · gitignored (`scripts/internal/**`, added to root `.gitignore`):

- `scripts/internal/clone-coupons-local.sh` — `pg_dump $COUPONS_SOURCE_URL | psql .../caramel_coupons` (env-driven; no schema/DDL/secret in-file).
- `scripts/internal/verify-move.ts` — one-time real-data result-diff harness (below).

MODIFIED · committed:

- 10 route files + 1 SSR page (call-site edits — inventory below).
- `src/lib/couponsDb.ts` — (a) reconcile header "two narrow mutations" → **three** (increment, expire, sources INSERT); (b) `export type CouponListRow = z.infer<typeof CouponListRowSchema>` and the same for StatsRow/SiteRow/SiteCountRow/DiscountTypeRow/SourceRow/StoreConfigRow so couponsRepo returns named types. Nothing else changes (connection, schemas, fragments, parse untouched).
- `package.json` — `check:coupons-schema` → `vitest run --config vitest.drift.config.ts`; add `"coupons:clone-local": "bash scripts/internal/clone-coupons-local.sh"`.
- `.github/workflows/coupons-schema-drift.yml` — same `pnpm check:coupons-schema` step; add throwaway `DATABASE_URL` + `BETTER_AUTH_SECRET` env (env.ts requires them at import) beside the real `COUPONS_DATABASE_URL`; refresh comment.
- `.gitignore` (root) — add `apps/caramel-app/scripts/internal/`.
- Docs: `DESIGN.md` (producer-contract note §"Producer-side schema contract" + secrecy forward-rule + §(j) clone), `RUNBOOK.md` (§"coupons_db schema drift" proactive-half), `local-dev/LOCAL-DEV.md` (clone path), repo-root `CLAUDE.md` (conventions→check row).

DELETED:

- `scripts/check-coupons-schema.ts` (whole file — `EXPECTED_COLUMNS` + `findMissingColumns`).
- `tests/unit/check-coupons-schema.test.ts` (tested the deleted function).

## Query inventory (route → new fn → schema → params/label)

All fns end with an injected executor `sql: Sql = couponsSql` (`type Sql = typeof couponsSql`) so the gate can thread a rollback transaction; the OUTER query runs on `sql`, inner fragment factories stay on module couponsSql (interpolated-only, safe). **SQL text + `parseCouponRows` labels move verbatim** — do not reword any query.

| Route / file                                  | New fn (couponsRepo)                                                 | Returns · zod                                                                             | Params · label(s)                                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/coupons/route.ts` GET                    | `listCoupons(opts, sql?)`                                            | `{coupons:CouponListRow[];total:number}` · CouponListRow+TotalCount                       | `{baseSite?,search?,type?,keyWords?,limit,skip}`; builds visible+site/search/keywords/type WHERE reduce verbatim · `coupons.list`/`coupons.count` |
| `(marketing)/coupons/[store]/page.tsx`        | `listStoreCoupons(baseSite,limit,sql?)`                              | same                                                                                      | visible + `(site=base OR site LIKE %.base)` · `store-page.coupons`/`store-page.count`                                                             |
| `api/coupons/stats/route.ts` GET              | `getCouponStats(sql?)`                                               | `StatsRow` (`rows[0] ?? {total:0,expired:0}`)                                             | verifiedCensusSql · `coupons.stats`                                                                                                               |
| `api/coupons/stores/route.ts` GET             | `listStoreOptions(q,limit,sql?)`                                     | `SiteRow[]`                                                                               | q-present/absent branch verbatim · `coupons.stores`                                                                                               |
| `api/coupons/filters/route.ts` GET            | `listFilterSites(sitesLimit,sql?)` + `listFilterDiscountTypes(sql?)` | `SiteRow[]` / `DiscountTypeRow[]`                                                         | sites: `[]` if `sitesLimit<=0` · `coupons.filters.sites` / `coupons.filters.types`                                                                |
| `api/sites/top-sites/route.ts` GET            | `listTopSites(sql?)`                                                 | `SiteCountRow[]`                                                                          | fixed LIMIT 4 · `sites.top-sites`                                                                                                                 |
| `api/sites/search-supported/route.ts` POST    | `searchSupportedSites(q,sql?)`                                       | `SiteRow[]`                                                                               | fixed LIMIT 20 · `sites.search-supported`                                                                                                         |
| `api/extension/supported-stores/route.ts` GET | `listSupportedStoreConfigs(sql?)`                                    | `StoreConfigRow[]`                                                                        | DISTINCT ON join verbatim · `extension.supported-stores`                                                                                          |
| `api/sources/route.ts` GET                    | `listActiveSources(sql?)`                                            | `SourceRow[]`                                                                             | sources LEFT JOIN coupons ON `site=ANY(websites)` · `sources.list`                                                                                |
| `api/coupons/increment/route.ts` POST         | `incrementCouponUsage(id,sql?)` **write**                            | `Record<string,unknown> \| undefined` (`rows[0]`, no zod — preserves untyped passthrough) | UPDATE…RETURNING verbatim                                                                                                                         |
| `api/coupons/expire/route.ts` POST            | `expireCoupons(ids,sql?)` **write**                                  | `number` (`rows.length`)                                                                  | UPDATE…RETURNING id verbatim                                                                                                                      |
| `api/sources/route.ts` POST                   | `requestSource(website,sql?)` **write**                              | `void`                                                                                    | INSERT sources verbatim                                                                                                                           |

Call-site edit pattern (uniform): drop the `couponsSql`/schema/fragment/`parseCouponRows` imports, import the fn from `@/lib/couponsRepo`; replace the inline ``couponsSql`…` `` + parse block with `await fn(args, )`. **Keep in the route** all HTTP concerns unchanged: param parsing/caps, `getBaseDomain` 400s (coupons + page), `.map/.filter/.sort`, response envelopes, cache headers, `hasMore`, stats `active=total-expired`, sources→`SourceMetrics` map, increment 404, expire `{count}`, sources POST domain validation + `withRoute` auth. Non-uniform notes are captured by the fn signatures above (dynamic WHERE, q-branch, includeSites gate).

## Drift-gate v2 (structural; non-leaky; the maintainable core)

**Mechanism — run every registered query against the live/clone schema; the queries are the only contract, the DB the only source of truth. Nothing schema-descriptive is committed.**

`couponsRepo.ts` exports:

```
export const couponsQueryProbes: ReadonlyArray<{label:string; write?:boolean; run:(sql:Sql)=>Promise<unknown>}> = [
  {label:'coupons.list',       run:s=>listCoupons({limit:1,skip:0},s)},          // limit 1 → real row → full zod type-check
  {label:'store-page.coupons', run:s=>listStoreCoupons('drift-probe.invalid',1,s)},
  {label:'coupons.stats',      run:s=>getCouponStats(s)},
  {label:'coupons.stores',     run:s=>listStoreOptions('drift-probe',1,s)},
  {label:'coupons.filters.sites', run:s=>listFilterSites(1,s)},
  {label:'coupons.filters.types', run:s=>listFilterDiscountTypes(s)},
  {label:'sites.top-sites',    run:s=>listTopSites(s)},
  {label:'sites.search-supported', run:s=>searchSupportedSites('drift-probe',s)},
  {label:'extension.supported-stores', run:s=>listSupportedStoreConfigs(s)},
  {label:'sources.list',       run:s=>listActiveSources(s)},
  {label:'coupons.increment', write:true, run:s=>incrementCouponUsage(0,s)},      // id 0 → 0 rows
  {label:'coupons.expire',    write:true, run:s=>expireCoupons([0],s)},
  {label:'sources.insert',    write:true, run:s=>requestSource('drift-probe.invalid',s)},
]
```

Gate (`tests/drift/coupons-schema.drift.ts`): open ONE transaction, run every probe, always roll back:

```
class Rollback extends Error {}
await couponsSql.begin(async tx => { for (const p of couponsQueryProbes) await p.run(tx as unknown as Sql); throw new Rollback() })
  .catch(e => { if (!(e instanceof Rollback)) throw e })  // a probe error escapes here → gate fails, naming the label
```

- **Reads** execute; Postgres _plans_ every column/table/predicate before returning rows, so a missing/renamed column throws regardless of row count. Probes return ≥1 real row where trivially forced (`listCoupons` limit 1 → also exercises the zod numeric/id-coercion traps); sentinel-param reads (store-page/stores/search) return 0 rows → structural (column-existence) check only, and their column _types_ are already covered by sibling probes sharing the same SELECT/schema.
- **Writes** execute against a sentinel id (0) / sentinel domain inside the transaction, then roll back — genuinely non-mutating, yet proves `times_used`, `last_time_used`, `updated_at`, `expired`, `expiry`, and every `sources` column exist and typecheck (columns the OLD check _excluded_ as "write-only" — net coverage gain).
- **Why this beats a zod-derived check (state as the design justification):** it catches the `source_id` class — a JOIN/WHERE column absent from every zod _output_ (sources.list projects `s.id/source/websites/status`; the join key `c.site`/`s.websites` never reaches a schema). Reverting that JOIN to `c.source_id` compiles and passes any zod check, but the gate's `EXPLAIN`-equivalent execution throws `column c.source_id does not exist`. Confirmed coverage ⊇ old EXPECTED_COLUMNS (every listed column is named by some executed query) + `last_time_used`/`coupons.updated_at`/`sources.created_at,updated_at`.
- Implemented as a vitest-config run (not a standalone tsx script) because couponsRepo→couponsDb→`env.ts` imports `server-only` (throws under plain tsx) and eagerly requires 3 env vars; the vitest path reuses `tests/setup.ts`'s existing shim + `.env` loading, exactly as `pnpm eval` does. Kept out of the unit glob (`tests/drift/**`, not `tests/unit/**`).

## Secrecy hardening (per-artifact leak verdict)

Tiers (per CTO): CROWN JEWELS = xpath _values_ + coupon _data_ + store lists → DATA, live only in the private DB, never committed, untouched by any code artifact here. MILD/runtime-necessary = the column _names_ the app must read (couponsDb.ts zod schemas incl. StoreConfigRow's 8 xpath field names) → the app cannot validate columns it doesn't name → **stay committed**; this is the irreducible minimum, do not gitignore/generate it (would break open-source buildability).

| Artifact                                                | Committed?          | Leak verdict                                                                                                                                                                                           |
| ------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| couponsRepo.ts SQL text                                 | committed           | MILD, **zero net delta** — same column names already committed in the route SQL + couponsDb schemas; relocation, not new exposure                                                                      |
| couponsDb.ts schemas + row types                        | committed           | MILD, irreducible minimum (unchanged)                                                                                                                                                                  |
| **`scripts/check-coupons-schema.ts` EXPECTED_COLUMNS**  | **DELETED**         | REDUNDANT leak — duplicated the schema names with no runtime need; the run-the-queries gate makes it obsolete → deleting it is the one concrete secrecy **win** (and kills a maintenance/drift burden) |
| drift gate (tests/drift + config)                       | committed           | NONE — iterates the registry generically; contains no column names                                                                                                                                     |
| clone-coupons-local.sh                                  | gitignored          | NONE committed — `pg_dump`-based, no DDL/schema/source in-file; gitignored per CTO so no future schema/source specifics can land in public git                                                         |
| package.json `coupons:clone-local`                      | committed           | NONE — bare command referencing a gitignored path                                                                                                                                                      |
| `prisma/schema.prisma`                                  | committed           | NONE — stays **auth-only**; the sensitive scraping schema is already correctly OUT of Prisma                                                                                                           |
| compose                                                 | committed           | NONE — stays coupons-free                                                                                                                                                                              |
| init migration `20250705…_init` old Coupon/Source shape | committed (history) | HISTORICAL RESIDUAL — non-sensitive (basic columns + DiscountType/SourceStatus enums, **not** the xpath/scraping schema). **Do not rewrite git history**; accept as-is (CTO note).                     |

Honest conclusion for DESIGN.md/CLAUDE.md (do not overclaim): the sensitive schema is already out of Prisma; the durable guard is the **forward rule** — "never add `coupons`/`sources`/`verification_*` to prisma/schema.prisma; the coupons schema lives only in the private DB + the minimal runtime zod row schemas; commit no full-schema snapshot/DDL/column-dump (why EXPECTED_COLUMNS was deleted); a new column the app needs → add it to its zod schema + the query that reads it, and the drift gate is the contract." The one concrete reduction shipped here is deleting EXPECTED_COLUMNS.

## Write-ownership (decision #4 → option a: keep + document)

The three writes are already the sanctioned exceptions in CLAUDE.md ("increment/expire/sources POST"); only couponsDb.ts's header lags ("two"). Fix the header and document the coordination contract in RUNBOOK/DESIGN: caramel-app co-writes `coupons.times_used`+`last_time_used` (usage), `coupons.expired`+`expiry` (admin-gated expire), and inserts `sources` rows ("request a store"); the Python service owns everything else and must treat those columns as co-written (not clobber `times_used`, honor `expired`). Option (b) — routing the writes through a Python API — is scope expansion (needs a Python-side endpoint); **parked as a flagged finding**, not done here.

## Local coupons dev (secrecy-respecting)

Public compose stays coupons-free (creates only `caramel`). Internal devs with DB access run `pnpm coupons:clone-local` → `clone-coupons-local.sh` `pg_dump $COUPONS_SOURCE_URL` (a reachable source; from their gitignored `.env`) into a local `caramel_coupons` on the compose Postgres (`:58005`). External contributors keep the documented **degraded mode** (LOCAL-DEV.md §Two-database topology / DESIGN.md §(j)) — coupon routes 500, health `coupons_db:error` — unchanged. Compose and Prisma untouched.

## Sequencing (verifiable batches; each with its check)

- **B0** Confirm read access to the oracle `postgresql://caramel:caramel_password@localhost:58005/caramel_coupons` (23,167 coupons). Write `scripts/internal/verify-move.ts` (gitignored) — imports each new fn + the pre-refactor inline query and deep-equals their JSON over representative params. _Check: harness runs._
- **B1** Create couponsRepo.ts (10 reads first) + row-type exports in couponsDb.ts. No route edits. _Check: `type-check` green; `couponsRepo.test.ts` (mocked couponsSql) green._
- **B2** Move reads route-by-route (3–4 at a time): edit call-site → run that route's unit test(s) → result-diff new fn vs old inline query against the oracle. _Check per route: tests green + byte-identical diff._
- **B3** Move the 3 writes; edit call-sites. _Check: `coupons-expire.test.ts` + increment/sources tests green; on the migtest clone, execute each write on a throwaway row, assert effect, roll back/drop._
- **B4** Build registry + `vitest.drift.config.ts` + gate; DELETE `scripts/check-coupons-schema.ts` + its unit test; repoint `check:coupons-schema`; update workflow env. _Check: `pnpm check:coupons-schema` GREEN vs oracle; prove RED on a migtest clone (drop `coupons.verification_message` → fails `coupons.list`; drop `sources.websites` → fails `sources.list`, the JOIN-column class)._
- **B5** Clone script (gitignored) + package entry + `.gitignore` + docs + couponsDb header reconcile. _Check: degraded mode unchanged for externals; `pnpm coupons:clone-local` populates `caramel_coupons`; gate green against it._
- **B6** Full sweep: `pnpm test`, `pnpm lint`, `lint:oxlint`, `prettier-check`, `knip`, `-r type-check` all green; migration-test protocol; Prisma `migrate deploy` on a fresh throwaway auth DB green.

## Test strategy

- **Behavior-identical:** `verify-move.ts` deep-equals old-vs-new results against the real-data oracle across representative params (no-filter; `site=<top store from oracle>`; search; type; keyword; stores q/no-q; filters includeSites on/off; every read) — expect zero diff (SQL is verbatim). Second net: the SQL-text route tests (`coupons-read-boundary`, `coupons-visibility`, `coupons-store-page`, `supported-stores`, `coupons-expire`) stay green **unmodified** — they mock couponsSql at the couponsDb boundary and match on `strings.join('?')`, which is unchanged when SQL relocates to couponsRepo (couponsRepo uses the mocked couponsSql; fragments still appear in `callValues` per the visibility-test closure note). Watch the mocks lacking `importActual` (`coupons-expire`, `handleRouteError`, `health-db`): couponsRepo's non-couponsSql imports are only used inside fns those tests never call, so they pass — if any breaks, add the missing named export to that test's mock.
- **Drift-gate red→green:** green vs oracle; red proofs above; restore by re-clone.
- **Migration-test-on-clone (never prod):** `createdb caramel_coupons_migtest` ← `pg_dump` the oracle; point `COUPONS_DATABASE_URL` at it; run gate (green), all reads (zero-diff), the 3 writes on throwaway rows (assert then the gate's own rollback / `DROP DATABASE`). Auth half (unchanged but must stay green): fresh throwaway DB → `db:migrate:deploy` → clean apply → drop. **Only localhost:58005 throwaway DBs; never the prod caramel or prod caramel_coupons; no emails/side-effects.**

## Breaking changes

None. Identical SQL, params, `parseCouponRows` labels, and response shapes; auth DB and Prisma untouched. The gate's _implementation_ changes (executes queries vs introspects columns) but it is dispatch/local tooling, not a runtime surface; deleting EXPECTED_COLUMNS removes a constant with no runtime consumer.

## Risk + rollback

- _Subtle query divergence_ → mitigated by verbatim move + real-data zero-diff proof + the still-green SQL-text route tests.
- _server-only/eager-env for the gate_ → mitigated by the vitest-config path (reuses `tests/setup.ts` shim + `.env`).
- _Rollback:_ pure refactor on a branch — `git revert` the commit; no schema/data/prod change. The gate is dispatch/local only, so disabling it never touches prod.

## CTO rulings (Fable — DECIDED; executor follows these)

1. **Gate CI reach → STAY `workflow_dispatch` + local (not PR CI).** Exposing a _writable_ private coupons DB to GitHub Actions is a real infra/security call that's Aladdin's, and needs Tailscale/self-hosted access that may not exist. The gate delivers its value locally + on dispatch + inside the migration test regardless. Keep the workflow dispatch-only (as it already is). Document the "if a read replica is ever the only CI-reachable target, swap write probes to `EXPLAIN`" note in the workflow comment as a future option — do NOT build it now. Flag CI-wiring as an Aladdin infra decision in the final report.
2. **Write-ownership → option (a): keep + document.** Fix the couponsDb.ts header (three writes), document the co-write coordination contract in DESIGN/RUNBOOK. Park (b) "route through Python API" as a next-cycle finding. No cross-service change now.
3. **Historical residual → accept as-is.** No git-history rewrite; it's the non-sensitive old Coupon/Source shape. One-line note in DESIGN known-debt.
4. **Gate implementation → vitest-config run (approved).** Mirrors `pnpm eval`, reuses `tests/setup.ts` shim + `.env`; sidesteps server-only-under-tsx.

Extra executor guardrails (Fable):

- **B0 ordering:** snapshot each old inline query's real-data result (JSON) via `verify-move.ts` BEFORE editing its route, then deep-equal the new fn's result to the snapshot AFTER — the old inline SQL disappears on edit, so capture-first.
- **Writes never hit prod:** the drift gate's rolled-back write probes and the B3/migration write tests run ONLY against `localhost:58005` (the oracle copy or the `caramel_coupons_migtest` clone I already created — 23,167 rows, ready). Never point `check:coupons-schema` or any write at the real prod coupons/caramel DB.
- A fresh throwaway clone for the migration test already exists: `caramel_coupons_migtest` on `localhost:58005`. Use it (or re-clone via `CREATE DATABASE … TEMPLATE caramel_coupons`); drop throwaways when done.
