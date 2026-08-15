// src/lib/env.ts
//
// Single source of truth for server-side environment variables. Eagerly
// parsed and validated at import time (see src/instrumentation.ts) so a
// misconfigured deploy fails fast at boot with a named-variable error
// instead of failing deep inside a request handler.
//
// Only DATABASE_URL is hard-required, plus at least one auth secret
// (BETTER_AUTH_SECRET or JWT_SECRET, enforced by the .refine() below) — the
// vars proven present in every real boot context (prod Dokploy + CI e2e — see
// apps/caramel-app/scripts/ci-env.ts). Everything else is optional/defaulted so
// `next dev`/`next build` never brick on a feature the current environment
// simply doesn't configure (social login, extension OAuth, email, the
// coupons-bridge sync, ...).
import 'server-only'
import { z } from 'zod'

const serverObjectSchema = z.object({
    // ---- Required (fail-fast) ------------------------------------------
    DATABASE_URL: z.string().min(1, { error: 'DATABASE_URL is required' }),
    // At least one of these two is required — enforced by the .refine()
    // below (kept optional here so either one alone satisfies the schema).
    BETTER_AUTH_SECRET: z.string().min(1).optional(),
    JWT_SECRET: z.string().min(1).optional(),

    // ---- Optional / defaulted -------------------------------------------
    // OPTIONAL bridge-sync input (W4-D3). When set, the out-of-repo coupons
    // bridge job uses it to pull rows from the external, Python-owned
    // caramel_coupons Postgres into the app's OWN catalog (DATABASE_URL);
    // absent → the app just serves its own migrated + seeded catalog and no
    // bridge sync runs (logged once at boot — see instrumentation.ts). The old
    // "required → local degraded mode when unreachable" contract is retired:
    // the catalog lives in DATABASE_URL now. Leave it FULLY UNSET to serve the
    // app-owned catalog; `.min(1)` means a set-but-EMPTY value fails fast as
    // the misconfiguration it is, never accepted as a valid connection string.
    COUPONS_DATABASE_URL: z.string().min(1).optional(),
    BETTER_AUTH_URL: z.string().min(1).optional(),
    BCRYPT_SALT_ROUNDS: z.coerce.number().int().positive().default(10),
    // Catalog freshness window read by GET /api/health/db's checkCatalog
    // (hours, not ms — an ops-facing knob should be set in a unit a human
    // reaches for). Staleness alone never fails the health check; this only
    // tunes when `details.stale` flips true. Default (48h) matches the
    // previously-hardcoded CATALOG_STALE_THRESHOLD_MS.
    CATALOG_MAX_AGE_HOURS: z.coerce.number().int().positive().default(48),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    APPLE_CLIENT_ID: z.string().optional(),
    APPLE_CLIENT_SECRET: z.string().optional(),
    APPLE_REDIRECT_URI: z.string().optional(),
    EXTENSION_OAUTH_STATE_SECRET: z.string().optional(),
    CHROME_EXTENSION_ORIGIN: z.string().optional(),
    FIREFOX_EXTENSION_ORIGIN: z.string().optional(),
    SAFARI_EXTENSION_ORIGIN: z.string().optional(),
    ALLOWED_ORIGINS: z.string().default(''),
    // Server-to-server bearer secret — gates POST /api/coupons/expire and
    // grants the rate-limit trust exemption (src/lib/rateLimit.ts's
    // isTrustedServer). Never shipped to the extension or any other client
    // (F-003 retires the old publicly-shipped extension key, which used to
    // do both jobs from a string baked into the shipped extension).
    COUPONS_ADMIN_SECRET: z.string().optional(),
    // Server-to-server bearer for the coupons pipeline supplier — gates POST
    // /api/ingest/catalog (src/lib/rateLimit.ts's isIngestAuthorized). New in the
    // ownership inversion (the pipeline pushes catalog rows to the app). Optional
    // so a deploy that isn't an ingest target still boots; the route fail-closes
    // (401) when it's unset. Never shipped to any client.
    INGEST_API_KEY: z.string().optional(),
    UPKUMA_HEALTH_SECRET: z.string().optional(),
    // Read directly by the usesend-js SDK — not by our own code — but still
    // part of the validated contract so it's documented and drift-checked.
    USESEND_BASE_URL: z.string().optional(),
    USESEND_API_KEY: z.string().optional(),
    USESEND_FROM_EMAIL: z.string().default('no_reply@grabcaramel.com'),
    USESEND_FROM_NAME: z.string().default('Caramel'),
    // Destination inbox for the user support/feedback flow (POST /api/support).
    // aladdin@devino.ca, NOT support@unotes.net: the old default was a
    // copy-paste from uNotes and BOUNCES (same defect PR #150 fixed in the
    // sites/suggest route — a real visitor's mail was lost to it).
    // Set-but-EMPTY (`SUPPORT_EMAIL_TO=`) resolves to '' and makes the support
    // route report email status 'skipped' (analytics still captured) rather
    // than mailing a blank recipient.
    SUPPORT_EMAIL_TO: z.string().default('aladdin@devino.ca'),
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_MODEL: z.string().default('openai/gpt-5-mini'),
    API_ENCRYPTION_ENABLED: z.string().optional(),
    // Which PostHog project this deploy's SERVER-side captures target (the
    // feedback+observability foundation). 'production' → the real project;
    // 'e2e' → the shared E2E test project (synthetic Playwright traffic, kept
    // isolated by this very dataset switch); 'disabled' → no capture at all.
    // Defaults to 'disabled' so a deploy that doesn't configure PostHog silently
    // no-ops instead of erroring. Must AGREE with the client's
    // NEXT_PUBLIC_POSTHOG_DATASET when both are explicitly set (parseServerEnv
    // fail-fasts on a mismatch).
    POSTHOG_DATASET: z
        .enum(['production', 'e2e', 'disabled'])
        .default('disabled'),
})

