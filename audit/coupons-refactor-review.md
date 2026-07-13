# Coupons-repository refactor — adversarial review (commit `1793c3a`)

Fresh reviewer, did not build it. Read-only on source. HEAD == `1793c3a`; no
follow-up commit has landed on couponsRepo/couponsDb yet (`git log 1793c3a..HEAD`
on those paths = empty). Working tree clean bar the untracked plan file.

## Verdicts

| #   | Area                               | Verdict         |
| --- | ---------------------------------- | --------------- |
| 1   | Behavior-identical move            | PASS            |
| 2   | No HTTP-in-repo / no SQL-in-route  | PASS            |
| 3   | Drift-gate soundness               | PASS-WITH-NOTES |
| 4   | Secrecy claims                     | PASS            |
| 5   | Run it (tests/tsc/lint/knip/gate)  | PASS            |
| 6   | Writes non-prod-safe / no auto-run | PASS            |

**Overall: SHIP.** No FIX-FIRST items.

## Falsification attempts that FAILED (tried to break, couldn't)

- **Silent SQL divergence.** Diffed OLD route SQL (`1793c3a^`) vs new repo fns for
  listCoupons (dynamic WHERE reduce), store-page LIKE, listActiveSources, and all
  3 writes — **byte-identical** text + params + parseCouponRows labels. The load-
  bearing guards survived the move intact: `if (type && type !== 'all')` (repo:104)
  and keyWords `.filter(k => k.length > 2)` (repo:96) — a dropped `!== 'all'` would
  have made `type=all` filter on `discount_type='all'`; it didn't.
- **"The filters/supported-stores/sources behavior changed during the move."** False
  alarm: the visibleCouponsWhere() unification, the 2-xpath relaxation, and the
  `source_id` drop all PRE-DATE this commit (455ff53/654fb36 + parent). The filters
  diff proves the removed lines already used `visibleCouponsWhere()`; listActiveSources
  is byte-for-byte the parent's already-fixed query. `1793c3a` is a pure relocation.
- **SQL left in a route / HTTP pulled into repo.** `git grep couponsSql` over
  `apps/caramel-app/src/app` = **zero** hits. Caps, 400s (getBaseDomain / domain
  validation), 404 (increment `if(!row)`), count/dedup/cap (expire), envelopes,
  cache headers, successRate+sort, and auth (`apiKey:'trustedServer'`, `origin:true`)
  all stayed in routes. Only result-shaping defaults (`?? 0`, `rows[0] ?? {…}`) moved
  in — repo-owned return types, pinned by couponsRepo.test.ts.
- **Gate is vacuously green.** RED proof: pointed COUPONS_DATABASE_URL at the local
  auth DB (no `coupons` table) → exit 1 + `coupons_db schema drift [coupons.list]:
relation "coupons" does not exist`. It runs the probes for real and label-decorates.
- **Gate mutates.** `couponsSql.begin()` callback ALWAYS throws (Rollback after all-
  clean, or the decorated error) → never resolves → never commits. sources.insert
  does insert a real row but inside the rolled-back tx. Non-mutating even vs prod;
  0-row reads still validate columns (Postgres plans before returning). Writes are
  defense-in-depth: tx-rollback + `on: workflow_dispatch:`-only workflow.
- **Gate auto-runs writes in dev/CI.** `vitest run` (default config, `tests/unit/**`)
  ran 310 tests with NO coupons DB and never invoked the gate — it's a separate
  `vitest.drift.config.ts` (`tests/drift/**`), only via `pnpm check:coupons-schema`
  or dispatch. No push/PR trigger.
- **Hidden schema leak.** `check-coupons-schema.ts` (EXPECTED_COLUMNS) is DELETED —
  only doc/comment refs remain; script repointed to the drift config; its unit test
  deleted too. `prisma/schema.prisma` = auth-only (Account/Session/Verification/User
    - UserStatus/Role; no coupons/sources/verification\_/xpath). `scripts/internal/`
      git-ignored (`git check-ignore` → `.gitignore:19`). couponsDb.ts added only a
      header + 7 `z.infer` type aliases (no new column names). Net = one secrecy WIN.

## Runtime outcomes (exact)

- `vitest run` (caramel-app): **32 files / 310 tests passed**.
- `pnpm -r type-check`: **clean** (`tsc --noEmit` Done).
- `pnpm lint:oxlint`: **exit 0** — warnings only. One in the new drift file
  (`preserve-caught-error`, line 55) is deliberately documented (tsconfig `lib:es6`
  predates `Error{cause}`; matches parseCouponRows). Rest are pre-existing
  caramel-extension warnings, untouched here.
- `pnpm --filter caramel-app knip`: **exit 0** (no issues).
- `pnpm check:coupons-schema` vs oracle `…@localhost:58005/caramel_coupons`:
  **GREEN ×2** (all 13 probes, ~0.5s). Single spec — the first run's "2 files/2 tests"
  was a `--filter`-invocation reporter artifact; identical re-runs show `PASS (1)`.

## Notes (non-blocking; carry forward — author already flagged both in-code)

- **Area 3 deviation:** the `coupons.list` probe uses `type:'PERCENTAGE'` (not the
  plan's bare `{limit:1}`) to dodge a real ~86-row (0.47%) data slice where the Python
  producer emits lowercase `discount_type`/NULL `expiry` that CouponListRowSchema
  rejects. Disclosed in a long comment; structurally still names every column + runs
  zod on a real row. The residual risk it names — **bare/no-filter `/api/coupons` can
  500 on that live slice** — is a genuine pre-existing data-quality finding, out of
  this refactor's scope. Sentinel-param reads (9 of them) validate column existence/
  type but not zod value-coercion on real rows — inherent to a structural gate.
- **CI wiring** of the gate to a reachable coupons DB is intentionally deferred to
  Aladdin (infra/security call — documented in the workflow comment + RUNBOOK). The
  gate still delivers value locally + on dispatch + in the migration test.
