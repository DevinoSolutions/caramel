import { formatMonthYear } from '@/lib/profile/formatCurrency'
import { cardClasses } from '@/lib/profile/profileStyles'
import { userInitial } from '@/lib/userInitial'

/**
 * The page's identity block, and the owner of its single <h1>.
 *
 * The old standalone `<h1>Profile</h1>` is deliberately gone: the user's own
 * name is this page's subject, and a page whose largest element says "Profile"
 * reads as a form rather than a home.
 *
 * Renders immediately from the session — it never waits on the overview fetch,
 * which is why the page has no whole-page spinner.
 */
export default function AccountHeaderCard({
    user,
    memberSince,
}: {
    user: {
        name?: string | null
        email?: string | null
        firstName?: string | null
        lastName?: string | null
    }
    /** ISO from the overview; the line is omitted entirely when absent. */
    memberSince: string | null
}) {
    const avatarLetter = userInitial(user)
    // Never render an empty heading: fall through name parts -> name -> the
    // local part of the email.
    const displayName =
        (user.firstName && user.lastName
            ? `${user.firstName} ${user.lastName}`
            : user.name?.trim()) ||
        user.email?.split('@')[0] ||
        'Your account'
    const since = formatMonthYear(memberSince)

    return (
        <div className={cardClasses}>
            <div className="flex items-center gap-6 xs:gap-4">
                <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-caramel text-2xl font-semibold text-white ring-4 ring-caramel/15 xs:h-16 xs:w-16 xs:text-xl">
                    {avatarLetter}
                </div>
                <div className="min-w-0">
                    <h1 className="truncate text-2xl font-semibold text-gray-900 dark:text-gray-100 xs:text-xl">
                        {displayName}
                    </h1>
                    {user.email ? (
                        <p className="truncate text-gray-600 dark:text-gray-400">
                            {user.email}
                        </p>
                    ) : null}
                    {since ? (
                        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                            Saving with Caramel since {since}
                        </p>
                    ) : null}
                </div>
            </div>
        </div>
    )
}
