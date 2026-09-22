'use client'
// src/components/growth/AgentSetupPill.tsx
//
// "Onboard your agent to Caramel" — the ONE component every surface mounts
// (hero, /apps, /profile preferences, /agent-setup), copied from Cloudflare's
// developer-docs mechanism per the fleet agent-onboarding spec §1. Clicking
// the pill or the copy icon puts AGENT_SETUP_COPY_TEXT on the clipboard; the
// small agent chips open the human guide for that agent. The copied sentence
// lives in agentSetup.config.ts — the same manifest prompt.md renders from.
import {
    AGENT_GUIDES,
    AGENT_SETUP_COPY_TEXT,
    AGENT_SETUP_PATH,
    AGENT_SETUP_TOAST,
    APP_NAME,
} from '@/lib/agentSetup/agentSetup.config'
import {
    trackAgentSetupCopied,
    type AgentSetupSurface,
} from '@/lib/analytics/agentSetupEvents'
import Link from 'next/link'
import { useState } from 'react'
import { FiCheck, FiCopy } from 'react-icons/fi'
import { SiClaude, SiGithubcopilot, SiOpenai } from 'react-icons/si'
import { toast } from 'sonner'

/**
 * Chip glyphs. Claude, OpenAI (Codex) and GitHub Copilot have brand icons in
 * react-icons; Cursor and OpenCode do not, so they get a monogram rather than
 * a redrawn lookalike logo (same no-lookalike rule as the store badges).
 */
function AgentGlyph({ id }: { id: string }) {
    const cls = 'h-3.5 w-3.5'
    switch (id) {
        case 'claude-code':
            return <SiClaude className={cls} aria-hidden="true" />
        case 'codex':
            return <SiOpenai className={cls} aria-hidden="true" />
        case 'github-copilot':
            return <SiGithubcopilot className={cls} aria-hidden="true" />
        case 'cursor':
            return (
                <span className="text-[10px] font-bold leading-none" aria-hidden="true">
                    Cu
                </span>
            )
        default:
            return (
                <span className="text-[10px] font-bold leading-none" aria-hidden="true">
                    Oc
                </span>
            )
    }
}

async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text)
        return true
    } catch (error) {
        // Clipboard access can be denied (insecure context, permissions);
        // report it and let the caller show the text instead.
        console.error('[agent-setup] clipboard write failed', error)
        return false
    }
}

export default function AgentSetupPill({
    surface,
    className = '',
}: {
    surface: AgentSetupSurface
    className?: string
}) {
    const [copied, setCopied] = useState(false)

    const onCopy = async () => {
        const ok = await copyText(AGENT_SETUP_COPY_TEXT)
        trackAgentSetupCopied({ surface, agent: 'copy' })
        if (ok) {
            setCopied(true)
            toast.success(AGENT_SETUP_TOAST)
            window.setTimeout(() => setCopied(false), 2000)
        } else {
            toast.error('Could not copy. The sentence is on the agent setup page.')
        }
    }

    return (
        <div
            data-agent-setup-pill={surface}
            className={`inline-flex max-w-full flex-wrap items-center gap-2 rounded-full border border-caramel/40 bg-white/80 py-1.5 pl-4 pr-2 text-sm text-gray-900 shadow-caramel-sm backdrop-blur-sm dark:bg-darkSurface dark:text-gray-100 ${className}`}
        >
            <button
                type="button"
                onClick={() => void onCopy()}
                aria-label={`Copy the ${APP_NAME} agent setup prompt`}
                className="inline-flex items-center gap-2 rounded-full font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-caramel"
            >
                <span>Onboard your agent to {APP_NAME}</span>
                {copied ? (
                    <FiCheck className="h-4 w-4 text-green-600" aria-hidden="true" />
                ) : (
                    <FiCopy className="h-4 w-4 text-caramel" aria-hidden="true" />
                )}
            </button>
            <span className="flex items-center gap-1" aria-label="Agent guides">
                {AGENT_GUIDES.map(guide => (
                    <Link
                        key={guide.id}
                        href={`${AGENT_SETUP_PATH}/${guide.id}`}
                        title={`${guide.name} setup guide`}
                        aria-label={`${guide.name} setup guide`}
                        onClick={() =>
                            trackAgentSetupCopied({ surface, agent: guide.id })
                        }
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-gray-700 transition-colors hover:bg-caramel hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-caramel dark:bg-white/10 dark:text-gray-200"
                    >
                        <AgentGlyph id={guide.id} />
                    </Link>
                ))}
            </span>
        </div>
    )
}
