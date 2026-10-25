# caramel-app

Next.js 16 (App Router) web app + API for [grabcaramel.com](https://grabcaramel.com) — marketing site, the logged-in app, and every `/api/*` route the browser extension calls. Auth (Better Auth + Prisma) owns its own Postgres database (`caramel`); coupon data is read from a second, external database owned by a separate Python service (see `src/lib/couponsDb.ts`).

**Setup:** root [README.md](../../README.md)'s Getting Started — this file is just a pointer. Local infra: [`docs/LOCAL-DEV.md`](../../docs/LOCAL-DEV.md). Deploys/health/rollback: [`RUNBOOK.md`](../../RUNBOOK.md).

Commands below assume `cd apps/caramel-app` (or prefix with `pnpm --filter caramel-app` from the repo root):

| Command                                       | Does                                                              |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `pnpm dev`                                    | Dev server, `:28000`                                              |
| `pnpm test` / `pnpm test:e2e`                 | Unit tests (vitest) / e2e (Playwright — needs migrations applied) |
| `pnpm eval`                                   | Cart-classifier AI eval suite — see `evals/README.md`             |
| `pnpm db:migrate:deploy`                      | Apply migrations (the onboarding one — see `docs/LOCAL-DEV.md`)   |
| `pnpm lint` / `pnpm type-check` / `pnpm knip` | Lint / typecheck / unused-code check                              |

Full script list: `package.json`. Coupon-domain constants shared with the extension are **generated**, not hand-written: `pnpm generate:coupon-constants` regenerates `apps/caramel-extension/coupon-constants.generated.js` — never edit that file directly.
