'use client'

import ProfileSection from '@/components/profile/ProfileSection'
import { CHROME_WEB_STORE_URL } from '@/lib/brandLinks'
import {
    bodyTextClasses,
    secondaryButtonClasses,
} from '@/lib/profile/profileStyles'
import type { ProfileOverview } from '@/lib/profile/types'
import Link from 'next/link'
import { HiCheckCircle } from 'react-icons/hi'

/**
 * The zero state. Renders INSTEAD of the impact strip when every stat is zero,
 * which is how most people arrive at this page.
 *
 * Steps the user has already done render with a filled check and no CTA — the
 * list is a path, not a nag. It never says "0 of 3 complete".
 */
export default function GetStartedChecklist({
    overview,
}: {
    overview: ProfileOverview
}) {
    const steps = [
        {
            key: 'install',
            done: overview.hasExtensionActivity,
            title: 'Install the Caramel extension',
            body: 'Caramel finds and applies codes at checkout for you.',
            cta: { label: 'Get the extension', href: CHROME_WEB_STORE_URL },
        },
        {
            key: 'follow',
            done: overview.favorites.length > 0,
            title: 'Follow the stores you shop',
            body: 'Star a store to keep its best working codes one click away.',
            cta: { label: 'Browse stores', href: '/supported-stores' },
        },
        {
            key: 'sync',
            done: overview.savings.syncEnabled,
            title: 'Turn on savings sync',
            body: 'See everything Caramel has saved you, on every browser you sign in to.',
            cta: { label: 'Set up sync', href: '#savings' },
        },
    ]

    return (
        <ProfileSection
            id="get-started"
            title="Get started with Caramel"
            description="Three things that make Caramel worth having."
        >
            {/* No inner card: ProfileSection already provides the surface, and
                a tinted box inside a white card is the nesting that made this
                page read as a pile of boxes. */}
            <div>
                <ol className="space-y-5">
                    {steps.map(step => (
                        <li
                            key={step.key}
                            className="flex items-start gap-4 xs:gap-3"
                        >
                            {step.done ? (
                                <HiCheckCircle
                                    aria-hidden="true"
                                    className="mt-0.5 h-6 w-6 shrink-0 text-caramel"
                                />
                            ) : (
                                <span
                                    aria-hidden="true"
                                    className="mt-0.5 h-6 w-6 shrink-0 rounded-full border-2 border-caramel/40"
                                />
                            )}
                            <div className="min-w-0 flex-1">
                                <p className="font-semibold text-gray-900 dark:text-white">
                                    {step.title}
                                </p>
                                <p className={`${bodyTextClasses} mt-1`}>
                                    {step.body}
                                </p>
                                {step.done ? null : (
                                    <div className="mt-3">
                                        {step.cta.href.startsWith('http') ? (
                                            <a
                                                href={step.cta.href}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className={
                                                    secondaryButtonClasses
                                                }
                                            >
                                                {step.cta.label}
                                            </a>
                                        ) : (
                                            <Link
                                                href={step.cta.href}
                                                className={
                                                    secondaryButtonClasses
                                                }
                                            >
                                                {step.cta.label}
                                            </Link>
                                        )}
                                    </div>
                                )}
                            </div>
                            {/* Screen readers get the state the check icon
                                conveys visually. */}
                            <span className="sr-only">
                                {step.done ? 'Done' : 'Not done yet'}
                            </span>
                        </li>
                    ))}
                </ol>
            </div>
        </ProfileSection>
    )
}
