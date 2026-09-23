'use client'
// src/components/growth/GrowthPromptHost.tsx
//
// The runner behind lib/prompts/orchestrator.ts: gathers the inputs (surface,
// platform, visits, session, kill switch, per-prompt history), asks the pure
// orchestrator which single prompt owns the slot, stamps it as shown BEFORE
// rendering it, and renders the shared card. Mounted once in
// app/providers.tsx; nothing else on the site may raise a growth popup.
//
// The kill switch (Settings > "Show tips and prompts") is read from the
// session user when signed in — the account is the authority, so devices
// agree — and from its localStorage mirror when signed out. Signing in
// refreshes the mirror, so a later signed-out visit on the same browser still
// honours the choice.
import { trackGrowthEvent } from '@/lib/analytics/growthEvents'
import { useSession } from '@/lib/auth/client'
import {
    pickPrompt,
    type PromptContext,
    type PromptId,
} from '@/lib/prompts/orchestrator'
import {
    countVisit,
    markPromptShown,
    readPromptHistory,
    readPromptsEnabled,
    recordPromptDismissed,
    wasAnyPromptShownThisSession,
    writePromptsEnabled,
    type CapStorage,
} from '@/lib/prompts/promptStorage'
import {
    GROWTH_PROMPTS,
    type GrowthPromptDefinition,
} from '@/lib/prompts/registry'
import { useSurface } from '@/lib/surface/SurfaceProvider'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import GrowthPromptCard from './GrowthPromptCard'

function storageOrUndefined(read: () => Storage): CapStorage | undefined {
    try {
        return read()
    } catch {
        // Access itself can throw when site data is blocked; the storage
        // helpers warn on every read/write, so an undefined store here is
        // reported the moment it is used.
        return undefined
    }
}

type ActivePrompt = {
    definition: GrowthPromptDefinition
    context: PromptContext
}

export default function GrowthPromptHost({
    registrations = GROWTH_PROMPTS,
    now = () => Date.now(),
}: {
    /** Overridable for tests; production mounts the registry. */
    registrations?: readonly GrowthPromptDefinition[]
    now?: () => number
}) {
    const surface = useSurface()
    const { data: session } = useSession()
    const pathname = usePathname()
    const [active, setActive] = useState<ActivePrompt | null>(null)
    // Once a prompt has been shown or dismissed in this mount, the slot is
    // closed until the next page load — the session stamp enforces the same
    // rule across mounts.
    const [slotClosed, setSlotClosed] = useState(false)

    const signedIn = !!session?.user
    const serverPromptsEnabled = session?.user.growthPromptsEnabled ?? null

    useEffect(() => {
        if (active || slotClosed) return
        if (surface.surface === 'unknown') return

        const local = storageOrUndefined(() => window.localStorage)
        const sessionStore = storageOrUndefined(() => window.sessionStorage)

        let promptsEnabled: boolean
        if (signedIn && serverPromptsEnabled !== null) {
            promptsEnabled = serverPromptsEnabled
            writePromptsEnabled(local, serverPromptsEnabled)
        } else {
            promptsEnabled = readPromptsEnabled(local) ?? true
        }

        const context: PromptContext = {
            now: now(),
            surface: surface.surface,
            platform: surface.platform,
            browser: surface.browser,
            visits: countVisit({ session: sessionStore, local }),
            promptsEnabled,
            shownThisSession: wasAnyPromptShownThisSession(sessionStore),
            pathname: pathname ?? '/',
            signedIn,
            // The host does not load the account overview on every page; a
            // prompt that needs this reads it as "unknown" and leans on the
            // surface instead. /profile's own CTAs use the real value.
            hasExtensionActivity: null,
        }

        const pick = pickPrompt(registrations, context, id =>
            readPromptHistory(local, id),
        )
        if (!pick) return

        // Shown-stamp BEFORE render, so a tab closed mid-animation counts.
        markPromptShown({ session: sessionStore, local }, pick.id, context.now)
        trackGrowthEvent('prompt_shown', {
            prompt_id: pick.id,
            surface: context.surface,
            platform: context.platform,
            browser: context.browser,
        })
        setActive({
            definition: pick.registration as GrowthPromptDefinition,
            context,
        })
    }, [
        active,
        slotClosed,
        surface,
        signedIn,
        serverPromptsEnabled,
        pathname,
        registrations,
        now,
    ])

    const close = useCallback(
        (outcome: 'prompt_dismissed' | 'prompt_accepted', id: PromptId) => {
            if (outcome === 'prompt_dismissed') {
                recordPromptDismissed(
                    storageOrUndefined(() => window.localStorage),
                    id,
                )
            }
            if (active) {
                trackGrowthEvent(outcome, {
                    prompt_id: id,
                    surface: active.context.surface,
                    platform: active.context.platform,
                    browser: active.context.browser,
                })
            }
            setActive(null)
            setSlotClosed(true)
        },
        [active],
    )

    if (!active) return null
    const { definition, context } = active
    return (
        <GrowthPromptCard
            promptId={definition.id}
            content={definition.content(context)}
            onAccept={() => close('prompt_accepted', definition.id)}
            onDismiss={() => close('prompt_dismissed', definition.id)}
        />
    )
}
