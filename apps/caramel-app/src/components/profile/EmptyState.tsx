import { bodyTextClasses, subHeadingClasses } from '@/lib/profile/profileStyles'

/**
 * The teaching empty state: an icon, a headline, body copy, and the actions
 * that make the emptiness go away.
 *
 * This page's DEFAULT state is empty — most people arrive with no savings, no
 * favorites and no reports — so an empty section is the common case, not an
 * edge case. It never says "no data": it says what the feature is for and how
 * to start it.
 */
export default function EmptyState({
    icon,
    heading,
    body,
    footnote,
    actions,
}: {
    /** Decorative — the heading already names the thing. */
    icon: React.ReactNode
    heading: string
    body: string
    footnote?: string
    actions?: React.ReactNode
}) {
    return (
        <div className="text-center">
            <div
                aria-hidden="true"
                className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-caramel/10 text-2xl text-caramel dark:bg-caramel/20"
            >
                {icon}
            </div>
            <h3 className={subHeadingClasses}>{heading}</h3>
            <p className={`${bodyTextClasses} mx-auto mt-2 max-w-md`}>{body}</p>
            {footnote ? (
                <p className="mx-auto mt-3 max-w-md text-xs leading-relaxed text-gray-600 dark:text-gray-400">
                    {footnote}
                </p>
            ) : null}
            {actions ? (
                <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                    {actions}
                </div>
            ) : null}
        </div>
    )
}
