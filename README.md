[![App Checks](https://github.com/DevinoSolutions/caramel/actions/workflows/checks-app.yml/badge.svg?branch=main)](https://github.com/DevinoSolutions/caramel/actions/workflows/checks-app.yml)
[![Extension Checks](https://github.com/DevinoSolutions/caramel/actions/workflows/checks-extension.yml/badge.svg?branch=main)](https://github.com/DevinoSolutions/caramel/actions/workflows/checks-extension.yml)
[![Discord](https://img.shields.io/discord/1326801110274408478?label=discord&logo=discord&logoColor=white&color=5865F2)](https://discord.gg/2vVVrQ5CEB)

# Caramel - Trusted Coupon Finder

**Caramel is the open‑source, privacy‑first alternative to Honey.**  
It automatically tests codes at checkout, never sells your data, and never overwrites creators’ affiliate links. Today Caramel already supports more than **5 000 stores**. You can find even more information at https://grabcaramel.com.

<a href="https://grabcaramel.com">
  <img width="300" height="180" alt="caramel-banner" src="https://grabcaramel.com/caramel_banner.png" />
</a>

## Why choose Caramel?

- **100% open source** – every release is on GitHub for public audit
- **Privacy first** – the extension only asks for tab access while you shop, nothing more
- **Real‑time savings meter** – see exactly how much a coupon saves you before you commit
- **Creator‑friendly** – Caramel keeps existing affiliate links intact so influencers get the credit they deserve
- **Community‑powered** – join our Discord, file issues, or open PRs to make Caramel even sweeter

- [![Discord](https://img.shields.io/discord/1326801110274408478?label=discord&logo=discord&logoColor=white&color=5865F2)](https://discord.gg/2vVVrQ5CEB)

## Browser support

- Chrome / Edge (Manifest V3)
- Firefox (AMO)
- Safari for macOS and iOS – converted from the Chromium build and re‑skinned automatically during CI

<a href="https://chromewebstore.google.com/detail/caramel/gaimofgglbackoimfjopicmbmnlccfoe" target="_blank" rel="noopener noreferrer">
  <img width="150" height="90" alt="Chrome Web Store badge" src="https://github.com/user-attachments/assets/ac7a688a-9bcd-4073-a769-625e00ac6fa9" />
</a>
<a href="https://apps.apple.com/ke/app/caramel/id6741873881" target="_blank" rel="noopener noreferrer">
  <img width="150" height="90" alt="Download on the App Store badge" src="https://github.com/user-attachments/assets/4169c3ea-ebbd-4526-bafc-d4b82f38fbb1" />
</a>
<a href="https://addons.mozilla.org/en-US/firefox/addon/grabcaramel/" target="_blank" rel="noopener noreferrer">
  <img width="150" height="90" alt="Firefox Add‑ons badge" src="https://github.com/user-attachments/assets/cc3f312c-15ec-4ce4-b821-af067f330dcd" />
</a>
<a href="https://microsoftedge.microsoft.com/addons/detail/caramel/leodahchedhnenmiengkfpmmcdendnof" target="_blank" rel="noopener noreferrer">
  <img width="150" height="90" alt="Edge Add‑ons badge" src="https://github.com/user-attachments/assets/42934453-4bba-4dd3-9dd3-6e580066c923" />
</a>

## Getting Started

Prerequisites: [Node.js](https://nodejs.org) 20+ (CI runs Node 20), [pnpm](https://pnpm.io) 9 (this repo's `packageManager` field — `corepack enable` picks it up), and [Docker](https://www.docker.com/) (for local Postgres/Redis).

1. **Install dependencies** (repo root):

    ```bash
    pnpm install
    ```

2. **Create your env file**:

    ```bash
    cp apps/caramel-app/.env.example apps/caramel-app/.env
    ```

    Then fill it in using the secrets table below — most values are already correct or optional.

3. **Start local infra** (Postgres + Redis, via Docker):

    ```bash
    pnpm dev:compose
    ```

    See [`local-dev/LOCAL-DEV.md`](local-dev/LOCAL-DEV.md) for ports, connection strings, and the two-database topology.

4. **Apply database migrations** (creates the auth-DB schema — nothing does this automatically):

    ```bash
    pnpm --filter caramel-app db:migrate:deploy
    ```

5. **Run it**:

    ```bash
    pnpm dev
    ```

    Opens the web app + API at **http://localhost:58000**. This also launches the extension in a `web-ext`-managed Chromium instance; for the web app only, run `pnpm --filter caramel-app dev` instead.

6. **Run the tests**:

    ```bash
    pnpm test                             # unit — real vitest, both packages (~300 tests)
    pnpm --filter caramel-app test:e2e    # Playwright — needs step 4's migrations applied
    pnpm --filter caramel-app eval        # cart-classifier AI eval — needs OPENROUTER_API_KEY, see apps/caramel-app/evals/README.md
    ```

### Secrets — where each `.env.example` value comes from

`apps/caramel-app/.env` is gitignored and never committed — copy `.env.example` (step 2) and fill it in per this table.

**`DATABASE_URL` — provided by local compose, but verify the value:**

```
postgresql://caramel:caramel_password@localhost:58005/caramel?schema=public
```

This matches what `.env.example` ships — `pnpm dev:compose`'s Postgres creates exactly this `caramel` role (see `local-dev/docker-compose.yml`).

**`COUPONS_DATABASE_URL` — external, not available in local dev:**

Owned by the external Python verification service. `pnpm dev:compose` never provisions a `caramel_coupons` database, so any non-empty value satisfies boot — the app only fails at _query_ time, not startup. The `.env.example` value (`postgresql://caramel:caramel_password@localhost:58005/caramel_coupons`) is correct as shipped, so the only failure you see is the real one: the database not existing. See [`local-dev/LOCAL-DEV.md`](local-dev/LOCAL-DEV.md)'s two-database topology section for the resulting (expected) degraded mode.

**Generate locally (any random string) — at least one of the first two is required:**

| Variable                       | Notes                                       |
| ------------------------------ | ------------------------------------------- |
| `JWT_SECRET`                   |                                             |
| `BETTER_AUTH_SECRET`           |                                             |
| `EXTENSION_OAUTH_STATE_SECRET` | Only needed to test extension OAuth locally |

**Local defaults — already correct in `.env.example`, no action needed:**

| Variable                                   | Shipped value                          |
| ------------------------------------------ | -------------------------------------- |
| `BETTER_AUTH_URL`                          | `http://localhost:58000`               |
| `NEXT_PUBLIC_BASE_URL`                     | `http://localhost:58000`               |
| `BCRYPT_SALT_ROUNDS`                       | `10`                                   |
| `ALLOWED_ORIGINS`                          | blank (same-origin + extensions only)  |
| `USESEND_BASE_URL`                         | `https://usesend.devino.ca`            |
| `USESEND_FROM_EMAIL` / `USESEND_FROM_NAME` | `no_reply@grabcaramel.com` / `Caramel` |
| `OPENROUTER_MODEL`                         | `openai/gpt-5-mini`                    |
| `NODE_ENV`                                 | framework-managed — leave alone        |

**Local-optional — leave blank unless you need the specific feature:**

| Variable                                                                           | Unlocks                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `CHROME_EXTENSION_ORIGIN` / `FIREFOX_EXTENSION_ORIGIN` / `SAFARI_EXTENSION_ORIGIN` | Extension OAuth from a locally-loaded unpacked extension     |
| `COUPONS_ADMIN_SECRET`                                                             | `POST /api/coupons/expire` (server-to-server)                |
| `UPKUMA_HEALTH_SECRET`                                                             | `GET /api/health/db` — any value works, it just has to match |
| `API_ENCRYPTION_ENABLED` / `NEXT_PUBLIC_API_ENCRYPTION_ENABLED`                    | Response encryption — the two flags must agree               |

**Human-only — external provider dashboards, optional for a basic boot:**

| Variable                                                         | Needed for                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                      | Google sign-in                                               |
| `APPLE_CLIENT_ID` / `APPLE_CLIENT_SECRET` / `APPLE_REDIRECT_URI` | Apple sign-in — see `local-dev/APPLE_OAUTH_LOCAL_TESTING.md` |
| `USESEND_API_KEY`                                                | Outgoing email (signup verification, etc.)                   |
| `OPENROUTER_API_KEY`                                             | The cart classifier (`/api/classify-cart`) and `pnpm eval`   |
| `NEXT_PUBLIC_SENTRY_DSN`                                         | Error/APM reporting (no-op locally without it)               |
| `NEXT_PUBLIC_GOOGLE_ANALYTICS_ID`                                | Analytics                                                    |

### Repo layout at a glance

- `apps/caramel-app` — Next.js web app + API (grabcaramel.com)
- `apps/caramel-extension` — browser extension (Chrome/Edge/Firefox/Safari)
- `local-dev/` — local Postgres/Redis compose + local-dev docs
- `RUNBOOK.md` — deploys, health checks, rollback, on-call

Full directory purposes: see [Project layout](#project-layout) below. Local infra detail: [`local-dev/LOCAL-DEV.md`](local-dev/LOCAL-DEV.md). Deploys/ops: [`RUNBOOK.md`](RUNBOOK.md).

## Project layout

| Path                                     | Purpose                                                                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/caramel-app`                       | Web app + API for grabcaramel.com — Next.js, Prisma (auth DB), Better Auth                                                                                                                                            |
| `apps/caramel-extension`                 | Browser extension source (Chrome/Edge/Firefox/Safari)                                                                                                                                                                 |
| `apps/caramel-extension/apple-extension` | Safari macOS/iOS Xcode project — scaffolded via `xcrun safari-web-extension-converter`, checked into git; release CI builds Safari fresh into its own ephemeral project rather than regenerating this one (see below) |
| `local-dev/`                             | Local Postgres/Redis Docker Compose + local-dev docs                                                                                                                                                                  |

### Safari Extension Icons

The Safari Web Extension Converter (`xcrun safari-web-extension-converter`) automatically converts Chrome extension icons to Safari app icons, but it often adds white padding around them. `.github/workflows/scripts/generate-safari-icons.sh` and `update-safari-icons.sh` fix that: they generate and apply properly formatted Safari icons from a single source icon (`apps/caramel-extension/icons/original.png`).

Both scripts run only inside `release-extension.yml`'s Safari publish job (macOS runner; needs ImageMagick + the Xcode project that job's own `xcrun` step generates) — there's no standalone local entry point. Read the workflow file if you need to reproduce a step by hand.

## CI/CD

The project uses GitHub Actions for CI/CD. The workflow is defined in `.github/workflows/`.

For deploys, health checks, rollback, and known failure modes, see [RUNBOOK.md](RUNBOOK.md).

## License

See [LICENSE](LICENSE) file for details.
