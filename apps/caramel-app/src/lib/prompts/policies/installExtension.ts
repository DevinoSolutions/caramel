// src/lib/prompts/policies/installExtension.ts
//
// SLOT 2 — "get the extension". PURE policy + copy for the orchestrator
// (lib/prompts/orchestrator.ts); the host supplies the inputs.
//
// WHEN: on the web surface only (never where the extension already is), never
// on /apps (the page IS the pitch) or the auth pages, only for a browser
// Caramel is actually listed for, from the SECOND visit — or on the first
// visit at a value moment, a store coupon page (`/coupons/<store>`), where a
// shopper has just seen the codes the extension would apply for them. Seven
// day snooze after a dismissal, three refusals is an answer (the shared
// defaults).
import { listingForBrowser } from '@/app/(marketing)/apps/storeListings'
import {
    isDismissedForGood,
    isSnoozed,
    type PromptContext,
    type PromptDecision,
    type PromptHistory,
} from '@/lib/prompts/orchestrator'
import type { GrowthPromptDefinition } from '@/lib/prompts/registry'

const AUTH_PATHS = new Set([
    '/login',
    '/signup',
    '/verify',
    '/forgot-password',
    '/reset-password',
])

/** A coupon listing for one store: the moment the codes are on screen. */
export function isValueMoment(pathname: string): boolean {
    return /^\/coupons\/(?!stores(?:\/|$))[^/]+/.test(pathname)
}

export function decideInstallExtension(
    context: PromptContext,
    history: PromptHistory,
): PromptDecision {
    if (context.surface !== 'web') {
        return { show: false, reason: 'surface_not_web' }
    }
    if (context.pathname.startsWith('/apps')) {
        return { show: false, reason: 'on_apps_page' }
    }
    if (AUTH_PATHS.has(context.pathname)) {
        return { show: false, reason: 'auth_page' }
    }
    if (listingForBrowser(context.browser) === null) {
        return { show: false, reason: 'no_listing_for_browser' }
    }
    if (isDismissedForGood(history)) {
        return { show: false, reason: 'dismissed_for_good' }
    }
    if (isSnoozed(history, context.now)) {
        return { show: false, reason: 'snoozed' }
    }
    if (context.visits < 2 && !isValueMoment(context.pathname)) {
        return { show: false, reason: 'first_visit' }
    }
    return { show: true }
}

export const INSTALL_EXTENSION_PROMPT: GrowthPromptDefinition = {
    id: 'install_extension',
    decide: decideInstallExtension,
    content: context => {
        // decide() has already guaranteed a listing for this browser.
        const listing = listingForBrowser(context.browser)
        const browserLabel = listing?.browserLabel ?? 'your browser'
        return {
            title: `Get Caramel for ${browserLabel}`,
            body: 'Codes apply themselves at checkout on 4,000+ stores. Free, open source, and it never sells your data.',
            acceptLabel: `Add to ${browserLabel}`,
            acceptHref: listing?.href ?? '/apps',
            dismissLabel: 'Not now',
        }
    },
}
