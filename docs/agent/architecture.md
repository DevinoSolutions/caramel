# Architecture — moved detail

Moved verbatim from CLAUDE.md on 2026-10-07 (CLAUDE.md was slimmed to cut context-window cost). Every bullet/paragraph below is unchanged; only the headings and the notes in this style are new.

## Catalog ownership, ingest and reads

- pnpm@9 monorepo, two packages. `apps/caramel-app` = Next.js 16 App Router: Prisma → ONE Postgres (`DATABASE_URL`) holding BOTH auth/user AND the app-OWNED coupon catalog (`coupons`/`store_configs`/`sources`, created by the `catalog_tables` migration + a synthetic seed; app owns it since the Coupons Ownership Inversion — see DESIGN.md §2 "Write-ownership"). The external Python pipeline is now a SUPPLIER: it pushes catalog deltas to `POST /api/ingest/catalog` (`applyCatalogRows` — only-if-newer delta upsert, one transaction, >20% tombstone gate; migration-period feed = the read-only `bridge:sync` job). Reads run via `prisma.$queryRaw` — 10 read fns + 3 sanctioned writes (`expireCoupons`/`requestSource`/`submitShopperCoupon` — the last owner-directed 2026-10-02) in `src/lib/couponsRepo.ts` (routes never write inline SQL), zod row schemas + `parseCouponRows` in `src/lib/couponsDb.ts` (schema drift throws loudly at parse time).

## Extension layout (WXT)

- `apps/caramel-extension` = MV3 built with WXT (since the 2026-08-12/13 port; one `wxt.config.ts` generates both browser manifests): every source file is an ES module, cross-file use is a plain `import`, and the content realm is composed in `entrypoints/content.ts`, whose `main()` calls each module's `init*` in a fixed order (modules avoid top-level side effects; the one deliberate exception is `caramel-env.js`, which publishes `globalThis.CARAMEL_ENV`); `background.js` is a separate service-worker entry; the popup is React (popup-only). LLM surface: `cartClassifier.ts` → `/api/classify-cart` (OpenRouter), eval-gated.

## Deploys, health and telemetry

- Deploys: Dokploy/Nixpacks → grabcaramel.com; the root `docker-compose.yml` (F-016) is now the intended deployment unit (local/CI already run it — the prod cutover onto it stays gated + human-run). `pnpm dev` migrates AND seeds the catalog locally, so coupon routes return 200 and `/api/health/db` reports app-catalog freshness (`catalog: ok` + `{count,freshestUpdatedAt,ageMinutes,stale}`); the old externally-owned-DB "degraded mode" is RETIRED. App-owned telemetry (worked/used/failed) lives in `coupon_signals` (`src/lib/couponSignals.ts`), split out of the catalog so a usage bump never touches `coupons.updated_at`.
