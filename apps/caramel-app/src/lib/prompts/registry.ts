// src/lib/prompts/registry.ts
//
// Every growth prompt Caramel raises on its own, in one list. The host
// (components/growth/GrowthPromptHost.tsx) renders whichever single entry the
// orchestrator picks, so adding a prompt is: write its pure policy, describe
// its card, append it here. Nothing else on the site may mount its own
// growth popup — that is how uNotes ended up with five uncoordinated ones.
import type {
    PromptContext,
    PromptRegistration,
} from '@/lib/prompts/orchestrator'

/** What the shared card shows for a prompt. */
export type PromptCardContent = {
    title: string
    body: string
    acceptLabel: string
    /** A link (opens in a new tab when external) or, when absent, a button. */
    acceptHref?: string
    dismissLabel?: string
}

export interface GrowthPromptDefinition extends PromptRegistration {
    content(context: PromptContext): PromptCardContent
}

/**
 * TODO: growth-prompts step 4 — register `install_extension` (2nd visit or
 * first value moment, 7d snooze, 3 dismissals) and `cross_app` ("More from
 * Devino", audience-matched via the shared manifest) here. Until then the
 * host renders nothing; the orchestrator, caps, kill switch and card are
 * live and unit-tested so those two land as pure policies + copy.
 */
export const GROWTH_PROMPTS: readonly GrowthPromptDefinition[] = []
