// src/lib/analytics/posthogServer.ts
//
// Server-side PostHog capture for the feedback+observability foundation.
// Lazily initialises a single posthog-node client and exposes a
// never-throwing `captureServerEvent`. The dataset gate is the SERVER var
// (env.ts POSTHOG_DATASET); the capture pair (host/token) is the same project
// pair the browser uses (NEXT_PUBLIC_*, readable server-side via env.client).
import { env } from '@/lib/env'
import { APP_VERSION, clientEnv } from '@/lib/env.client'
import * as Sentry from '@sentry/nextjs'
import { PostHog } from 'posthog-node'
import 'server-only'
import {
    APP_ID,
    resolvePosthogTarget,
    type PosthogTarget,
} from './posthogDataset'

interface ActiveClient {
    client: PostHog
    target: PosthogTarget
}

// Module-scoped singleton — a new client per capture would leak sockets.
let cached: ActiveClient | null = null

/**
 * Resolve the server capture target: gate on the SERVER dataset (POSTHOG_DATASET),
 * take the host/token from the shared NEXT_PUBLIC project pair.
 */
function resolveServerTarget(): PosthogTarget | null {
    return resolvePosthogTarget({
        dataset: env.POSTHOG_DATASET,
        productionHost: clientEnv.NEXT_PUBLIC_POSTHOG_HOST,
        productionKey: clientEnv.NEXT_PUBLIC_POSTHOG_KEY,
        e2eHost: clientEnv.NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_HOST,
        e2eToken: clientEnv.NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_CAPTURE_TOKEN,
    })
}

function getActiveClient(): ActiveClient | null {
    const target = resolveServerTarget()
    if (!target) return null
    if (!cached || cached.target.token !== target.token) {
        // No secretKey/personalApiKey → no background feature-flag polling.
        cached = {
            client: new PostHog(target.token, { host: target.host }),
            target,
        }
    }
    return cached
}

/**
 * Capture one server-side event. Contract:
 *  - no-ops returning `false` when the dataset is disabled/unconfigured;
 *  - stamps app_id / app_version / environment / platform on every event;
 *  - sends reliably via `captureImmediate` (bypasses the batch queue, correct
 *    for a long-running server that never calls shutdown);
 *  - NEVER throws: any failure is reported to Sentry and returns `false`, so
 *    callers can check the boolean (no fire-and-forget).
 */
export async function captureServerEvent(args: {
    event: string
    distinctId: string
    properties?: Record<string, unknown>
    /**
     * Idempotency key for events a client may retry (`extension_installed`).
     * Becomes the event UUID (PostHog dedupes on it) and `$insert_id`. Must be
     * a valid UUID — posthog-node rejects anything else.
     */
    uuid?: string
}): Promise<boolean> {
    try {
        const active = getActiveClient()
        if (!active) return false
        await active.client.captureImmediate({
            distinctId: args.distinctId,
            event: args.event,
            ...(args.uuid ? { uuid: args.uuid } : {}),
            properties: {
                app_id: APP_ID,
                app_version: APP_VERSION,
                environment: active.target.environment,
                platform: 'web',
                ...(args.uuid ? { $insert_id: args.uuid } : {}),
                ...args.properties,
            },
        })
        return true
    } catch (error) {
        Sentry.captureException(error, {
            tags: { operation: 'posthog_capture_server' },
        })
        return false
    }
}

/**
 * The capture project token the server is currently sending to, or null when
 * capture is disabled. Needed to locate the browser's `ph_<token>_posthog`
 * persistence cookie on an incoming request (firstTouchServer.ts).
 */
export function getServerPosthogProjectToken(): string | null {
    return resolveServerTarget()?.token ?? null
}

/**
 * Link a pre-signup anonymous distinct id to the account's id so the visits
 * that led to the signup join the person. Same contract as
 * `captureServerEvent`: never throws, `false` when disabled or on failure
 * (failure reported to Sentry), so callers check the boolean.
 */
export async function aliasServerDistinctId(args: {
    anonymousDistinctId: string
    userId: string
}): Promise<boolean> {
    try {
        const active = getActiveClient()
        if (!active) return false
        await active.client.aliasImmediate({
            distinctId: args.userId,
            alias: args.anonymousDistinctId,
        })
        return true
    } catch (error) {
        Sentry.captureException(error, {
            tags: { operation: 'posthog_alias_server' },
        })
        return false
    }
}
