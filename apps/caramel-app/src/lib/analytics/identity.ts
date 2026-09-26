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
import { captureFirstTouch } from './firstTouch'
import {
    buildIdentityPayload,
    identityPayloadSignature,
    type IdentityUser,
} from './identityProperties'
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

// The environment of the target we actually initialised against, so identify
// can stamp it on the person without re-resolving the env every call.
let activeEnvironment: string | undefined

// Fingerprint of the last identity payload we sent. The session object is
// re-read on every React commit and refreshed periodically, so without this
// the same $set would be re-POSTed on every render of every page.
let lastIdentitySignature: string | null = null

// "First identify opportunity on this page load" — the signup_date fallback
// for a user whose account-creation date we don't have. Captured once so the
// payload fingerprint above stays stable across calls.
const SESSION_STARTED_AT = new Date().toISOString()

/** True once posthog-js has been initialised against a live capture target. */
export function isPosthogActive(): boolean {
    return initialized
}

/**
 * Report an analytics failure loudly (console + Sentry) and swallow it. Every
 * identity call site is best-effort: enrichment must never be able to break a
 * render, but it must also never fail silently.
 */
function reportIdentityFailure(operation: string, error: unknown): void {
    console.error(`[posthog] ${operation} failed`, error)
    // Coarse tag only — the operation name, never the user payload.
    Sentry.captureException(error, { tags: { operation } })
}

/**
 * Browser locale + IANA timezone. Both are read defensively: a locked-down
 * or exotic runtime that throws here must cost us the two properties, not
 * the whole identify call.
 */
function browserIdentityContext(): { locale?: string; timezone?: string } {
    const context: { locale?: string; timezone?: string } = {}
    try {
        if (typeof navigator !== 'undefined' && navigator.language) {
            context.locale = navigator.language
        }
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
        if (timezone) context.timezone = timezone
    } catch (error) {
        reportIdentityFailure('posthog_identity_context', error)
    }
    return context
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
 * Put the app's stable user id in Sentry's USER field — not just in a context
 * blob. The context above carries `posthog_distinct_id`, which reads fine to a
 * human but is invisible to everything Sentry does with identity: "users
 * affected" counts, `user.id:<id>` search, and issue-to-account attribution all
 * read `Sentry.setUser`. Until this call existed, `grep setUser` over the repo
 * returned nothing and no Sentry issue could be tied back to an account.
 *
 * ID ONLY, deliberately: it is the same UUID PostHog identifies on
 * (`identifyUser` below) and the same `users.id` the DB and every API route are
 * keyed by, so one id joins Sentry ↔ PostHog ↔ Postgres. Email is NOT sent —
 * `sendDefaultPii` is off and an error report does not need the address.
 */
export function setSentryUser(userId: string | null): void {
    Sentry.setUser(userId ? { id: userId } : null)
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

    // Record where this visitor came from BEFORE anything else can navigate:
    // the landing URL and the external referrer only exist on the first load,
    // and the first client-side route change erases both. Deliberately ahead
    // of the target check so an attribution-bearing landing is still banked
    // when capture is disabled for this deploy.
    captureFirstTouch()

    const target = resolveClientPosthogTarget()
    if (!target) return false

    const dataset = clientEnv.NEXT_PUBLIC_POSTHOG_DATASET
    const isE2E = dataset === 'e2e'

    posthog.init(target.token, {
        api_host: target.host,
        capture_pageview: 'history_change',
        capture_pageleave: true,
        // Session recording ON, masked to match the Sentry Replay privacy
        // config in instrumentation-client.ts (every input, card + any
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
    activeEnvironment = target.environment

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

/**
 * Associate the current session with the stable internal user UUID and push
 * the enriched person profile.
 *
 * `$set` carries who/what/where NOW (email, display name, surface, version,
 * locale, timezone, account age); `$set_once` carries the acquisition story
 * (signup date, first platform/version, first-touch UTM + referrer + landing
 * path), which PostHog writes exactly once so a later organic session can
 * never overwrite the campaign a user originally arrived from. Identical
 * payloads are skipped, and no failure here can reach the caller.
 */
export function identifyUser(user: IdentityUser): void {
    if (!initialized) return
    // Sentry USER field on the same UUID (main 21cf763). Ahead of the dedupe
    // check on purpose: an identical re-identify is skipped below, and Sentry
    // must still know who this is.
    setSentryUser(user.id)
    try {
        const payload = buildIdentityPayload({
            user,
            context: {
                app_id: APP_ID,
                app_version: APP_VERSION,
                platform: 'web',
                environment: activeEnvironment,
                ...browserIdentityContext(),
            },
            firstTouch: captureFirstTouch(),
            identifiedAt: SESSION_STARTED_AT,
        })

        const signature = identityPayloadSignature(user.id, payload)
        if (signature === lastIdentitySignature) return

        // NEVER email as distinct_id — the stable UUID is the identity; email
        // is a person property only.
        posthog.identify(user.id, payload.set, payload.setOnce)
        lastIdentitySignature = signature
        syncSentryPosthogContext()
    } catch (error) {
        reportIdentityFailure('posthog_identify', error)
    }
}

/** Clear identity on logout (fresh anonymous id + reset Sentry correlation). */
export function resetPosthogIdentity(): void {
    if (!initialized) return
    // Drop the dedupe fingerprint too: after a reset the next identify — even
    // for the same person — must actually re-send the profile.
    lastIdentitySignature = null
    posthog.reset()
    // Clear Sentry's user too, or the next anonymous visitor on this device
    // keeps reporting errors as the account that just logged out.
    setSentryUser(null)
    syncSentryPosthogContext()
}
