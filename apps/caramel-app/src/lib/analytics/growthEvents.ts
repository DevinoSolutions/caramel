'use client'
// src/lib/analytics/growthEvents.ts
//
// The growth-surface events the fleet spec measures weekly (install-prompt
// acceptance, store CTR, cross-app CTR). One typed entry point so the event
// names and their property vocabulary cannot drift between the prompt host,
// the /apps page and the "More from Devino" links.
//
// Browser-only (posthog-js, via posthogBrowser.ts, which queues a capture
// fired while the SDK loads). Best-effort like identity.ts: a capture failure
// is reported (console + Sentry) and swallowed — analytics must never break a
// render, and must never fail silently either.
import * as Sentry from '@sentry/nextjs'
import { captureFirstTouch } from './firstTouch'
import { buildFirstTouchProperties } from './identityProperties'
import { capturePosthog } from './posthogBrowser'
import type { SignupMethod } from './signupVocabulary'

export type GrowthEventName =
    | 'prompt_shown'
    | 'prompt_dismissed'
    | 'prompt_accepted'
    | 'apps_page_view'
    | 'store_badge_click'
    | 'install_cta_click'
    | 'crossapp_click'
    | 'signup_started'

/** Which page an in-content install CTA sat on (`install_cta_click`). */
export type InstallCtaPlacement =
    | 'supported_stores'
    | 'compare_extensions'
    | 'honey_extension'

export type GrowthEventProperties = {
    prompt_id?: string
    surface?: string
    platform?: string
    browser?: string
    store?: string
    target_app?: string
    placement?: InstallCtaPlacement
    /** `signup_started`: how the visitor chose to sign up. */
    method?: SignupMethod
}

// The conversion-path events. Each carries the visitor's first-touch source
// (`first_utm_source`, `first_gclid`, ...) on the event itself, not only on the
// person profile: the profile is written once at identify, but "which campaign
// produced the install click / signup start" is a question about the event.
const FIRST_TOUCH_EVENTS: ReadonlySet<GrowthEventName> =
    new Set<GrowthEventName>([
        'install_cta_click',
        'store_badge_click',
        'signup_started',
    ])

export function trackGrowthEvent(
    name: GrowthEventName,
    properties: GrowthEventProperties,
): void {
    // Caller properties win over the first-touch ones (they never collide
    // today: first-touch keys are all `first_*`).
    const enriched = FIRST_TOUCH_EVENTS.has(name)
        ? { ...buildFirstTouchProperties(captureFirstTouch()), ...properties }
        : properties
    capturePosthog(name, enriched, error => {
        console.error(`[analytics] growth event "${name}" failed`, error)
        Sentry.captureException(error, {
            tags: { analytics_operation: 'growth_event', event: name },
        })
    })
}
