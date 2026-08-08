'use client'
// src/lib/analytics/identity.ts
//
// Browser-only PostHog lifecycle: init, identify, reset, and the
// PostHog<->Sentry correlation. Centralises every posthog-js call so the
// provider AND non-provider call sites (e.g. the Header logout) share one
// guarded implementation. Server code must NOT import this (it pulls
// posthog-js) — server captures go through posthogServer.ts.
import { APP_VERSION, clientEnv } from '@/lib/env.client'
import * as Sentry from '@sentry/nextjs'
import posthog from 'posthog-js'
import { APP_ID, resolveClientPosthogTarget } from './posthogDataset'

// Shape Playwright injects via addInitScript in the shared e2e project.
export interface CaramelE2EHandshake {
    test_run_id: string
    test_scenario: string
    distinct_id?: string
}

declare global {
    interface Window {
        __CARAMEL_E2E__?: CaramelE2EHandshake
    }
}

// One-time init guard — React StrictMode / re-renders must not re-init.
let initialized = false

/** True once posthog-js has been initialised against a live capture target. */
export function isPosthogActive(): boolean {
    return initialized
}

/** Push the current PostHog identity/session into Sentry for cross-linking. */
function syncSentryPosthogContext(): void {
    if (!initialized) return
    Sentry.setTag('app_id', APP_ID)
    // High-cardinality IDs go in context, NOT tags.
    Sentry.setContext('posthog', {
        posthog_session_id: posthog.get_session_id(),
        posthog_distinct_id: posthog.get_distinct_id(),
        dataset: clientEnv.NEXT_PUBLIC_POSTHOG_DATASET,
    })
}

/**
 * Initialise posthog-js exactly once, when a capture target is configured.
 * Enables SPA pageviews + pageleave and privacy-preserving session recording,
 * registers the shared super properties, and (in the e2e dataset) accepts
 * synthetic Playwright traffic + registers the test handshake. Returns whether
 * PostHog is now active.
 */
export function initPosthogBrowser(): boolean {
    if (initialized) return true
    if (typeof window === 'undefined') return false

    const target = resolveClientPosthogTarget()
    if (!target) return false

    const dataset = clientEnv.NEXT_PUBLIC_POSTHOG_DATASET
    const isE2E = dataset === 'e2e'

    posthog.init(target.token, {
        api_host: target.host,
        capture_pageview: 'history_change',
        capture_pageleave: true,
        // Session recording ON, masked to match the Sentry Replay privacy
        // config in instrumentation.client.ts (passwords/emails/card + any
        // element explicitly flagged for masking).
        disable_session_recording: false,
        session_recording: {
            maskAllInputs: true,
            maskTextSelector: '[data-sentry-mask], [data-ph-mask]',
            blockSelector: '#card-element',
        },
        // PostHog drops headless/synthetic UAs by default. Accept them ONLY in
        // the shared e2e project so Playwright runs actually land.
        opt_out_useragent_filter: isE2E,
        // Anonymous visitors stay event-only; person profiles are created on
        // identify (main's deliberate choice in 63787ec, preserved here).
        person_profiles: 'identified_only',
    })

    posthog.register({
        app_id: APP_ID,
        app_version: APP_VERSION,
        environment: target.environment,
        platform: 'web',
    })

    initialized = true

    if (isE2E) {
        const handshake = window.__CARAMEL_E2E__
        if (handshake) {
            posthog.register({
                test_run_id: handshake.test_run_id,
                test_scenario: handshake.test_scenario,
            })
            if (handshake.distinct_id) {
                posthog.identify(handshake.distinct_id)
            }
        }
    }

    syncSentryPosthogContext()
    return true
}

/** Associate the current session with the stable internal user UUID. */
export function identifyUser(user: {
    id: string
    email?: string | null
}): void {
    if (!initialized) return
    // NEVER email as distinct_id — the stable UUID is the identity; email is a
    // person property only.
    posthog.identify(user.id, user.email ? { $email: user.email } : undefined)
    syncSentryPosthogContext()
}

/** Clear identity on logout (fresh anonymous id + reset Sentry correlation). */
export function resetPosthogIdentity(): void {
    if (!initialized) return
    posthog.reset()
    syncSentryPosthogContext()
}
