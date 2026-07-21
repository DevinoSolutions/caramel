// src/lib/analytics/posthogDataset.ts
//
// Pure, isomorphic (server- AND browser-safe) dataset-resolution helper for
// the feedback+observability PostHog integration. Deliberately imports NEITHER
// `server-only` NOR `posthog-js`/`posthog-node`, so it can be shared by both
// the browser provider and the server capture module without pulling a
// runtime-specific SDK into the wrong bundle.
import { clientEnv } from '@/lib/env.client'

/** Stable product identifier stamped on every capture (server + browser). */
export const APP_ID = 'caramel' as const

/** The three runtime datasets a deploy can route captures to. */
export type PosthogDataset = 'production' | 'e2e' | 'disabled'

/** A resolved, ready-to-use capture target. `null` means "capture disabled". */
export interface PosthogTarget {
    host: string
    token: string
    /** The `environment` property stamped on captured events. */
    environment: 'production' | 'e2e'
}

/**
 * Pure resolver: given a dataset and the four candidate config strings, return
 * the active capture target, or `null` when disabled/unconfigured. A
 * production/e2e dataset whose pair is incomplete resolves to `null` (no-op)
 * rather than throwing — the loud fail-fast for that lives in the env modules.
 */
export function resolvePosthogTarget(input: {
    dataset: PosthogDataset
    productionHost?: string
    productionKey?: string
    e2eHost?: string
    e2eToken?: string
}): PosthogTarget | null {
    if (input.dataset === 'production') {
        return input.productionHost && input.productionKey
            ? {
                  host: input.productionHost,
                  token: input.productionKey,
                  environment: 'production',
              }
            : null
    }
    if (input.dataset === 'e2e') {
        return input.e2eHost && input.e2eToken
            ? { host: input.e2eHost, token: input.e2eToken, environment: 'e2e' }
            : null
    }
    return null
}

/**
 * Resolve the capture target from the NEXT_PUBLIC_* client env. Usable on the
 * browser AND the server (Next inlines these for the client bundle and exposes
 * them via process.env server-side). The server module gates on its OWN
 * POSTHOG_DATASET (env.ts) but reuses the same project capture pair resolved
 * here.
 */
export function resolveClientPosthogTarget(): PosthogTarget | null {
    return resolvePosthogTarget({
        dataset: clientEnv.NEXT_PUBLIC_POSTHOG_DATASET,
        productionHost: clientEnv.NEXT_PUBLIC_POSTHOG_HOST,
        productionKey: clientEnv.NEXT_PUBLIC_POSTHOG_KEY,
        e2eHost: clientEnv.NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_HOST,
        e2eToken: clientEnv.NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_CAPTURE_TOKEN,
    })
}
