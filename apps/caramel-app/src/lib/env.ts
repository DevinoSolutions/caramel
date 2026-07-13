// src/lib/env.ts
//
// Single source of truth for server-side environment variables. Eagerly
// parsed and validated at import time (see src/instrumentation.ts) so a
// misconfigured deploy fails fast at boot with a named-variable error
// instead of failing deep inside a request handler.
//
// Only the 3 vars proven present in every real boot context (prod Dokploy +
// CI e2e — see apps/caramel-app/scripts/ci-env.ts) are required. Everything
// else is optional/defaulted so `next dev`/`next build` never brick on a
// feature the current environment simply doesn't configure (social login,
// extension OAuth, email, ...).
import 'server-only'
import { z } from 'zod'

const serverObjectSchema = z.object({
    // ---- Required (fail-fast) ------------------------------------------
    DATABASE_URL: z.string().min(1, { error: 'DATABASE_URL is required' }),
    COUPONS_DATABASE_URL: z
        .string()
        .min(1, { error: 'COUPONS_DATABASE_URL is required' }),
    // At least one of these two is required — enforced by the .refine()
    // below (kept optional here so either one alone satisfies the schema).
    BETTER_AUTH_SECRET: z.string().min(1).optional(),
    JWT_SECRET: z.string().min(1).optional(),

    // ---- Optional / defaulted -------------------------------------------
    BETTER_AUTH_URL: z.string().min(1).optional(),
    BCRYPT_SALT_ROUNDS: z.coerce.number().int().positive().default(10),
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
    UPKUMA_HEALTH_SECRET: z.string().optional(),
    // Read directly by the usesend-js SDK — not by our own code — but still
    // part of the validated contract so it's documented and drift-checked.
    USESEND_BASE_URL: z.string().optional(),
    USESEND_API_KEY: z.string().optional(),
    USESEND_FROM_EMAIL: z.string().default('no_reply@grabcaramel.com'),
    USESEND_FROM_NAME: z.string().default('Caramel'),
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_MODEL: z.string().default('openai/gpt-5-mini'),
    API_ENCRYPTION_ENABLED: z.string().optional(),
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
    return result.data
}

// Eager singleton — importing this module (see instrumentation.ts) throws
// immediately on a broken env instead of waiting for the first request that
// happens to touch the missing variable.
export const env = parseServerEnv()
