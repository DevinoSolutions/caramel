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

const clientObjectSchema = z.object({
    NEXT_PUBLIC_BASE_URL: z.string().min(1).optional(),
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
    NEXT_PUBLIC_GOOGLE_ANALYTICS_ID: z.string().optional(),
    NEXT_PUBLIC_API_ENCRYPTION_ENABLED: z.string().optional(),
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
 */
export function parseClientEnv(
    runtimeEnv: ClientRuntimeEnv = {
        NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
        NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
        NEXT_PUBLIC_GOOGLE_ANALYTICS_ID:
            process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID,
        NEXT_PUBLIC_API_ENCRYPTION_ENABLED:
            process.env.NEXT_PUBLIC_API_ENCRYPTION_ENABLED,
    },
): ClientEnv {
    // All-optional schema — this never throws, so it's safe to eager-run in
    // the browser (a bad/missing public var must never white-screen the app).
    return clientObjectSchema.parse(runtimeEnv)
}

export const clientEnv = parseClientEnv()

/** Single reconciled base URL — replaces the ~8 scattered `NEXT_PUBLIC_BASE_URL || <fallback>` call sites. */
export const BASE_URL =
    clientEnv.NEXT_PUBLIC_BASE_URL ?? 'https://grabcaramel.com'
