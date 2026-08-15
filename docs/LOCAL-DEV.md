# Caramel Local Development Guide

Caramel runs on **one root Docker Compose** (F-016). `pnpm dev` builds the app
image and boots the real service graph in prod-mode builds. This same
`docker-compose.yml` is the deployment unit production migrates onto (cutover
gated, human-run) — so what you run locally is what ships. Hot reload is
deliberately traded away for that parity (ratified 2026-07-09); use the
`pnpm dev:next` escape hatch below when you want framework hot reload.

## Quick start

```bash
pnpm install
cp apps/caramel-app/.env.example apps/caramel-app/.env   # fill in per the README secrets table
pnpm dev                                                  # docker compose up --build
```

`pnpm dev` (`docker compose up --build`):

- builds the `web` image from the root `Dockerfile` (Next.js standalone),
- boots **Postgres 18.4** and **web**,
- runs `prisma migrate deploy` automatically inside the web container at start
  (the entrypoint fail-hards if a migration fails),
- serves the app + API at **http://localhost:58000**.

There is no separate "apply migrations" step for the compose flow — the
container entrypoint does it. Stop everything with `Ctrl-C` (or
`docker compose down`); `docker compose down -v` also discards the local DB
volume.

## Services & ports

| Service    | Image           | Host port (default)        | Purpose                                             |
| ---------- | --------------- | -------------------------- | --------------------------------------------------- |
| `web`      | built locally   | `127.0.0.1:58000` → `3000` | Next.js app + API (`apps/caramel-app`)              |
| `postgres` | `postgres:18.4` | `127.0.0.1:58005` → `5432` | Auth DB (`caramel`) — owned + migrated by this repo |

No Redis service: rate limiting is in-memory single-instance by design (NF-13).
No second coupons DB service: the coupon catalog is **app-owned** and lives in
the `caramel` Postgres above, created and seeded by `prisma migrate deploy`
(see the catalog topology below).

### Deploy knobs (compose variables)

All optional — the defaults above apply when unset. Set them in your shell (or
the platform env) to override:

| Variable                                              | Overrides                                              |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `BIND_HOST`                                           | Host bind address (default `127.0.0.1`, loopback-only) |
| `WEB_PORT` / `PG_PORT`                                | Host ports for web / postgres                          |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Postgres role + database name                          |

## Two env files — don't confuse them

| File                                | Committed?      | Contains                                                                                                  | Loaded by                                                                                            |
| ----------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/caramel-app/.env`             | No (gitignored) | Real secrets, `DATABASE_URL` (+ optional bridge-only `COUPONS_DATABASE_URL`)                              | compose `env_file` (optional), Next.js's own `.env` loading, the Prisma CLI, `vitest.eval.config.ts` |
| `docker-compose.yml` `environment:` | Yes (tracked)   | **Topology only** — the in-container `DATABASE_URL` (no `COUPONS_DATABASE_URL`: the catalog is app-owned) | the `web` container at runtime (overrides the app `.env`'s localhost values)                         |

The compose `environment:` block points the in-container app at the `postgres`
**service** (`@postgres:5432`), overriding whatever `localhost:58005` value the
app `.env` ships. The app `.env`'s localhost values still serve the `pnpm
dev:next` escape hatch and host-side `prisma` / integration-test commands.

See the root [README.md](../README.md)'s **Getting Started** for how to create
`apps/caramel-app/.env` and what each variable is for — that table is the single
source of truth for secrets; this file doesn't repeat it.

## Escape hatches (run a package on the host)

`pnpm dev` is the source of truth. When you need framework hot reload or to run
one package directly:

```bash
# 1. Bring up ONLY Postgres (published on 127.0.0.1:58005, matching .env.example):
docker compose up postgres -d

# 2a. Web app on the host with hot reload (Next.js dev server on :58000):
pnpm dev:next            # = pnpm --filter caramel-app dev
#     First run / after new migrations, apply them against the compose Postgres:
pnpm --filter caramel-app db:migrate:deploy

