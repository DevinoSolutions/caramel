'use client'

import ProfileSection from '@/components/profile/ProfileSection'
import SwitchField from '@/components/profile/SwitchField'
import { promptSupportOnFailure } from '@/lib/feedback/promptSupportOnFailure'
import {
    formatEventDate,
    formatMoney,
    formatMonthYear,
} from '@/lib/profile/formatCurrency'
import {
    bodyTextClasses,
    cardClasses,
    codeChipClasses,
    listRowClasses,
    microLabelClasses,
    noticeBodyClasses,
    noticeClasses,
    noticeTitleClasses,
    secondaryButtonClasses,
    subHeadingClasses,
    tintedCardClasses,
} from '@/lib/profile/profileStyles'
import type { ProfileOverview } from '@/lib/profile/types'
import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'

// The savings section. TWO HARD BANS, both about what this page must not
// become (see the blueprint's §3.4):
//
//   NO CHART. recharts is in the dependency list; a line over four savings
//   events is noise, and a chart is the single strongest "financial dashboard"
//   signal there is.
//   NO TABLE. No <table>, no column headers, no right-aligned numeric column.
//
// What it is instead: one warm hero number and a short list of moments.
//
// The switch writes `PATCH /api/account/savings-sync` ({ enabled } ->
// { savingsSyncEnabled }) and renders the PERSISTED value it reads back, never
// its own optimistic guess — the route is the single authority for consent, and
// a switch showing "on" while the account says "off" is the exact drift that
// authority exists to prevent.

const FAVICON_SIZE = 128
const INITIAL_ROWS = 5

function faviconFor(domain: string): string {
    // Built exactly as site-card.tsx does — same source, same size param.
    return `https://www.google.com/s2/favicons?sz=${FAVICON_SIZE}&domain_url=${encodeURIComponent(
        domain,
    )}`
}

export default function SavingsSection({
    savings,
    onSyncChange,
}: {
    savings: ProfileOverview['savings']
    /** Told the confirmed server value so the parent can fold it into the
     * loaded overview — this component never assumes its own write landed. */
    onSyncChange: (enabled: boolean) => void
}) {
    const [busy, setBusy] = useState(false)
    const [expanded, setExpanded] = useState(false)
    const [announcement, setAnnouncement] = useState('')

    async function toggleSync(next: boolean) {
        setBusy(true)
        try {
            const res = await fetch('/api/account/savings-sync', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ enabled: next }),
            })
            if (!res.ok) {
                throw new Error(`Sync toggle failed with ${res.status}`)
            }
            const data = (await res.json()) as { savingsSyncEnabled: boolean }
            // Trust the PERSISTED value, never the value we asked for.
            onSyncChange(data.savingsSyncEnabled)
            if (data.savingsSyncEnabled) {
                toast.success('Savings sync is on.')
                setAnnouncement('Savings sync is on')
            } else {
                toast.success(
                    'Savings sync is off. Your history is still in your account.',
                )
                setAnnouncement('Savings sync is off')
            }
        } catch (error) {
            // Do NOT move the switch — the parent state is untouched, so the
            // knob stays where it was.
            toast.error("Couldn't change that setting. Please try again.")
            promptSupportOnFailure({
                error,
                operation: 'savings_sync_toggle',
            })
        } finally {
            setBusy(false)
        }
    }

    const hasEvents = savings.eventCount > 0
    const [heroTotal, ...otherTotals] = savings.totals
    const sinceLabel = formatMonthYear(savings.firstEventAt)
    const visibleEvents = expanded
        ? savings.recentEvents
        : savings.recentEvents.slice(0, INITIAL_ROWS)

    return (
        <ProfileSection
            id="savings"
            title="Your savings"
            description={
                savings.syncEnabled
                    ? 'What Caramel has taken off your checkouts.'
                    : 'Kept on this device unless you turn on sync.'
            }
            action={
                <SwitchField
                    id="savings-sync"
                    checked={savings.syncEnabled}
                    onChange={next => void toggleSync(next)}
                    busy={busy}
                    label="Sync my savings"
                    description="Store your savings on your Caramel account instead of just this device."
                />
            }
        >
            {/* aria-checked alone does not announce on change in every screen
                reader; this live region does. */}
            <p role="status" aria-live="polite" className="sr-only">
                {announcement}
            </p>

            {!savings.syncEnabled ? (
                <SyncOffBody savings={savings} />
            ) : !hasEvents ? (
                <div className={tintedCardClasses}>
                    <h3 className={subHeadingClasses}>Sync is on</h3>
                    <p className={`${bodyTextClasses} mt-2`}>
                        Nothing to show yet. The next time Caramel lands a code
                        for you, it&apos;ll turn up here.
                    </p>
                    <p className="mt-3 text-xs leading-relaxed text-gray-600 dark:text-gray-400">
                        Sync starts from here. Codes you used before now stay on
                        the device that recorded them.
                    </p>
                </div>
            ) : (
                <div className={cardClasses}>
                    <p className="text-sm font-medium text-gray-600 dark:text-gray-400">
                        You&apos;ve saved
                    </p>
                    <p className="mt-1 text-5xl font-extrabold tracking-tight text-caramel md:text-4xl">
                        {heroTotal
                            ? formatMoney(
                                  heroTotal.minorUnits,
                                  heroTotal.currency,
                              )
                            : null}
                    </p>
                    <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                        across {savings.storeCount}{' '}
                        {savings.storeCount === 1 ? 'store' : 'stores'}
                        {sinceLabel ? ` since ${sinceLabel}` : ''}
                    </p>
                    {/* Currencies are NEVER summed — each extra group gets its
                        own honest line instead of being folded into the hero. */}
                    {otherTotals.map(total => (
                        <p
                            key={total.currency}
                            className="mt-1 text-sm text-gray-600 dark:text-gray-400"
                        >
                            plus {formatMoney(total.minorUnits, total.currency)}{' '}
                            at stores that price in {total.currency}
                        </p>
                    ))}

                    <div className="mt-8 border-t border-gray-100 pt-6 dark:border-gray-800">
                        <p className={microLabelClasses}>Recent savings</p>
                        <div className="mt-3">
                            {visibleEvents.map((event, index) => {
                                const when = formatEventDate(event.occurredAt)
                                return (
                                    <div
                                        key={`${event.occurredAt}-${event.storeDomain}-${index}`}
                                        className={listRowClasses}
                                    >
                                        <Image
                                            src={faviconFor(event.storeDomain)}
                                            alt=""
                                            width={40}
                                            height={40}
                                            className="h-10 w-10 shrink-0 rounded-lg"
                                            unoptimized
                                        />
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate font-medium text-gray-900 dark:text-white">
                                                {event.storeDomain}
                                            </p>
                                            <div className="mt-1 flex items-center gap-2">
                                                {event.code ? (
                                                    <span
                                                        className={
                                                            codeChipClasses
                                                        }
                                                    >
                                                        {event.code}
                                                    </span>
                                                ) : (
                                                    <span className="text-xs text-gray-500 dark:text-gray-400">
                                                        automatic discount
                                                    </span>
                                                )}
                                                {when ? (
                                                    <span className="text-xs text-gray-500 dark:text-gray-400">
                                                        {when}
                                                    </span>
                                                ) : null}
                                            </div>
                                        </div>
                                        {/* The one place green belongs: this
                                            is a saving, not a charge. */}
                                        <p className="shrink-0 font-semibold text-green-700 dark:text-green-400">
                                            −
                                            {formatMoney(
                                                event.amountMinorUnits,
                                                event.currency,
                                            )}
                                        </p>
                                    </div>
                                )
                            })}
                        </div>
                        {savings.recentEvents.length > INITIAL_ROWS ? (
                            <button
                                type="button"
                                onClick={() => setExpanded(v => !v)}
                                className={`${secondaryButtonClasses} mt-4`}
                            >
                                {expanded
                                    ? 'Show less'
                                    : `Show all ${savings.recentEvents.length}`}
                            </button>
                        ) : null}
                    </div>
                </div>
            )}
        </ProfileSection>
    )
}

