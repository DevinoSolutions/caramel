import {
    sectionDescriptionClasses,
    sectionHeadingClasses,
} from '@/lib/profile/profileStyles'

/**
 * The <section> + <h2> + description + optional heading-row control that every
 * account-page section is wrapped in.
 *
 * `scroll-mt-28` keeps the sticky floating header off the heading when a
 * section is deep-linked (`/profile#savings` — the extension popup's "Manage
 * account" link lands there). globals.css sets `scroll-behavior: smooth`, so
 * that works with no JS.
 *
 * Heading level is fixed at h2 on purpose: the account header card owns the
 * page's single h1 (the user's name), and sub-blocks inside a section use h3.
 * No level is skipped.
 */
export default function ProfileSection({
    id,
    title,
    description,
    action,
    children,
}: {
    id: string
    title: string
    description?: string
    /** Right-aligned control in the heading row (e.g. the sync switch). */
    action?: React.ReactNode
    children: React.ReactNode
}) {
    return (
        <section id={id} className="scroll-mt-28">
            <div className="mb-4 flex items-start justify-between gap-4 md:flex-col md:gap-3">
                <div className="min-w-0">
                    <h2 className={sectionHeadingClasses}>{title}</h2>
                    {description ? (
                        <p className={sectionDescriptionClasses}>
                            {description}
                        </p>
                    ) : null}
                </div>
                {action ? (
                    <div className="shrink-0 md:self-start">{action}</div>
                ) : null}
            </div>
            {children}
        </section>
    )
}
