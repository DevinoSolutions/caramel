'use client'

import { motion } from 'framer-motion'
import SiteCard from './site-card'

/** One tile: the store's domain plus its server-formatted freshness line. */
export type RecentlyAddedStore = {
    site: string
    /** e.g. "Added yesterday" — formatted on the server, see lib/recentStores.ts. */
    addedLabel: string
}

/**
 * The "Recently added" strip on /supported-stores.
 *
 * Renders NOTHING when there is nothing to show. A "Recently added" heading
 * over an empty grid, or over placeholder tiles, would be the one outcome
 * worse than no section at all: this strip exists to be visible proof that
 * requested stores turn into coverage, so it may only ever show stores that
 * really did.
 *
 * The grid is `grid-cols-2 md:grid-cols-1`, the same idiom as the page's other
 * two grids: this project overrides Tailwind's `screens` to MAX-width
 * (tailwind.config.ts), so `md:` reads "at 767px and below", making that
 * two-up on a desktop and one column on a phone — the opposite of what the
 * same class list means under stock Tailwind. Two of these cards cannot fit
 * side by side at 375px (56px favicon + a domain that must not truncate +
 * p-6), so the stacked branch is the one that matters on a phone.
 */
export default function RecentlyAddedSection({
    stores,
}: {
    stores: RecentlyAddedStore[]
}) {
    if (stores.length === 0) return null

    return (
        <section aria-labelledby="recently-added-heading">
            <motion.h2
                id="recently-added-heading"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className="mb-10 border-b border-caramel/15 pb-10 text-center text-2xl font-bold text-gray-800 dark:border-white/10 dark:text-gray-200"
            >
                ✨ Recently added
            </motion.h2>
            <div className="grid grid-cols-2 gap-6 pb-10 md:grid-cols-1">
                {stores.map(store => (
                    <motion.div
                        key={store.site}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3 }}
                    >
                        <SiteCard
                            site={store.site}
                            subtitle={store.addedLabel}
                        />
                    </motion.div>
                ))}
            </div>
        </section>
    )
}
