import {
    cardClasses,
    sectionDescriptionClasses,
    sectionHeaderRowClasses,
    sectionHeadingClasses,
    sectionScrollOffsetClasses,
} from '@/lib/profile/profileStyles'

/**
 * One section = ONE card, with its heading INSIDE it.
 *
 * The previous version put the <h2> and its description outside the card and
 * the content inside, so every section read as a floating label above an
 * unrelated box — and where a section had a control (the savings sync switch)
 * the heading and the control became two disconnected columns with dead space
 * between them. Now the card owns a header row (title left, control right,
 * divider under) and its body, so the relationship is structural instead of
 * implied by proximity.
 *
 * Heading level stays h2: the header band owns the page's single h1 (the
 * user's name) and sub-blocks inside a section use h3. No level is skipped.
 *
 * `sectionScrollOffsetClasses` keeps a deep-linked heading (/profile#savings —
 * the extension popup's entry point) clear of the sticky header AND the mobile
 * chip row.
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
    /** Right-aligned control in the header row (e.g. the sync switch). */
    action?: React.ReactNode
    children: React.ReactNode
}) {
    return (
        <section id={id} className={sectionScrollOffsetClasses}>
            <div className={cardClasses}>
                <div className={sectionHeaderRowClasses}>
                    <div className="min-w-0">
                        <h2 className={sectionHeadingClasses}>{title}</h2>
                        {description ? (
                            <p className={sectionDescriptionClasses}>
                                {description}
                            </p>
                        ) : null}
                    </div>
                    {action ? (
                        <div className="shrink-0 md:w-full">{action}</div>
                    ) : null}
                </div>
                <div className="pt-5">{children}</div>
            </div>
        </section>
    )
}
