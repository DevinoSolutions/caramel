'use client'

import AgentSetupPill from '@/components/growth/AgentSetupPill'
import ProfileSection from '@/components/profile/ProfileSection'
import SwitchField from '@/components/profile/SwitchField'
import { useSession } from '@/lib/auth/client'
import { writePromptsEnabled } from '@/lib/prompts/promptStorage'
import { useState } from 'react'
import { toast } from 'sonner'

// Settings > "Show tips and prompts" — the growth-prompt kill switch (fleet
// growth-prompts spec §B). Free for everyone, never premium-gated. Cookie
// consent is exempt by design, but Caramel has none.
//
// Same contract as the savings-sync switch: writes PATCH /api/account/prompts
// and renders the PERSISTED value it reads back. The localStorage mirror is
// written from that same response, so a later signed-out visit on this
// browser honours the choice, and the session is refetched so the prompt
// host (which reads the session user) sees it without a reload.
export default function PreferencesSection({
    promptsEnabled,
    onChange,
}: {
    promptsEnabled: boolean
    /** Told the confirmed server value so the parent can fold it into the
     * loaded overview — this component never assumes its own write landed. */
    onChange: (enabled: boolean) => void
}) {
    const { refetch } = useSession()
    const [busy, setBusy] = useState(false)

    async function toggle(next: boolean) {
        setBusy(true)
        try {
            const res = await fetch('/api/account/prompts', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ enabled: next }),
            })
            if (!res.ok) {
                throw new Error(`Prompts toggle failed with ${res.status}`)
            }
            const data = (await res.json()) as {
                growthPromptsEnabled: boolean
            }
            onChange(data.growthPromptsEnabled)
            writePromptsEnabled(
                typeof window === 'undefined' ? undefined : window.localStorage,
                data.growthPromptsEnabled,
            )
            refetch()
        } catch (error) {
            console.error('[profile] prompts toggle failed', error)
            toast.error("Couldn't save that. Please try again.")
        } finally {
            setBusy(false)
        }
    }

    return (
        <ProfileSection
            id="preferences"
            title="Preferences"
            description="How Caramel talks to you on the site."
            action={
                <SwitchField
                    id="growth-prompts"
                    checked={promptsEnabled}
                    onChange={next => void toggle(next)}
                    busy={busy}
                    label="Show tips and prompts"
                />
            }
        >
            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                Occasional suggestions — like getting the extension on a new
                browser or trying another Devino app. One at a time, never more
                than one per visit, and off entirely when this is off.
            </p>
            <div className="mt-4">
                <AgentSetupPill surface="profile" />
            </div>
        </ProfileSection>
    )
}
