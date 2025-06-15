"use client";

import { motion } from "framer-motion";

export default function SiteCard({ site }) {
    const icon = `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(
        site,
    )}`;

    return (
        <motion.div
            whileHover={{ scale: 1.04 }}
            className="flex items-center gap-5 sm:gap-4 bg-gradient-to-br from-caramel/5 via-orange-50/20 to-caramel/5 dark:from-caramel/10 dark:via-orange-900/10 dark:to-caramel/10 border border-caramel/20 dark:border-caramel/30 rounded-3xl p-6 sm:p-5 shadow-md hover:shadow-lg transition-shadow"
        >
            <img
                src={icon}
                alt={site}
                className="w-14 h-14 sm:w-12 sm:h-12 rounded-md shrink-0"
            />
            <div className="min-w-0">
                <h3 className="text-xl sm:text-lg font-semibold text-gray-800 dark:text-white truncate">
                    {site}
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    Coupons available
                </p>
            </div>
        </motion.div>
    );
}
