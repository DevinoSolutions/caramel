# Coupons DB architecture — cycle-1 follow-up (CTO/Fable, 2026-07-12)

Goal (Aladdin): make the two-DB setup (`caramel` auth / `caramel_coupons` external Python-owned) sane, maintainable, editable, and **secrecy-safe** for an open-source repo — without touching prod, no side effects.

## Verdict on the setup (after digging)

The two-DB **split is correct** (real ownership + language boundary — Python scraper owns the catalog; Prisma can't own a schema it doesn't migrate). The **seam was the problem**: schema hand-mirrored in 3 places, silent query-structure drift (the live `source_id` 500, a fossil of the old in-Prisma Coupon table), and no producer contract.

## What shipped (local commits on `dev`, unpushed)

- `455ff53` `fix(sources)` — `/api/sources` queried `coupons.source_id` (never existed → 500 on every call); fixed to the real `site = ANY(websites)` join. Drift-gate caught class.
- `654fb36` `fix(supported-stores)` — qualification relaxed to the fields the generic apply engine needs → 828→859 stores incl. eBay/Amazon/Codecademy.
- `fae5a92` `fix(classify-cart)` — paid LLM endpoint 403s origin-less callers.
- `1793c3a` `refactor(coupons)` — **the maintainable core.** All coupons SQL moved out of 12 route files into `src/lib/couponsRepo.ts` (13 named fns + probe registry). Hand-typed `EXPECTED_COLUMNS` drift check DELETED; replaced by a **structural gate** (`tests/drift/coupons-schema.drift.ts`) that runs every real query `LIMIT 0`/rolled-back-writes against the live schema — the queries ARE the contract, nothing schema-descriptive committed. Catches the `source_id` JOIN-column class a shape-check misses.
- `42f24ac` `fix(coupons)` — **deploy blocker.** F-001's `CouponListRowSchema` was stricter than the real producer data + stricter than the UI needs → the main `/api/coupons` listing would 500 in prod on 86 real rows (lowercase/`fixed`/null `discount_type`, null `expiry`). Boundary now tolerates benign value variation (uppercase-normalized, nullable) while the structural gate still catches column drift. UI already only checks `=== 'PERCENTAGE'` and never reads expiry.

## Secrecy (open-source caramel, private coupons)

- Prisma stays **auth-only** (verified live-migrate: only User/Account/Session/Verification). The sensitive scraping schema (xpath selectors, store lists, provider vocab) was **never in Prisma** — the old Coupon/Source catalog was already dropped (`20260414231559_drop_coupon_source_catalog`).
- One concrete leak-reduction: **deleted** the redundant hand-typed `EXPECTED_COLUMNS`.
- Durable guard added to CLAUDE.md + DESIGN.md: never add `coupons`/`sources`/`verification_*` to Prisma; coupons schema lives only in the private DB + minimal runtime zod; commit no full-schema snapshot/DDL/column-dump.
- Local coupons dev = gitignored `scripts/internal/clone-coupons-local.sh` (internal devs with DB access); external contributors keep documented degraded mode. Compose stays coupons-free.
- Historical residual (old Coupon/Source shape in the `init` migration) = non-sensitive, accepted, no git-history rewrite.

## Verification (all against a local READ-ONLY copy of REAL prod data — 23,167 coupons — never prod)

- Full suite **334 green** (314 app + 20 ext) · tsc/oxlint(0 err)/knip/prettier/size all green.
- 13 moved queries proven **byte-identical** (result zero-diff vs the real-data oracle; adversarial Opus review `audit/coupons-refactor-review.md` = SHIP, 0 fix-first).
- Drift gate **GREEN** vs oracle (bare probe) · **RED** proof on a throwaway clone (drop `verification_message`/`websites` → fails naming the label) — structural drift still caught after value-loosening.
- Deploy-blocker fix proven on real data: bare listing **threw on 86 rows → now returns all 18,196 visible rows** (86 null-expiry + 86 non-standard-dtype included, lowercase normalized).
- Migration test on the CLONE only (gate green, reads zero-diff, 3 writes rolled back, auth `migrate deploy` clean on a fresh throwaway). Prod caramel + prod coupons never touched; no emails/side-effects.

## CTO decisions (Fable)

1. Drift gate stays **dispatch/local**, NOT PR CI — wiring a _writable_ private DB into CI is Aladdin's infra call. 2. The 3 writes (increment/expire/request-source) **stay in Next.js, documented** (co-write contract in DESIGN/RUNBOOK); routing through a Python API parked. 3. No git-history rewrite.

## Still open (Aladdin / next cycle — none block local dev)

- **Upstream data quality** (Python producer, out of repo): 86 rows with lowercase/`fixed`/null `discount_type` + null `expiry`; the app now tolerates them, but cleaning them upstream is the real fix. The `type=` filter WHERE (`discount_type = 'PERCENTAGE'`) won't match lowercase rows — minor filtering miss, parked.
- **Gate CI reach** (infra): expose a writable coupons DB to CI via Tailscale/self-hosted runner, or keep dispatch/local.
- **Write-ownership** option (b): route the 3 writes through a Python API (parked).
- NF-13 redis-provisioned-but-unused (rate limiting in-memory).
