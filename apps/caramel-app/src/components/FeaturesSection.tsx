'use client'

import { motion } from 'framer-motion'
import {
    FaBolt,
    FaChrome,
    FaDollarSign,
    FaEdge,
    FaFirefox,
    FaGlobe,
    FaHeart,
    FaLock,
    FaSafari,
    FaStar,
} from 'react-icons/fa'
import { HiCheckCircle, HiXCircle } from 'react-icons/hi'

const features = [
    {
        title: 'Automated Coupon Application',
        desc: 'Saves you money by finding and applying the best coupon codes.',
        detail: 'We monitor thousands of coupon codes across 5,000+ stores, ensuring you always get the best deal without lifting a finger.',
        icon: <FaDollarSign />,
    },
    {
        title: 'Privacy-First & Transparent',
        desc: "Your data stays yours. We don't track, sell, or monetize your information.",
        detail: 'Unlike other extensions, we never collect personal data, track your browsing, or hijack affiliate commissions from content creators.',
        icon: <FaLock />,
    },
    {
        title: '100% Open Source',
        desc: 'Our entire codebase is public and community-driven.',
        detail: 'Join our GitHub to contribute features, report issues, or request enhancements. Audited by security professionals for your peace of mind.',
        icon: <FaStar />,
    },
    {
        title: 'Creator-Friendly',
        desc: 'We never overwrite affiliate links or steal commissions.',
        detail: 'Support your favorite content creators while saving money. We ensure affiliate links stay with their rightful owners.',
        icon: <FaHeart />,
    },
    {
        title: 'Lightning Fast',
        desc: 'Instant coupon discovery and application at checkout.',
        detail: 'Our optimized algorithms search and apply coupons in seconds, never slowing down your shopping experience.',
        icon: <FaBolt />,
    },
    {
        title: 'Cross-Browser Support',
        desc: 'Works seamlessly across Chrome, Firefox, and more.',
        detail: 'One extension, all browsers. Consistent experience regardless of your browser preference with automatic updates.',
        icon: <FaGlobe />,
    },
]

const comparisonItems = [
    {
        title: 'Privacy Protection',
        other: 'Sells your personal data',
        caramel: '100% privacy-first approach',
    },
    {
        title: 'Data Collection',
        other: 'Tracks your browsing habits',
        caramel: 'Zero tracking or data collection',
    },
    {
        title: 'Creator Support',
        other: 'Hijacks affiliate commissions',
        caramel: 'Protects creator earnings',
    },
    {
        title: 'Code Transparency',
        other: 'Closed source & hidden',
        caramel: 'Fully open source & audited',
    },
    {
        title: 'Performance',
        other: 'Slow and resource-heavy',
        caramel: 'Lightning fast & lightweight',
    },
]

