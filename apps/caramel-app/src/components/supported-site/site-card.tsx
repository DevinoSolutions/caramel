'use client'

import { storeLogoUrl } from '@/lib/storeLogo'
import { motion } from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'

export default function SiteCard({
    site,
    subtitle = 'Coupons available',
}: {
    site: string
    /**
     * The card's second line. Defaults to the catalog-wide "Coupons available"
     * every existing caller relies on; the "Recently added" strip passes a
     * freshness line ("Added yesterday") instead, because on that strip WHEN
     * the store arrived is the whole point and "Coupons available" is already
     * implied — the strip only lists stores that have visible coupons.
     */
    subtitle?: string
}) {
    const icon = storeLogoUrl(site)
    const href = `/coupons/${encodeURIComponent(site)}`

    return (
        <Link
            href={href}
            prefetch
            className="focus-visible:ring-caramel dark:focus-visible:ring-offset-darkBg block rounded-3xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        >
            <motion.div
                whileHover={{ scale: 1.04 }}
                className="border-caramel/20 from-caramel/5 to-caramel/5 dark:border-caramel/30 dark:from-caramel/10 dark:to-caramel/10 flex items-center gap-5 rounded-3xl border bg-gradient-to-br via-orange-50/20 p-6 shadow-md transition-shadow hover:shadow-lg sm:gap-4 sm:p-5 dark:via-orange-900/10"
            >
                <Image
                    src={icon}
                    alt={site}
                    width={56}
                    height={56}
                    className="h-14 w-14 shrink-0 rounded-md sm:h-12 sm:w-12"
                />
                <div className="min-w-0">
                    <h3 className="truncate text-xl font-semibold text-gray-800 sm:text-lg dark:text-white">
                        {site}
                    </h3>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                        {subtitle}
                    </p>
                </div>
            </motion.div>
        </Link>
    )
}
