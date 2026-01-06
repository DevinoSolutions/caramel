'use client'

import { motion } from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'

export default function SiteCard({ site }: { site: string }) {
    const icon = `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(
        site,
    )}`
    const href = `/coupons/${encodeURIComponent(site)}`

    return (
        <Link href={href} prefetch className="block">
            <motion.div
                whileHover={{ scale: 1.04 }}
                className="from-caramel/5 to-caramel/5 dark:from-caramel/10 dark:to-caramel/10 border-caramel/20 dark:border-caramel/30 flex items-center gap-5 rounded-3xl border bg-gradient-to-br via-orange-50/20 p-6 shadow-md transition-shadow hover:shadow-lg sm:gap-4 sm:p-5 dark:via-orange-900/10"
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
                        Coupons available
                    </p>
                </div>
            </motion.div>
        </Link>
    )
}