export default function FeaturesSection() {
    return (
        <section id="features" className="relative overflow-hidden py-32">
            {/* Background Elements */}
            <div className="absolute inset-0">
                <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-caramel/20 to-transparent"></div>
                <div className="absolute bottom-0 left-0 h-px w-full bg-gradient-to-r from-transparent via-caramel/20 to-transparent"></div>
            </div>

            <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
                {/* Header Section */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, ease: 'easeOut' }}
                    className="mb-20 text-center"
                >
                    <h2 className="mb-8 text-5xl font-extrabold text-caramel lg:text-4xl">
                        Why Choose Caramel?
                    </h2>
                    <p className="mx-auto max-w-3xl text-xl leading-relaxed text-gray-600 dark:text-gray-300 lg:text-lg">
                        The ethical alternative that puts your privacy first
                        while maximizing your savings
                    </p>
                </motion.div>

                {/* Features Grid */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.2, ease: 'easeOut' }}
                    className="mb-24"
                >
                    <div className="grid grid-cols-3 gap-8 lg:grid-cols-2 sm:grid-cols-1">
                        {features.map((feat, index) => (
                            <motion.div
                                key={feat.title}
                                initial={{
                                    opacity: 0,
                                    x: index % 2 === 0 ? -50 : 50,
                                }}
                                whileInView={{ opacity: 1, x: 0 }}
                                viewport={{ once: true }}
                                transition={{
                                    duration: 0.6,
                                    delay: index * 0.1,
                                    type: 'spring',
                                    stiffness: 100,
                                    damping: 15,
                                }}
                                whileHover={{
                                    scale: 1.02,
                                    y: -5,
                                    boxShadow:
                                        '0 20px 40px rgba(234,105,37,0.15)',
                                    transition: { duration: 0.2 },
                                }}
                                className="group relative overflow-hidden rounded-2xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-8 shadow-md dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10 sm:p-6"
                            >
                                {/* Animated Background Pattern */}
                                <div className="absolute inset-0 opacity-5">
                                    <motion.div
                                        className="h-full w-full"
                                        style={{
                                            backgroundImage: `
                                                linear-gradient(90deg, #ea6925 1px, transparent 1px),
                                                linear-gradient(#ea6925 1px, transparent 1px)
                                            `,
                                            backgroundSize: '20px 20px',
                                        }}
                                        animate={{
                                            backgroundPosition: [
                                                '0px 0px',
                                                '20px 20px',
                                                '0px 0px',
                                            ],
                                        }}
                                        transition={{
                                            duration: 8,
                                            repeat: Infinity,
                                            ease: 'linear',
                                            repeatType: 'loop',
                                        }}
                                    />
                                </div>

                                <div className="relative z-10 text-center">
                                    {/* Large icon - hidden on lg and down */}
                                    <motion.div
                                        className="mx-auto mb-6 text-6xl text-caramel transition-transform duration-300 xl:block lg:hidden"
                                        animate={{
                                            rotate: [0, 2, -2, 0],
                                            scale: [1, 1.02, 1],
                                        }}
                                        transition={{
                                            duration: 4,
                                            repeat: Infinity,
                                            ease: 'easeInOut',
                                            repeatType: 'loop',
                                        }}
                                        whileHover={{ scale: 1.1 }}
                                    >
                                        {feat.icon}
                                    </motion.div>

                                    {/* Mobile layout - icon + title in one row */}
                                    <div className="hidden text-left lg:block">
                                        <div className="mb-3 flex items-center">
                                            <span className="mr-3 flex-shrink-0 text-2xl text-caramel">
                                                {feat.icon}
                                            </span>
                                            <h3 className="text-2xl font-bold tracking-tight text-gray-800 dark:text-white sm:text-xl">
                                                {feat.title}
                                            </h3>
                                        </div>
                                        <p className="ml-11 text-base leading-relaxed text-gray-600 dark:text-gray-400 sm:text-sm">
                                            {feat.desc}
                                        </p>
                                    </div>

                                    {/* Desktop layout - original centered layout */}
                                    <div className="xl:block lg:hidden">
                                        <h3 className="mb-4 text-3xl font-bold tracking-tight text-gray-800 dark:text-white sm:text-2xl">
                                            {feat.title}
                                        </h3>
                                        <p className="mb-4 text-lg leading-relaxed text-gray-600 dark:text-gray-400 sm:text-base">
                                            {feat.desc}
                                        </p>
                                        <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400 sm:text-xs">
                                            {feat.detail}
                                        </p>
                                    </div>
                                </div>
                            </motion.div>
                        ))}
                    </div>
                </motion.div>

                {/* Comparison Section */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, ease: 'easeOut' }}
                    className="mb-24"
                >
                    <div className="mb-12 text-center">
                        <h3 className="mb-4 text-3xl font-extrabold text-gray-900 dark:text-white lg:text-2xl">
                            Caramel vs Others
                        </h3>
                        <p className="mx-auto max-w-2xl text-gray-600 dark:text-gray-400">
                            See how we stack up against traditional coupon
                            extensions
                        </p>
                    </div>

                    <div className="mx-auto max-w-4xl space-y-4">
                        {comparisonItems.map((item, index) => (
                            <motion.div
                                key={item.title}
                                initial={{ opacity: 0, y: 10 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                viewport={{ once: true }}
                                transition={{
                                    duration: 0.4,
                                    delay: index * 0.1,
                                    ease: 'easeOut',
                                }}
                                className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm dark:border-caramel/30 dark:bg-darkerBg"
                            >
                                <div className="grid grid-cols-2 lg:grid-cols-2 sm:grid-cols-1">
                                    {/* Others */}
                                    <div className="flex items-center space-x-4 p-6">
                                        <div className="flex-shrink-0">
                                            <HiXCircle className="h-8 w-8 text-red-500" />
                                        </div>
                                        <div className="flex-1">
                                            <h4 className="mb-1 text-sm font-medium uppercase tracking-wide text-gray-600 dark:text-gray-400">
                                                Other Extensions
                                            </h4>
                                            <p className="font-medium text-gray-900 dark:text-white">
                                                {item.other}
                                            </p>
                                        </div>
                                    </div>

                                    {/* Caramel */}
                                    <div className="flex items-center space-x-4 border-l border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-6 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10 sm:border-l-0 sm:border-t">
                                        <div className="flex-shrink-0">
                                            <HiCheckCircle className="h-8 w-8 text-caramel" />
                                        </div>
                                        <div className="flex-1">
                                            <h4 className="mb-1 text-sm font-medium uppercase tracking-wide text-caramel">
                                                Caramel
                                            </h4>
                                            <p className="font-medium text-gray-900 dark:text-white">
                                                {item.caramel}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        ))}
                    </div>
                </motion.div>

                {/* Browser Support Section */}
                <motion.div
                    id="install-extension"
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.2, ease: 'easeOut' }}
                    className="rounded-3xl bg-gradient-to-r from-caramel to-orange-600 p-12 text-center text-black shadow-lg lg:p-8"
                >
                    <h3 className="mb-6 text-3xl font-extrabold tracking-tight lg:text-2xl">
                        Available on Your Favorite Browser!
                    </h3>
                    <p className="mx-auto mb-8 max-w-2xl text-lg leading-relaxed opacity-90">
                        Start saving with Caramel on any browser!
                    </p>
                    <div className="flex justify-center gap-6 lg:gap-4 sm:flex-col sm:items-center sm:gap-4">
                        {[
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
                        ].map((browser, index) => (
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
                                        className="inline-flex items-center rounded-full bg-white px-8 py-4 font-semibold text-caramel shadow-md transition-all duration-200 hover:bg-orange-50 hover:shadow-xl md:min-w-[200px]"
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
            </div>
        </section>
    )
}
