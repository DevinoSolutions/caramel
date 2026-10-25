'use client'

import type { Coupon } from '@/types/coupon'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import { AnimatePresence } from 'framer-motion'
import { useId, useState } from 'react'
import CouponCard from './coupon-card'

interface FailingCodesDisclosureProps {
    /** Codes coupons.ts keepsFailing() flagged, in list order. */
    coupons: Coupon[]
    /** Where the first collapsed code sits in the full list (stagger index only). */
    startIndex: number
    /** More pages remain, so more flagged codes may still arrive: the count reads "N+". */
    moreToLoad?: boolean
    /** Every code in the list is flagged (and none are left to load): say so above the disclosure. */
    allFlagged?: boolean
}

/**
 * The tail of a store's list: codes shoppers keep reporting as not working,
 * collapsed behind one disclosure instead of removed (DESIGN.md §2(q)). They
 * stay copyable and keep their "Reported not working Xh ago" hint, and they are
 * in the server HTML (inside a `hidden` region), so collapsing changes what a
 * shopper sees first, not what the page contains.
 */
export default function FailingCodesDisclosure({
    coupons,
    startIndex,
    moreToLoad = false,
    allFlagged = false,
}: FailingCodesDisclosureProps) {
    const [open, setOpen] = useState(false)
    const regionId = useId()
    if (coupons.length === 0) return null

    // "N+" until the last page is in: the count is exact only then.
    const label = moreToLoad
        ? `${coupons.length}+ codes reported not working`
        : `${coupons.length} ${
              coupons.length === 1 ? 'code' : 'codes'
          } reported not working`

    return (
        <div data-testid="failing-codes" className="mt-2 pb-12">
            {allFlagged ? (
                <p className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-300">
                    {coupons.length === 1
                        ? 'The only code was reported not working'
                        : `All ${coupons.length} codes were reported not working`}
                </p>
            ) : null}
            <button
                type="button"
                aria-expanded={open}
                aria-controls={regionId}
                onClick={() => setOpen(value => !value)}
                className="focus-visible:ring-caramel dark:focus-visible:ring-offset-darkSurface flex w-full items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/60 px-5 py-3 text-left text-sm font-semibold text-amber-800 transition hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300 dark:hover:bg-amber-950/30"
            >
                <span>{label}</span>
                <ChevronDownIcon
                    aria-hidden="true"
                    className={`h-5 w-5 shrink-0 transition-transform ${
                        open ? 'rotate-180' : ''
                    }`}
                />
            </button>
            <div id={regionId} hidden={!open} className="mt-4 space-y-4">
                <p className="text-xs text-gray-600 dark:text-gray-400">
                    These codes were reported as not working by shoppers and the
                    Caramel extension. They may still work for you.
                </p>
                <AnimatePresence mode="popLayout" initial={false}>
                    {coupons.map((coupon, offset) => (
                        <CouponCard
                            key={coupon.id}
                            coupon={coupon}
                            index={startIndex + offset}
                        />
                    ))}
                </AnimatePresence>
            </div>
        </div>
    )
}
