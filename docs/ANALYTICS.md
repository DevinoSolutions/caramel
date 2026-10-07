# Analytics: PostHog, first-touch attribution, install and signup events

PostHog is self-hosted (`NEXT_PUBLIC_POSTHOG_HOST`, project 6). Capture is gated by `POSTHOG_DATASET` / `NEXT_PUBLIC_POSTHOG_DATASET` (`production` | `e2e` | `disabled`); the code lives in `apps/caramel-app/src/lib/analytics/`.

## First-party path `/_t/k3v`

In production the browser SDK talks to **`/_t/k3v`** on our own origin instead of the PostHog host, so content blockers that match `posthog` hosts do not eat the events.

- The prefix is ONE constant, `TELEMETRY_PATH` in `src/lib/analytics/telemetryProxy.mjs`, imported by `next.config.mjs` (rewrites) and `posthogHosts.ts` (the SDK's `api_host`). No env var.
- Rewrites (built by `buildTelemetryRewrites`, in this order): `/_t/k3v/static/:path*`, `/_t/k3v/array/:path*`, `/_t/k3v/:path*` to the production PostHog origin. No rewrites for the `e2e`/`disabled` datasets, an empty host, or a `.invalid` build-time placeholder host (DESIGN.md 2(m)).
- `ui_host` stays the real PostHog host (toolbar and links); the server SDK (`posthog-node`) keeps talking to the real host directly.
- posthog-js POSTs to endpoints with a trailing slash (`/_t/k3v/i/v0/e/`), so `next.config.mjs` sets `skipTrailingSlashRedirect: true`. That flag is global; `src/middleware.ts` therefore 308s `/foo/` to `/foo` itself for everything except `/` and the telemetry prefix (`trailingSlashRedirectPath`, one redirect together with the www/https canonicalisation).

## First touch: `cm_ft`

`captureFirstTouch()` (`firstTouch.ts`) records the visitor's first campaign context once: `utm_*`, `ref`, ad click ids (`gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `ttclid`), external `referrer_domain`, `landing_path`, `captured_at`.

- Stored in localStorage (`cm_first_touch`) AND the cookie **`cm_ft`**: URL-encoded JSON, `Path=/`, 90 days, `SameSite=Lax`, `Secure` on https, `Domain` = the apex (so apex, `www` and `dev` share it). Write-once: a later visit never overwrites it.
- Self-referrals (our own domain) and auth hops (Google / Apple sign-in) are not a referrer.
- The schema (`firstTouchRecord.ts`) is shared by the browser writer and the server reader (`firstTouchServer.ts`). An invalid cookie is treated as absent and reported to Sentry.
- Events and person properties carry it as `first_*` (`first_utm_source`, `first_gclid`, ...); `source` is `utm_source` > `ref` > ad click platform > referrer host > `direct`.

## Events

| Event                                    | Where                                                                                               | Key properties                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `signup_started`                         | browser: email submit, Google / Apple buttons                                                       | `method`, `first_*`                                                                                       |
| `signup_completed`                       | server, better-auth `databaseHooks.user.create.after` (every new user) and the extension OAuth mint | `method`, `signup_surface` (`web` / `extension`), `source`, `first_*`; `$set_once` acquisition properties |
| `extension_installed`                    | browser (`/welcome`) AND server (`POST /api/ext/installed`) with the same uuid                      | `store`, `extension_version`, `iid`, `source`, `capture_path` (`browser` / `server`), `first_*`           |
| `install_cta_click`, `store_badge_click` | browser                                                                                             | `placement` / `store`, `first_*`                                                                          |

Details that bite:

- `signup_completed` also writes `users.acquisition` (JSONB, null for accounts created before 2026-10-06): the first-touch record plus `source`, `signup_surface`, `signup_method`; `{ source: 'unknown', ... }` when no cookie reached the server. The pre-signup browser distinct id (from the `ph_<token>_posthog` cookie) is aliased to the user id.
- `users.acquisition` is the user's own data, so `GET /api/account/export` includes it as the top-level `acquisition` block (flat primitives only; the export's forbidden-key guard still runs over it).
- Analytics never blocks a signup: `recordSignup` (`src/lib/auth/signupCapture.ts`) never throws, bounds PostHog to 3 s and reports every failure to Sentry. The hook gets its request from better-auth's `getCurrentAuthContext()` (see the header of `signupHook.ts`).
- The extension mint writes users with raw Prisma (bypassing better-auth hooks), so it calls `recordSignup` itself; it has no request cookie, so those signups are `source: 'unknown'`.
- The extension opens `/welcome?src=ext&store=<chrome|firefox|edge|safari>&v=<version>&iid=<uuid>` on first install only (`runtime.onInstalled`, reason `install`). The `/welcome` page (noindex, disallowed in robots, not in the sitemap) records once per `iid` (localStorage guard) and checks the server's `{ captured }` reply. The shared uuid makes PostHog collapse the browser and server copies of the same install (storage-level dedupe is eventual, not strict).
- There is no paid surface in `apps/caramel-app` (no Stripe / RevenueCat), so no purchase or revenue event exists or is needed.