const serverSchema = serverObjectSchema.refine(
    data => Boolean(data.BETTER_AUTH_SECRET || data.JWT_SECRET),
    {
        error: 'At least one of BETTER_AUTH_SECRET or JWT_SECRET must be set',
        path: ['BETTER_AUTH_SECRET'],
    },
)

export type ServerEnv = z.infer<typeof serverObjectSchema>

/** Every key the server schema validates — used by the .env.example drift test. */
export const SERVER_ENV_KEYS = Object.keys(
    serverObjectSchema.shape,
) as (keyof ServerEnv)[]

/**
 * Pure, side-effect-free parse. Exported so tests can exercise
 * missing/invalid fixtures without mutating `process.env`. The parameter is
 * a plain string-keyed bag (not `NodeJS.ProcessEnv`) so partial test
 * fixtures — which don't carry every ambient var like `NODE_ENV` — satisfy
 * the type; `process.env` itself is structurally assignable to it.
 */
export function parseServerEnv(
    source: Record<string, string | undefined> = process.env,
): ServerEnv {
    const result = serverSchema.safeParse(source)
    if (!result.success) {
        const details = result.error.issues
            .map(
                issue =>
                    `${issue.path.join('.') || '(root)'}: ${issue.message}`,
            )
            .join('; ')
        throw new Error(`Invalid environment configuration — ${details}`)
    }
    const data = result.data

    // ---- Cross-surface PostHog guards (fail-fast at boot) ----------------
    // (a) The server dataset and the client dataset must not silently
    // disagree. Compared on the RAW source (not the defaulted values) so this
    // only fires when BOTH are explicitly set to different datasets — the case
    // that would ship server events to one project and browser events to
    // another.
    const serverDataset = source.POSTHOG_DATASET
    const clientDataset = source.NEXT_PUBLIC_POSTHOG_DATASET
    if (serverDataset && clientDataset && serverDataset !== clientDataset) {
        throw new Error(
            `Invalid environment configuration — POSTHOG_DATASET (${serverDataset}) and NEXT_PUBLIC_POSTHOG_DATASET (${clientDataset}) disagree; both must name the same PostHog dataset.`,
        )
    }
    // (b) The read-only personal API key is a Playwright/CI-only credential
    // (the eval/verification harness uses it to QUERY PostHog). It must NEVER
    // live in an app/server/container env in ANY dataset mode — its presence
    // here is a key-hygiene violation, so boot fails loudly rather than
    // shipping a query-capable key into a running container.
    if (source.POSTHOG_E2E_TEST_PROJECT_QUERY_READ_ONLY_PERSONAL_API_KEY) {
        throw new Error(
            'Invalid environment configuration — POSTHOG_E2E_TEST_PROJECT_QUERY_READ_ONLY_PERSONAL_API_KEY must never be set in an app/server/container env; it is a Playwright/CI-only read key.',
        )
    }

    return data
}

// Eager singleton — importing this module (see instrumentation.ts) throws
// immediately on a broken env instead of waiting for the first request that
// happens to touch the missing variable.
export const env = parseServerEnv()
