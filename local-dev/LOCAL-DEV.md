# Caramel Local Development Guide

## Port range

Caramel uses the 58000–58010 range by default (see [`.env.ports`](.env.ports)):

- Web app: `PORT=58000`
- Postgres: `PG_PORT=58005`
- Redis: `REDIS_PORT=58006`
- (Reserved) Worker: `WORKER_PORT=58002`
- (Reserved) Socket: `SOCKET_PORT=58003`
- (Reserved) Typesense: `TYPESENSE_PORT=58007`

Adjust values here if you have conflicts, then `pnpm compose:down && pnpm dev:compose` to pick them up.

## Two env files — don't confuse them

| File                    | Committed?      | Contains                                             | Loaded by                                                                                                                        |
| ----------------------- | --------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `local-dev/.env.ports`  | Yes (tracked)   | Port numbers only — no secrets                       | `docker compose --env-file` (compose) and `dotenv -e ../../local-dev/.env.ports --` (the app's `dev`/`db:*` scripts, for `PORT`) |
| `apps/caramel-app/.env` | No (gitignored) | Real secrets, `DATABASE_URL`, `COUPONS_DATABASE_URL` | Next.js's own automatic `.env` loading, the Prisma CLI, `vitest.eval.config.ts`                                                  |

See the root [README.md](../README.md)'s **Getting Started** for how to create `apps/caramel-app/.env` and what each variable is for — that table is the single source of truth for secrets; this file doesn't repeat it.

## Workflow

1. Start infra (Postgres + Redis):
    ```bash
    pnpm compose
    ```
2. Same thing, plus removes orphaned containers left over from a stale `docker-compose.yml` (handy after pulling changes to it):
    ```bash
    pnpm dev:compose
    ```
    **Both commands publish the same host ports** — `docker-compose.yml` publishes `127.0.0.1:58005` (Postgres) and `127.0.0.1:58006` (Redis) unconditionally; `--remove-orphans` is the only difference between the two commands. Neither one is a "no host ports" mode.
3. Apply database migrations (first run, and after pulling new migrations — see Migrations below):
    ```bash
    pnpm --filter caramel-app db:migrate:deploy
    ```
4. Run the app(s):
    ```bash
    pnpm dev
    ```

## Two-database topology

`caramel-app` talks to two separate Postgres databases, both on the same `pnpm dev:compose` Postgres server in local dev:

| Database                       | Owner                                | Provisioned by `pnpm compose`? | Migrated by                                                                             |
| ------------------------------ | ------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------- |
| `caramel` (auth_db)            | This repo                            | Yes                            | `prisma migrate` (`apps/caramel-app/prisma/migrations`)                                 |
| `caramel_coupons` (coupons_db) | External Python verification service | **No**                         | Not this repo's concern — read-only from here (`apps/caramel-app/src/lib/couponsDb.ts`) |

**`caramel_coupons` does not exist in local dev by default.** Nothing the public `pnpm compose` provisions creates it — that's the expected, honest state for anyone without coupons-DB access, not a bug to paper over here (seeding a fake one would be a behavior change, out of this doc's scope). If you have real access (a reachable read replica or tunnel — never prod's primary directly), set `COUPONS_SOURCE_URL` in your gitignored `apps/caramel-app/.env` and run:

```bash
pnpm --filter caramel-app coupons:clone-local
```

This `pg_dump`s `COUPONS_SOURCE_URL` into a local `caramel_coupons` on the same compose Postgres (`scripts/internal/clone-coupons-local.sh`, itself gitignored and env-driven — no schema/DDL/secret hardcoded in it, per DESIGN.md's secrecy forward-rule). Re-run it any time to refresh. Without `COUPONS_SOURCE_URL` access, stay in the degraded mode below — that's the correct state, not something to work around.

Following the documented setup verbatim, expect this **honest degraded mode**, not an error in your setup:

- `GET /api/health/db` (with `Authorization: Bearer $UPKUMA_HEALTH_SECRET`) → `503`, with `checks.coupons_db.status: "error"` and `checks.coupons_db.details: "database \"caramel_coupons\" does not exist"`. `checks.auth_db.status` reports `"ok"`.
- Any coupon-facing route (`GET /api/coupons`, `/api/coupons/stores`, `/api/coupons/filters`, `/api/extension/supported-stores`, the `/coupons/[store]` marketing page, …) → `500` with a `{"error": "..."}` body (each route has its own message — see `src/lib/api/handleRouteError.ts`).
- Everything else — homepage, auth/signup/login, the marketing pages — works normally.

This isn't a boot failure: `COUPONS_DATABASE_URL` only has to be a non-empty string to satisfy `src/lib/env.ts`'s startup validation. The Postgres connection itself is lazy (the `postgres` client only connects on first query), so the failure surfaces per-request, not at startup.

## Connecting

- Postgres (host): `postgresql://caramel:caramel_password@127.0.0.1:58005/caramel`
- Redis (host): `redis://127.0.0.1:58006`

Container-internal hostnames: `postgres`, `redis`.

**Note:** `caramel` is the role Docker Compose actually creates (`POSTGRES_USER: caramel` in `docker-compose.yml`), and it is exactly what `apps/caramel-app/.env.example` ships in `DATABASE_URL`/`COUPONS_DATABASE_URL` — copy them as-is.

## Migrations

- `pnpm --filter caramel-app db:migrate:deploy` — applies committed migrations, no prompts, no shadow DB. **This is the onboarding command** (verified against a from-empty Postgres: applies all 3 committed migrations cleanly).
- `pnpm --filter caramel-app db:migrate` — `prisma migrate dev`; creates a shadow database and can prompt for a migration name. Only for authoring a **new** migration, not for onboarding.
- `pnpm --filter caramel-app db:migrate:reset` — drops and recreates the database, then reapplies every migration. Destructive; a local-only escape hatch if your `caramel` DB gets into a bad state.
- `pnpm --filter caramel-app db:push` — pushes `prisma/schema.prisma` directly, no migration history recorded. Not used in this repo's normal flow; listed here only because the script exists.

## Troubleshooting

- **Port already in use**: edit `.env.ports`, then `pnpm compose:down && pnpm dev:compose`.
- **`P1000: Authentication failed` connecting to `caramel`**: your `.env`'s `DATABASE_URL` still has the `.env.example` placeholder credentials — see Connecting above.
- **Coupon routes return 500 / health check shows `coupons_db: error`**: expected in local dev — see Two-database topology above, not a bug in your setup.
- **`pnpm dev:compose` reports containers already running**: another checkout or process on this machine is using the `caramel-local` Compose project name (see the `name:` field in `docker-compose.yml`) — `docker compose -f local-dev/docker-compose.yml ps` to check what's up before assuming something's broken.
- **`pnpm test` fails only on `coupon-constants.generated.test.ts`'s byte-identical check, on Windows, right after a fresh clone**: this repo has no `.gitattributes` normalizing line endings. With the common Windows Git default `core.autocrlf=true`, a fresh checkout converts the committed (LF) `apps/caramel-extension/coupon-constants.generated.js` to CRLF on disk, while the test's live-generated comparison value is always LF — an invisible diff, not a real content change. Not something wrong with your setup; there's no repo-level fix yet. Workaround: `git config core.autocrlf false && git checkout -- apps/caramel-extension/coupon-constants.generated.js` (verified: turns the failure green).