/**
 * Sync OFF. Two different bodies, because "never turned it on" and "turned it
 * off after syncing" are different situations:
 *
 *  - Never on  -> the pitch.
 *  - Was on, has history -> a notice confirming the history SURVIVED. Toggling
 *    off means "stop sending more", not "erase what I have"; deleting on
 *    toggle-off would make the control non-reversible in practice and
 *    contradict the pitch copy that promises it is. Deletion is a separate,
 *    deliberate act and lives in the danger zone.
 */
function SyncOffBody({ savings }: { savings: ProfileOverview['savings'] }) {
    if (savings.eventCount > 0) {
        return (
            <div className={noticeClasses} role="status">
                <p className={noticeTitleClasses}>Sync is off.</p>
                <p className={noticeBodyClasses}>
                    New savings stay on your device. The {savings.eventCount}{' '}
                    {savings.eventCount === 1 ? 'event' : 'events'} already in
                    your account are still here —{' '}
                    <Link
                        href="#data"
                        className="font-semibold underline underline-offset-2"
                    >
                        delete them from Data &amp; privacy
                    </Link>
                    .
                </p>
            </div>
        )
    }

    return (
        <div className={tintedCardClasses}>
            <h3 className={subHeadingClasses}>Turn on savings sync</h3>
            <p className={`${bodyTextClasses} mt-2`}>
                Right now Caramel keeps your savings on this device only. Turn
                on sync and your total follows you to every browser you sign in
                to.
            </p>
            <dl className="mt-4 space-y-2">
                <div className={bodyTextClasses}>
                    <dt className="inline font-semibold">What gets synced:</dt>{' '}
                    <dd className="inline">
                        the store, the code that worked, how much it saved, and
                        when.
                    </dd>
                </div>
                <div className={bodyTextClasses}>
                    <dt className="inline font-semibold">What never does:</dt>{' '}
                    <dd className="inline">
                        what you bought, your cart, or your order details.
                    </dd>
                </div>
            </dl>
            <p className={`${bodyTextClasses} mt-4`}>
                You can turn this off whenever you like.
            </p>
            <p className="mt-4 text-xs leading-relaxed text-gray-600 dark:text-gray-400">
                Not synced? Your savings still count — they&apos;re just stored
                in the extension on this device.
            </p>
        </div>
    )
}