# 2b. The browser extension in a web-ext Chromium instance:
pnpm dev:extension       # = pnpm --filter caramel-extension dev
```

`pnpm dev:next` reads `apps/caramel-app/.env` (whose `DATABASE_URL` points at
`localhost:58005`), so the single `docker compose up postgres -d` above is all
the infra it needs.

## Catalog topology (app-owned since the ownership inversion)

`caramel-app` runs on **one** Postgres in local dev — the `caramel` database,
which holds BOTH the auth/user tables AND the coupon catalog:

| Table group                                            | Owner              | Provisioned + migrated by                                                             |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------- |
| auth/user (`users`, `sessions`, …)                     | This repo          | `prisma migrate` (entrypoint in-container, or `db:migrate:deploy` on host)            |
| coupon catalog (`coupons`, `store_configs`, `sources`) | This repo (Prisma) | `prisma migrate deploy` — the `catalog_tables` migration + a synthetic `catalog_seed` |

So `pnpm dev` creates AND seeds the coupon catalog locally; coupon routes return
`200` against real seeded rows, and `GET /api/health/db` reports the catalog's
own freshness. There is no second database to provision, and modelling the
catalog tables in Prisma is now legitimate (the secrecy forward-rule was
inverted — only the scraper's pipeline-internal machinery stays out of the
schema; see DESIGN.md §2(k) and `tests/unit/prisma-schema-secrecy.test.ts`).

The external, Python-owned `caramel_coupons` Postgres still exists, but it is now
a **supplier**, not the source of reads. During the migration period the app
pulls it via the read-only `bridge:sync` job (`COUPONS_DATABASE_URL`, optional,
unset by default — see below); eventually the pipeline pushes changes directly
to `POST /api/ingest/catalog` and the bridge retires. See [`INGEST.md`](INGEST.md).

### What healthy local looks like (no more "degraded mode")

Following the documented setup verbatim, expect a fully working catalog — the
pre-inversion "degraded mode" is retired:

- `GET /api/health/db` (with `Authorization: Bearer $UPKUMA_HEALTH_SECRET`) →
  `200`, with `checks.auth_db.status: "ok"` and `checks.catalog.status: "ok"`.
  The `catalog` check reports `{count, freshestUpdatedAt, ageMinutes, stale}`;
  the seeded rows age past the 48h (default, `CATALOG_MAX_AGE_HOURS`) window
  over time, so `stale: true` is normal locally and never fails the check (only
  an empty or unreachable catalog is a `503`).
- Any coupon-facing route (`GET /api/coupons`, `/api/coupons/stores`,
  `/api/coupons/filters`, `/api/extension/supported-stores`, the
  `/coupons/[store]` marketing page, …) → `200`, serving the seeded catalog.
- `COUPONS_DATABASE_URL` is **not** read at boot — it is an optional bridge-only
  input; the app always serves its own `DATABASE_URL` catalog.

## Connecting

- Postgres (host): `postgresql://caramel:caramel_password@127.0.0.1:58005/caramel`
- Container-internal hostname: `postgres` (used by the `web` service).

`caramel` is the role the compose Postgres creates (`POSTGRES_USER: caramel`),
and it is exactly what `apps/caramel-app/.env.example` ships in `DATABASE_URL`
— copy it as-is. (`COUPONS_DATABASE_URL` is optional/bridge-only; leave it unset.)

## Migrations

- **Compose flow:** applied automatically by the web container's entrypoint
  (`prisma migrate deploy`) on every `pnpm dev` / boot.
- `pnpm --filter caramel-app db:migrate:deploy` — apply committed migrations on
  the host (against the compose Postgres); the onboarding command for the
  `dev:next` escape hatch.
- `pnpm --filter caramel-app db:migrate` — `prisma migrate dev`; creates a
  shadow database and can prompt for a migration name. Only for authoring a
  **new** migration.
- `pnpm --filter caramel-app db:migrate:reset` — drops, recreates, reapplies.
  Destructive; a local-only escape hatch.

## Troubleshooting

- **Port already in use**: override the host port(s), e.g.
  `WEB_PORT=59000 PG_PORT=59005 pnpm dev`, or bind elsewhere with `BIND_HOST`.
- **Coupon routes return 500 / health check shows `catalog: error`**: NOT
  expected anymore — the catalog is app-owned and seeded by `prisma migrate
deploy`. Confirm the migrations actually ran against the compose Postgres
  (`pnpm --filter caramel-app db:migrate:deploy`); an empty catalog is what
  reports `catalog: "error"` (503).
- **`P1000: Authentication failed` connecting to `caramel`**: your `.env`'s
  `DATABASE_URL` still has placeholder credentials — see Connecting above.
- **`pnpm test` fails only on `coupon-constants.generated.test.ts`'s
  byte-identical check, on Windows, on a clone that predates `.gitattributes`**:
  `.gitattributes` pins `* text=auto eol=lf` (NF-04), so a fresh clone gets LF
  regardless of `core.autocrlf` and this failure can no longer happen there. A
  clone made before `.gitattributes` landed, with `core.autocrlf=true`, still
  has the committed (LF) generated file sitting as CRLF on disk while the
  test's live-generated value is LF. Renormalize:
  `git config core.autocrlf false && git checkout-index -a -f`
  (`git reset --hard` does NOT rewrite files whose conversion round-trips
  clean — `checkout-index` is the command that actually rewrites the working
  tree).
