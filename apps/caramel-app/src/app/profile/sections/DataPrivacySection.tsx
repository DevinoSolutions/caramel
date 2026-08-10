'use client'

import ConfirmDialog from '@/components/profile/ConfirmDialog'
import ProfileSection from '@/components/profile/ProfileSection'
import { promptSupportOnFailure } from '@/lib/feedback/promptSupportOnFailure'
import {
    bodyTextClasses,
    dangerButtonClasses,
    dangerFenceClasses,
    secondaryButtonClasses,
    subHeadingClasses,
} from '@/lib/profile/profileStyles'
import type { ProfileOverview } from '@/lib/profile/types'
import { useState } from 'react'
import { toast } from 'sonner'

// Export + danger zone.
//
// TODO: ACCOUNT deletion (removing the login itself) is deliberately NOT here.
// It is a larger job — Better Auth session teardown, extension session
// revocation, an email confirmation step — and shipping a "delete my data"
// button that quietly also deleted the account would be the worst possible
// version of it. The copy below is explicit that the account stays. A later PR
// adds account deletion as its own control in this section.

/** The literal string the server also requires in the request body. Typed on
 * a phone keyboard, so it is DELETE and not the account's email address. */
const CONFIRM_WORD = 'DELETE'

export default function DataPrivacySection({
    overview,
    onDeleted,
}: {
    /** null when the overview failed to load — the danger zone then refuses
     * to offer a delete whose consequences it cannot state. */
    overview: ProfileOverview | null
    onDeleted: () => void
}) {
    const [dialogOpen, setDialogOpen] = useState(false)
    const [busy, setBusy] = useState(false)

    const savingsCount = overview?.savings.eventCount ?? 0
    const favoritesCount = overview?.favorites.length ?? 0
    const reportsCount = overview?.reports.reportCount ?? 0
    const nothingToDelete =
        savingsCount === 0 && favoritesCount === 0 && reportsCount === 0

    async function deleteData() {
        setBusy(true)
        try {
            const res = await fetch('/api/account/data/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                // The confirmation is required SERVER-side too: the typed
                // dialog is a second lock, not the only one.
                body: JSON.stringify({ confirm: CONFIRM_WORD }),
            })
            if (!res.ok) throw new Error(`Delete failed with ${res.status}`)
            setDialogOpen(false)
            toast.success('Your Caramel data has been deleted.')
            onDeleted()
        } catch (error) {
            // The endpoint is transactional, so a failure genuinely means
            // nothing was removed — the copy can say so without hedging.
            toast.error(
                "Couldn't delete your data. Nothing was removed — please try again.",
            )
            promptSupportOnFailure({
                error,
                operation: 'account_data_delete',
            })
        } finally {
            setBusy(false)
        }
    }

    // Only clauses with a real count appear, so the dialog never says
    // "0 followed stores".
    const clauses = [
        savingsCount > 0
            ? `${savingsCount} savings ${savingsCount === 1 ? 'event' : 'events'}`
            : null,
        favoritesCount > 0
            ? `${favoritesCount} followed ${favoritesCount === 1 ? 'store' : 'stores'}`
            : null,
        reportsCount > 0
            ? `${reportsCount} coupon ${reportsCount === 1 ? 'report' : 'reports'}`
            : null,
    ].filter((clause): clause is string => clause !== null)

    return (
        // `title` is a plain string prop, not JSX — an &amp; entity here would
        // render literally.
        <ProfileSection
            id="data"
            title="Data & privacy"
            description="Everything Caramel holds for you, and how to get rid of it."
        >
            <div className="space-y-6">
                {/* Export is plain-weight inside the section card; only the
                    danger zone keeps its own fence, because it should read as
                    a different and more dangerous surface. */}
                <div>
                    <h3 className={subHeadingClasses}>Download your data</h3>
                    <p className={`${bodyTextClasses} mt-2`}>
                        A single JSON file with your account details, the stores
                        you follow, your synced savings, and the codes
                        you&apos;ve reported. Yours to keep.
                    </p>
                    {/* A plain <a download>: the server sets
                        Content-Disposition, so there is no fetch, no blob, and
                        no second place that decides what the file contains. */}
                    <a
                        href="/api/account/export"
                        download
                        className={`${secondaryButtonClasses} mt-4`}
                    >
                        Download my data
                    </a>
                </div>

                <div className={dangerFenceClasses}>
                    <h3 className="text-lg font-semibold text-red-800 dark:text-red-300">
                        Danger zone
                    </h3>
                    <div className="mt-4">
                        <p className="font-semibold text-gray-900 dark:text-white">
                            Delete my Caramel data
                        </p>
                        <p className={`${bodyTextClasses} mt-1`}>
                            Removes the stores you follow, your synced savings
                            history, and your coupon reports. Your account and
                            sign-in stay. This can&apos;t be undone.
                        </p>
                        <button
                            type="button"
                            onClick={() => setDialogOpen(true)}
                            disabled={nothingToDelete}
                            className={`${dangerButtonClasses} mt-4 md:w-full xs:w-full`}
                        >
                            {nothingToDelete
                                ? 'Nothing to delete'
                                : 'Delete my data'}
                        </button>
                    </div>
                </div>
            </div>

            <ConfirmDialog
                open={dialogOpen}
                onClose={() => setDialogOpen(false)}
                onConfirm={deleteData}
                title="Delete your Caramel data?"
                confirmLabel="Delete my data"
                typeToConfirm={CONFIRM_WORD}
                tone="danger"
                busy={busy}
                body={
                    <>
                        <p className={bodyTextClasses}>
                            This permanently removes {clauses.join(', ')}. Your
                            account stays, and Caramel keeps working —
                            you&apos;ll just be starting from zero.
                        </p>
                        <p className={`${bodyTextClasses} mt-3`}>
                            Want a copy first?{' '}
                            <a
                                href="/api/account/export"
                                download
                                className="font-semibold underline underline-offset-2"
                            >
                                Download your data
                            </a>{' '}
                            before you delete.
                        </p>
                    </>
                }
            />
        </ProfileSection>
    )
}
