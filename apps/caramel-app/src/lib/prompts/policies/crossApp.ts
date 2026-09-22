// src/lib/prompts/policies/crossApp.ts
//
// SLOT 5 — "More from Devino": one sibling app whose audience overlaps
// Caramel's, chosen by the SAME manifest rule the /apps page uses
// (app/(marketing)/apps/crossAppPromotions.ts), so the card and the page can
// never disagree about which apps exist.
//
// WHEN: any known surface (a shopper who already has the extension is the
// best audience for a sibling app), never on /apps (it already lists them)
// or the auth pages, from the THIRD visit — this is the lowest-priority
// slot and a first-time visitor has not been sold Caramel yet. Shared snooze
// and refusal caps. The install prompt outranks it in PROMPT_PRIORITY, so on
// the web surface this only shows once that one is snoozed or refused.
//
// TODO(2026-09-22): Dub short links for attribution at the link layer — see
// crossAppPromotions.ts. `crossapp_click`/`prompt_accepted` cover it today.
import { CROSS_APP_PROMOTIONS } from '@/app/(marketing)/apps/crossAppPromotions'
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

export const CROSS_APP_MIN_VISITS = 3

export function decideCrossApp(
    context: PromptContext,
    history: PromptHistory,
    promotions = CROSS_APP_PROMOTIONS,
): PromptDecision {
    if (promotions.length === 0) {
        return { show: false, reason: 'no_promotions' }
    }
    if (context.pathname.startsWith('/apps')) {
        return { show: false, reason: 'on_apps_page' }
    }
    if (AUTH_PATHS.has(context.pathname)) {
        return { show: false, reason: 'auth_page' }
    }
    if (isDismissedForGood(history)) {
        return { show: false, reason: 'dismissed_for_good' }
    }
    if (isSnoozed(history, context.now)) {
        return { show: false, reason: 'snoozed' }
    }
    if (context.visits < CROSS_APP_MIN_VISITS) {
        return { show: false, reason: 'too_early' }
    }
    return { show: true }
}

export const CROSS_APP_PROMPT: GrowthPromptDefinition = {
    id: 'cross_app',
    decide: (context, history) => decideCrossApp(context, history),
    content: () => {
        // decide() has already guaranteed at least one promotion.
        const app = CROSS_APP_PROMOTIONS[0]
        return {
            title: `More from Devino: ${app.name}`,
            body: app.blurb,
            acceptLabel: `Open ${app.name}`,
            acceptHref: app.href,
            dismissLabel: 'Not now',
        }
    },
}
