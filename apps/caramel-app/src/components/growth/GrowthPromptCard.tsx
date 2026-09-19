'use client'
// src/components/growth/GrowthPromptCard.tsx
//
// The ONE shared surface every growth prompt renders in: a bottom-right card
// on desktop, a bottom sheet on small screens (fleet growth-prompts spec §B).
// Prompts supply copy; this owns layout, dark mode, focus and the two exits,
// so no prompt can ship its own popup with its own quirks.
import type { PromptCardContent } from '@/lib/prompts/registry'
import { useEffect, useRef } from 'react'
import { FiX } from 'react-icons/fi'

export default function GrowthPromptCard({
    promptId,
    content,
    onAccept,
    onDismiss,
}: {
    promptId: string
    content: PromptCardContent
    onAccept: () => void
    onDismiss: () => void
}) {
    const titleId = `growth-prompt-${promptId}-title`
    const bodyId = `growth-prompt-${promptId}-body`
    const dismissRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') onDismiss()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onDismiss])

    const external =
        content.acceptHref !== undefined &&
        /^https?:\/\//.test(content.acceptHref)

    const acceptClasses =
        'inline-flex items-center justify-center rounded-full bg-caramel px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-caramel'

    return (
        <section
            role="dialog"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            data-growth-prompt={promptId}
            className="fixed bottom-0 left-0 right-0 z-40 rounded-t-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-darkSurface md:bottom-6 md:left-auto md:right-6 md:w-[22rem] md:rounded-2xl sm:bottom-0"
        >
            <button
                ref={dismissRef}
                type="button"
                onClick={onDismiss}
                aria-label="Close"
                className="absolute right-3 top-3 rounded-full p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-100"
            >
                <FiX className="h-4 w-4" aria-hidden="true" />
            </button>
            <h2
                id={titleId}
                className="pr-8 text-base font-semibold text-gray-900 dark:text-gray-50"
            >
                {content.title}
            </h2>
            <p
                id={bodyId}
                className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300"
            >
                {content.body}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
                {content.acceptHref ? (
                    <a
                        href={content.acceptHref}
                        onClick={onAccept}
                        target={external ? '_blank' : undefined}
                        rel={external ? 'noopener noreferrer' : undefined}
                        className={acceptClasses}
                    >
                        {content.acceptLabel}
                    </a>
                ) : (
                    <button
                        type="button"
                        onClick={onAccept}
                        className={acceptClasses}
                    >
                        {content.acceptLabel}
                    </button>
                )}
                <button
                    type="button"
                    onClick={onDismiss}
                    className="text-sm font-medium text-gray-500 underline-offset-4 hover:underline dark:text-gray-400"
                >
                    {content.dismissLabel ?? 'Not now'}
                </button>
            </div>
        </section>
    )
}
