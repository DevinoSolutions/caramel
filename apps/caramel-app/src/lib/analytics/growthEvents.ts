'use client'
// src/lib/analytics/growthEvents.ts
//
// The growth-surface events the fleet spec measures weekly (install-prompt
// acceptance, store CTR, cross-app CTR). One typed entry point so the event
// names and their property vocabulary cannot drift between the prompt host,
// the /apps page and the "More from Devino" links.
//
// Browser-only (posthog-js). Best-effort like identity.ts: a capture failure
// is reported (console + Sentry) and swallowed — analytics must never break a
// render, and must never fail silently either.
import * as Sentry from '@sentry/nextjs'
import posthog from 'posthog-js'
import { isPosthogActive } from './identity'

export type GrowthEventName =
    | 'prompt_shown'
    | 'prompt_dismissed'
    | 'prompt_accepted'
    | 'apps_page_view'
    | 'store_badge_click'
    | 'install_cta_click'
    | 'crossapp_click'

export type GrowthEventProperties = {
    prompt_id?: string
    surface?: string
    platform?: string
    browser?: string
    store?: string
    target_app?: string
    /** Which page section an install CTA sat in (`install_cta_click`). */
    placement?: string
}

export function trackGrowthEvent(
    name: GrowthEventName,
    properties: GrowthEventProperties,
): void {
    if (!isPosthogActive()) return
    try {
        posthog.capture(name, properties)
    } catch (error) {
        console.error(`[analytics] growth event "${name}" failed`, error)
        Sentry.captureException(error, {
            tags: { analytics_operation: 'growth_event', event: name },
        })
    }
}
