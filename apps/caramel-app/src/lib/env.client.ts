// src/lib/env.client.ts
//
// Single source of truth for NEXT_PUBLIC_* variables. Every var is read as
// a direct, static `process.env.NEXT_PUBLIC_X` expression (inside the
// `parseClientEnv` default parameter below) because Next.js only inlines
// that exact syntactic pattern into the browser bundle — routing the read
// through a variable or destructuring silently resolves to `undefined` in
// the browser. See:
// https://nextjs.org/docs/app/guides/environment-variables#bundling-environment-variables-for-the-browser
//
// All fields are optional: a missing/bad public var must never crash the
// app (required-var fail-fast belongs in env.ts, not here).
import { z } from 'zod'

// Base object (keeps `.shape` for CLIENT_ENV_KEYS + `ClientEnv`). The refined
// `clientSchema` below adds the cross-field pair checks — mirrors the
// serverObjectSchema / serverSchema split in env.ts.
const clientObjectSchema = z.object({
    NEXT_PUBLIC_BASE_URL: z.string().min(1).optional(),
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
    NEXT_PUBLIC_GOOGLE_ANALYTICS_ID: z.string().optional(),
    NEXT_PUBLIC_API_ENCRYPTION_ENABLED: z.string().optional(),
    // ---- Observability: PostHog dataset routing ------------------------
    // Which PostHog project the BROWSER captures target. Mirrors the server's
    // POSTHOG_DATASET (env.ts) and must agree with it (env.ts fail-fasts on a
    // mismatch). Defaults to 'disabled' so an unconfigured build never
    // captures.
    NEXT_PUBLIC_POSTHOG_DATASET: z
        .enum(['production', 'e2e', 'disabled'])
        .default('disabled'),
    // production capture pair (project API key + ingestion host).
    NEXT_PUBLIC_POSTHOG_HOST: z.string().optional(),
    NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
    // shared E2E test-project capture pair — synthetic Playwright traffic is
    // ingested here ONLY, keeping it out of the production dataset.
    NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_HOST: z.string().optional(),
    NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_CAPTURE_TOKEN: z.string().optional(),
    // Build stamp, injected by next.config.mjs from package.json version
    // (never set by hand). Falls back to '0.0.0-dev' via APP_VERSION below.
    NEXT_PUBLIC_APP_VERSION: z.string().optional(),
})

// A configured dataset must carry its capture pair, or capture would silently
// do nothing. 'disabled' requires nothing. These refinements make the STRICT
// parseClientEnv() throw on a misconfigured pair (exercised by tests); the
// eager browser singleton below deliberately swallows that (analytics must
// never white-screen the app), and the real deploy-time fail-fast lives in
// env.ts.
const clientSchema = clientObjectSchema.superRefine((data, ctx) => {
    if (
        data.NEXT_PUBLIC_POSTHOG_DATASET === 'production' &&
        !(data.NEXT_PUBLIC_POSTHOG_HOST && data.NEXT_PUBLIC_POSTHOG_KEY)
    ) {
        ctx.addIssue({
            code: 'custom',
            path: ['NEXT_PUBLIC_POSTHOG_KEY'],
            message:
                'NEXT_PUBLIC_POSTHOG_DATASET=production requires both NEXT_PUBLIC_POSTHOG_HOST and NEXT_PUBLIC_POSTHOG_KEY',
        })
    }
    if (
        data.NEXT_PUBLIC_POSTHOG_DATASET === 'e2e' &&
        !(
            data.NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_HOST &&
            data.NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_CAPTURE_TOKEN
        )
    ) {
        ctx.addIssue({
            code: 'custom',
            path: ['NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_CAPTURE_TOKEN'],
            message:
                'NEXT_PUBLIC_POSTHOG_DATASET=e2e requires both NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_HOST and NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_CAPTURE_TOKEN',
        })
    }
})

export type ClientEnv = z.infer<typeof clientObjectSchema>

/** Every key the client schema validates — used by the .env.example drift test. */
export const CLIENT_ENV_KEYS = Object.keys(
    clientObjectSchema.shape,
) as (keyof ClientEnv)[]

type ClientRuntimeEnv = Partial<Record<keyof ClientEnv, string | undefined>>

/**
 * Pure, side-effect-free parse. The default argument is the ONLY place that
 * needs to change if a NEXT_PUBLIC_* var is added or removed — every key
 * must stay a literal `process.env.NEXT_PUBLIC_X` for Next's build-time
 * inlining to see it (see module comment above).
 *
 * STRICT: throws when a configured PostHog dataset is missing its capture pair
 * (the superRefine above). Callers that must never throw use the guarded
 * `clientEnv` singleton below instead.
 */
export function parseClientEnv(
    runtimeEnv: ClientRuntimeEnv = {
        NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
        NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
        NEXT_PUBLIC_GOOGLE_ANALYTICS_ID:
            process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID,
        NEXT_PUBLIC_API_ENCRYPTION_ENABLED:
            process.env.NEXT_PUBLIC_API_ENCRYPTION_ENABLED,
        NEXT_PUBLIC_POSTHOG_DATASET: process.env.NEXT_PUBLIC_POSTHOG_DATASET,
        NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
        NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
        NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_HOST:
            process.env.NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_HOST,
        NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_CAPTURE_TOKEN:
            process.env.NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_CAPTURE_TOKEN,
        NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
    },
): ClientEnv {
    return clientSchema.parse(runtimeEnv)
}

// Eager browser singleton. A misconfigured PUBLIC var must never white-screen
// the app (the real fail-fast is env.ts at server boot), so a failed strict
// parse degrades to analytics-disabled with a warning instead of throwing.
export const clientEnv: ClientEnv = (() => {
    try {
        return parseClientEnv()
    } catch (error) {
        if (typeof console !== 'undefined') {
            console.warn(
                '[env.client] invalid NEXT_PUBLIC analytics config — analytics disabled in the browser.',
                error,
            )
        }
        return clientObjectSchema.parse({
            NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
            NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
            NEXT_PUBLIC_GOOGLE_ANALYTICS_ID:
                process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID,
            NEXT_PUBLIC_API_ENCRYPTION_ENABLED:
                process.env.NEXT_PUBLIC_API_ENCRYPTION_ENABLED,
            // Force analytics off — the configured dataset lacked its pair.
            NEXT_PUBLIC_POSTHOG_DATASET: 'disabled',
            NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
        })
    }
})()

/** Honest build stamp shared by every capture surface; '0.0.0-dev' when unset. */
export const APP_VERSION = clientEnv.NEXT_PUBLIC_APP_VERSION ?? '0.0.0-dev'

/** Single reconciled base URL — replaces the ~8 scattered `NEXT_PUBLIC_BASE_URL || <fallback>` call sites. */
export const BASE_URL =
    clientEnv.NEXT_PUBLIC_BASE_URL ?? 'https://grabcaramel.com'
