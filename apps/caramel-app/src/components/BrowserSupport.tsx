'use client'

import { motion } from 'framer-motion'
import { FaChrome, FaEdge, FaFirefox, FaSafari } from 'react-icons/fa'

interface BrowserSupportProps {
    className?: string
    title?: string
    description?: string
    id?: string
}

const browserData = [
    {
        name: 'Chrome',
        icon: <FaChrome />,
        href: 'https://chromewebstore.google.com/detail/caramel/gaimofgglbackoimfjopicmbmnlccfoe',
        available: true,
    },
    {
        name: 'Safari',
        icon: <FaSafari />,
        href: 'https://apps.apple.com/ke/app/caramel/id6741873881',
        available: true,
    },
    {
        name: 'Firefox',
        icon: <FaFirefox />,
        href: 'https://addons.mozilla.org/en-US/firefox/addon/grabcaramel/',
        available: true,
    },
    {
        name: 'Edge',
        icon: <FaEdge />,
        href: 'https://microsoftedge.microsoft.com/addons/detail/caramel/leodahchedhnenmiengkfpmmcdendnof',
        available: true,
    },
]

export default function BrowserSupport({
    className = '',
    title = 'Available on Your Favorite Browser!',
    description = 'Start saving with Caramel on any browser!',
    id = 'install-extension',
}: BrowserSupportProps) {
    return (
        <motion.div
            id={id}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.2, ease: 'easeOut' }}
            className={`from-caramel rounded-3xl bg-gradient-to-r to-orange-600 p-12 text-center text-black shadow-lg lg:p-8 ${className}`}
        >
            <h3 className="mb-6 text-3xl font-extrabold tracking-tight lg:text-2xl">
                {title}
            </h3>
            <p className="mx-auto mb-8 max-w-2xl text-lg leading-relaxed opacity-90">
                {description}
            </p>
            <div className="flex justify-center gap-6 sm:flex-col sm:items-center sm:gap-4 lg:gap-4">
                {browserData.map((browser, index) => (
                    <motion.div
                        key={browser.name}
                        initial={{ opacity: 0, y: 20 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{
                            duration: 0.4,
                            delay: index * 0.1,
                            type: 'spring',
                            stiffness: 120,
                        }}
                        className="relative"
                    >
                        {browser.available ? (
                            <motion.a
                                href={browser.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                whileHover={{
                                    scale: 1.05,
                                    transition: { duration: 0.2 },
                                }}
                                whileTap={{ scale: 0.95 }}
                                className="text-caramel inline-flex items-center rounded-full bg-white px-8 py-4 font-semibold shadow-md transition-all duration-200 hover:bg-orange-50 hover:shadow-xl md:min-w-[200px]"
                            >
                                <span className="mr-3 text-2xl">
                                    {browser.icon}
                                </span>
                                {browser.name}
                            </motion.a>
                        ) : (
                            <div className="relative inline-flex items-center rounded-full bg-white/20 px-8 py-4 font-semibold text-white/70 shadow-md md:min-w-[200px]">
                                <span className="mr-3 text-2xl opacity-60">
                                    {browser.icon}
                                </span>
                                <span className="opacity-60">
                                    {browser.name}
                                </span>
                                <div className="absolute -right-2 -top-2 rounded-full bg-orange-400 px-2 py-1 text-xs font-bold text-white">
                                    Soon
                                </div>
                            </div>
                        )}
                    </motion.div>
                ))}
            </div>
        </motion.div>
    )
}
