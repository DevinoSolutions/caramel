'use client'

import { formatMoney, formatMonthYear } from '@/lib/profile/formatCurrency'
import {
    headerBandClasses,
    statChipClasses,
    statChipLabelClasses,
    statChipValueClasses,
    teaserChipClasses,
} from '@/lib/profile/profileStyles'
import type { ProfileOverview } from '@/lib/profile/types'
import { userInitial } from '@/lib/userInitial'

/**
 * The page's identity band, and the owner of its single <h1>.
 *
 * This now carries the stat chips too. They used to be a separate 3-column
 * tile row below the card, which had two problems: it was another floating
 * box in a page already made of floating boxes, and because the savings tile
 * is hidden while sync is off, the grid left a visible empty cell where the
 * third tile should be — the row read as unfinished. Chips FLOW, so a missing
 * one closes up, and they belong to the identity they describe.
 *
 * Renders immediately from the session; only the chips wait on the overview,
 * which is why the page has no whole-page spinner.
 */
export default function AccountHeaderCard({
    user,
    overview,
    onTurnOnSync,
}: {
    user: {
        name?: string | null
        email?: string | null
        firstName?: string | null
        lastName?: string | null
    }
    /** null while the overview is still loading or failed — the band renders
     * its identity half regardless and simply omits the chips. */
    overview: ProfileOverview | null
    /** Jumps to the savings section; the teaser chip is a shortcut to the
     * control, never a control of its own. */
    onTurnOnSync: () => void
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
    const since = formatMonthYear(overview?.memberSince ?? null)

    const favorites = overview?.favorites.length ?? 0
    const reports = overview?.reports.reportCount ?? 0
    const syncOn = overview?.savings.syncEnabled ?? false
    const topTotal = overview?.savings.totals[0]

    return (
        <div className={headerBandClasses}>
            <div className="flex items-center gap-6 p-8 md:p-6 xs:gap-4 xs:p-5">
                <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-caramel text-2xl font-semibold text-white ring-4 ring-caramel/15 md:h-16 md:w-16 md:text-xl xs:h-14 xs:w-14 xs:text-lg">
                    {avatarLetter}
                </div>
                <div className="min-w-0">
                    <h1 className="truncate text-2xl font-semibold text-gray-900 dark:text-gray-100 md:text-xl xs:text-lg">
                        {displayName}
                    </h1>
                    {user.email ? (
                        <p className="truncate text-gray-600 dark:text-gray-400 xs:text-sm">
                            {user.email}
                        </p>
                    ) : null}
                    {since ? (
                        <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400 xs:text-xs">
                            Saving with Caramel since {since}
                        </p>
                    ) : null}
                </div>
            </div>

            {/* Chip shelf — a tinted footer of the same surface, not a second
                card. Renders only when there is something true to say. */}
            {overview ? (
                <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50/60 px-8 py-4 dark:border-gray-800 dark:bg-white/[0.03] md:px-6 xs:px-5 xs:py-3.5">
                    {syncOn && topTotal && topTotal.minorUnits > 0 ? (
                        <span className={statChipClasses}>
                            <span className={statChipValueClasses}>
                                {formatMoney(
                                    topTotal.minorUnits,
                                    topTotal.currency,
                                )}
                            </span>
                            <span className={statChipLabelClasses}>saved</span>
                        </span>
                    ) : null}

                    {favorites > 0 ? (
                        <span className={statChipClasses}>
                            <span className={statChipValueClasses}>
                                {favorites}
                            </span>
                            <span className={statChipLabelClasses}>
                                {favorites === 1 ? 'store' : 'stores'} followed
                            </span>
                        </span>
                    ) : null}

                    {reports > 0 ? (
                        <span className={statChipClasses}>
                            <span className={statChipValueClasses}>
                                {reports}
                            </span>
                            <span className={statChipLabelClasses}>
                                {reports === 1 ? 'report' : 'reports'}
                            </span>
                        </span>
                    ) : null}

                    {/* Sync off: an invitation in the space a savings figure
                        would occupy, rather than a gap or a $0.00. */}
                    {syncOn ? null : (
                        <button
                            type="button"
                            onClick={onTurnOnSync}
                            className={teaserChipClasses}
                        >
                            <span aria-hidden="true">✨</span>
                            Turn on sync to see your total
                        </button>
                    )}
                </div>
            ) : null}
        </div>
    )
}
