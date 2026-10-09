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
    type AgentId,
} from '@/lib/agentSetup/agentSetup.config'
import {
    trackAgentSetupCopied,
    type AgentSetupSurface,
} from '@/lib/analytics/agentSetupEvents'
import Link from 'next/link'
import { useState } from 'react'
import { FiCheck, FiCopy } from 'react-icons/fi'
import { toast } from 'sonner'

/**
 * Chip glyphs: each agent's real mark (owner request 2026-10-09, replacing
 * the react-icons Claude/OpenAI glyphs and the Cu/Oc monograms). Nominative
 * use: each mark labels the link that sets up THAT tool. Mono paths, so the
 * chip's text colour (incl. hover and dark mode) paints them.
 */
// Brand marks: Lobe Icons (MIT) @lobehub/icons-static-svg@1.95.1
const AGENT_ICON_PATHS: Record<
    AgentId,
    readonly { d: string; clipRule?: true }[]
> = {
    'claude-code': [
        {
            clipRule: true,
            d: 'M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z',
        },
    ],
    codex: [
        {
            clipRule: true,
            d: 'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z',
        },
    ],
    cursor: [
        {
            d: 'M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z',
        },
    ],
    opencode: [{ d: 'M16 6H8v12h8V6zm4 16H4V2h16v20z' }],
    'github-copilot': [
        {
            d: 'M19.245 5.364c1.322 1.36 1.877 3.216 2.11 5.817.622 0 1.2.135 1.592.654l.73.964c.21.278.323.61.323.955v2.62c0 .339-.173.669-.453.868C20.239 19.602 16.157 21.5 12 21.5c-4.6 0-9.205-2.583-11.547-4.258-.28-.2-.452-.53-.453-.868v-2.62c0-.345.113-.679.321-.956l.73-.963c.392-.517.974-.654 1.593-.654l.029-.297c.25-2.446.81-4.213 2.082-5.52 2.461-2.54 5.71-2.851 7.146-2.864h.198c1.436.013 4.685.323 7.146 2.864zm-7.244 4.328c-.284 0-.613.016-.962.05-.123.447-.305.85-.57 1.108-1.05 1.023-2.316 1.18-2.994 1.18-.638 0-1.306-.13-1.851-.464-.516.165-1.012.403-1.044.996a65.882 65.882 0 00-.063 2.884l-.002.48c-.002.563-.005 1.126-.013 1.69.002.326.204.63.51.765 2.482 1.102 4.83 1.657 6.99 1.657 2.156 0 4.504-.555 6.985-1.657a.854.854 0 00.51-.766c.03-1.682.006-3.372-.076-5.053-.031-.596-.528-.83-1.046-.996-.546.333-1.212.464-1.85.464-.677 0-1.942-.157-2.993-1.18-.266-.258-.447-.661-.57-1.108-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zM7.635 5.087c-1.05.102-1.935.438-2.385.906-.975 1.037-.765 3.668-.21 4.224.405.394 1.17.657 1.995.657h.09c.649-.013 1.785-.176 2.73-1.11.435-.41.705-1.433.675-2.47-.03-.834-.27-1.52-.63-1.813-.39-.336-1.275-.482-2.265-.394zm6.465.394c-.36.292-.6.98-.63 1.813-.03 1.037.24 2.06.675 2.47.968.957 2.136 1.104 2.776 1.11h.044c.825 0 1.59-.263 1.995-.657.555-.556.765-3.187-.21-4.224-.45-.468-1.335-.804-2.385-.906-.99-.088-1.875.058-2.265.394zM12 7.615c-.24 0-.525.015-.84.044.03.16.045.336.06.526l-.001.159a2.94 2.94 0 01-.014.25c.225-.022.425-.027.612-.028h.366c.187 0 .387.006.612.028-.015-.146-.015-.277-.015-.409.015-.19.03-.365.06-.526a9.29 9.29 0 00-.84-.044z',
        },
    ],
}

function AgentGlyph({ id }: { id: AgentId }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            fillRule="evenodd"
            className="h-3.5 w-3.5"
            aria-hidden="true"
            focusable="false"
            data-agent-icon={id}
        >
            {AGENT_ICON_PATHS[id].map(path => (
                <path
                    key={path.d}
                    d={path.d}
                    clipRule={path.clipRule ? 'evenodd' : undefined}
                />
            ))}
        </svg>
    )
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
        if (ok) {
            // Only a real copy counts; a denied clipboard is not a conversion.
            trackAgentSetupCopied({ surface, agent: 'copy' })
            setCopied(true)
            toast.success(AGENT_SETUP_TOAST)
            window.setTimeout(() => setCopied(false), 2000)
        } else {
            toast.error(
                'Could not copy. The sentence is on the agent setup page.',
            )
        }
    }

    return (
        <div
            data-agent-setup-pill={surface}
            className={`inline-flex max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-caramel/40 bg-white/80 py-1.5 pl-4 pr-2 text-sm text-gray-900 shadow-caramel-sm backdrop-blur-sm dark:bg-darkSurface dark:text-gray-100 ${className}`}
        >
            <button
                type="button"
                onClick={() => void onCopy()}
                aria-label={`Onboard your agent to ${APP_NAME}: copy the setup prompt`}
                className="inline-flex items-center gap-2 rounded-full font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-caramel"
            >
                <span>Onboard your agent to {APP_NAME}</span>
                {copied ? (
                    <FiCheck
                        className="h-4 w-4 text-green-600"
                        aria-hidden="true"
                    />
                ) : (
                    <FiCopy
                        className="h-4 w-4 text-caramel"
                        aria-hidden="true"
                    />
                )}
            </button>
            <span
                role="group"
                className="flex items-center gap-1"
                aria-label="Agent guides"
            >
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
