import StatTile from '@/components/profile/StatTile'
import { formatMoney } from '@/lib/profile/formatCurrency'
import type { ProfileOverview } from '@/lib/profile/types'

/**
 * The above-the-fold impact numbers.
 *
 * Only tiles with a REAL, non-zero number render, and if none do the whole
 * strip returns null so the get-started checklist takes its place. There is no
 * `$0.00` hero and no grid of zeroes anywhere on this page — a zero state
 * built out of empty stat tiles reads as a broken page.
 *
 * The savings tile shows the LARGEST currency group only. Currencies are never
 * summed together (see the route), so the tile names one real total rather
 * than inventing a combined one; the savings section below carries the full
 * per-currency breakdown.
 *
 * Grid note: these are MAX-width breakpoints — `grid-cols-3` is the desktop
 * layout and `md:`/`xs:` step it down on smaller screens.
 */
export default function ImpactStrip({
    overview,
}: {
    overview: ProfileOverview
}) {
    const { savings, favorites, reports } = overview
    const topTotal = savings.totals[0]

    const tiles: React.ReactNode[] = []

    if (savings.syncEnabled && topTotal && topTotal.minorUnits > 0) {
        tiles.push(
            <StatTile
                key="saved"
                label="Saved with Caramel"
                value={formatMoney(topTotal.minorUnits, topTotal.currency)}
                hint={
                    savings.totals.length > 1
                        ? `plus ${savings.totals.length - 1} more ${
                              savings.totals.length - 1 === 1
                                  ? 'currency'
                                  : 'currencies'
                          }`
                        : undefined
                }
            />,
        )
    }

    if (favorites.length > 0) {
        tiles.push(
            <StatTile
                key="follow"
                label="Stores you follow"
                value={String(favorites.length)}
            />,
        )
    }

    if (reports.reportCount > 0) {
        tiles.push(
            <StatTile
                key="reports"
                label="Coupons you've reported"
                value={String(reports.reportCount)}
            />,
        )
    }

    if (tiles.length === 0) return null

    return (
        <div className="grid grid-cols-3 gap-4 md:grid-cols-2 xs:grid-cols-1">
            {tiles}
        </div>
    )
}
