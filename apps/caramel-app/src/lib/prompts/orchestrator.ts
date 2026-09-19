// src/lib/prompts/orchestrator.ts
//
// ONE growth prompt at a time, app-wide — fleet growth-prompts spec §B. Every
// prompt Caramel may raise on its own (install the extension, use it with your
// AI tools, "more from Devino", promos) registers here with a PURE policy, and
// the host (components/growth/GrowthPromptHost.tsx) asks this module which
// single prompt, if any, owns the slot right now.
//
// PURE — no storage, no DOM, no clock. The host gathers the inputs, this
// decides, so every rule is unit-testable (tests/unit/orchestrator.test.ts).
// Modelled on uNotes' pushNudgePolicy.ts, generalised to a registry.
//
// The fleet-wide priority order. Cookie consent and notifications are listed
// so Caramel's order matches every other app's even though Caramel currently
// has neither (no consent banner, no web push) — a prompt id that does not
// exist here cannot be registered, and adding one later is a one-line edit.
export const PROMPT_PRIORITY = [
    'cookie_consent',
    'install_extension',
    'enable_notifications',
    'ai_tools',
    'cross_app',
    'promo',
] as const

export type PromptId = (typeof PROMPT_PRIORITY)[number]

/** Persisted, per prompt id (lib/prompts/promptStorage.ts). */
export type PromptHistory = {
    lastShownAt: number | null
    dismissals: number
}

export type PromptContext = {
    now: number
    /** `'unknown'` = the SurfaceProvider has not resolved yet: no prompt. */
    surface: 'web' | 'extension' | 'pwa' | 'unknown'
    platform: 'ios' | 'android' | 'macos' | 'windows' | 'unknown'
    browser: 'chrome' | 'edge' | 'firefox' | 'safari' | 'other'
    /** 1 on the first visit ever, counted once per browser session. */
    visits: number
    /** The Settings > "Show tips and prompts" kill switch. */
    promptsEnabled: boolean
    /** ANY prompt has already been shown in this browser session. */
    shownThisSession: boolean
    pathname: string
    signedIn: boolean
    /** Server-known: the account has produced extension activity. `null` when
     * signed out or not loaded — never guessed. */
    hasExtensionActivity: boolean | null
}

export type PromptDecision = { show: false; reason: string } | { show: true }

export interface PromptRegistration {
    id: PromptId
    /** Legally required prompts (cookie consent) ignore the kill switch and
     * the once-per-session rule. Nothing else may set this. */
    exemptFromKillSwitch?: boolean
    decide(context: PromptContext, history: PromptHistory): PromptDecision
}

/** Snooze after a dismissal. */
export const DEFAULT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000

/** Three refusals is an answer. */
export const DEFAULT_MAX_DISMISSALS = 3

export function isSnoozed(
    history: PromptHistory,
    now: number,
    cooldownMs: number = DEFAULT_SNOOZE_MS,
): boolean {
    return (
        history.lastShownAt !== null && now - history.lastShownAt < cooldownMs
    )
}

export function isDismissedForGood(
    history: PromptHistory,
    maxDismissals: number = DEFAULT_MAX_DISMISSALS,
): boolean {
    return history.dismissals >= maxDismissals
}

export type PromptPick = {
    id: PromptId
    registration: PromptRegistration
}

/**
 * The single prompt that owns the slot, or null. Registrations are consulted
 * in PROMPT_PRIORITY order regardless of the order they were registered in;
 * the first whose policy says yes wins.
 */
export function pickPrompt(
    registrations: readonly PromptRegistration[],
    context: PromptContext,
    historyFor: (id: PromptId) => PromptHistory,
): PromptPick | null {
    const seen = new Set<PromptId>()
    for (const registration of registrations) {
        if (seen.has(registration.id)) {
            // Two policies for one slot would make "which one showed" depend
            // on registration order — a silent drift, so it is loud instead.
            throw new Error(
                `growth prompt "${registration.id}" is registered twice`,
            )
        }
        seen.add(registration.id)
    }

    const ordered = [...registrations].sort(
        (a, b) => PROMPT_PRIORITY.indexOf(a.id) - PROMPT_PRIORITY.indexOf(b.id),
    )

    for (const registration of ordered) {
        if (!registration.exemptFromKillSwitch) {
            if (!context.promptsEnabled) continue
            if (context.shownThisSession) continue
            if (context.surface === 'unknown') continue
        }
        const decision = registration.decide(
            context,
            historyFor(registration.id),
        )
        if (decision.show) return { id: registration.id, registration }
    }
    return null
}
