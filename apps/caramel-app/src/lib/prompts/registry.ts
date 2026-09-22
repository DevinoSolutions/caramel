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
import { CROSS_APP_PROMPT } from '@/lib/prompts/policies/crossApp'
import { INSTALL_EXTENSION_PROMPT } from '@/lib/prompts/policies/installExtension'

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
 * The live registry. Order here is irrelevant — the orchestrator consults
 * PROMPT_PRIORITY. Each entry's policy lives in lib/prompts/policies/ and is
 * unit-tested on its own.
 */
export const GROWTH_PROMPTS: readonly GrowthPromptDefinition[] = [
    INSTALL_EXTENSION_PROMPT,
    CROSS_APP_PROMPT,
]
