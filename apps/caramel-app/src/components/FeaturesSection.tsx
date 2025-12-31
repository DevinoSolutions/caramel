'use client'

import BrowserSupport from '@/components/BrowserSupport'
import { motion } from 'framer-motion'
import {
    FaBolt,
    FaDollarSign,
    FaGlobe,
    FaHeart,
    FaLock,
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
                <div className="via-caramel/20 absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent to-transparent"></div>
                <div className="via-caramel/20 absolute bottom-0 left-0 h-px w-full bg-gradient-to-r from-transparent to-transparent"></div>
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
                    <h2 className="text-caramel mb-8 text-5xl font-extrabold lg:text-4xl">
                        Why Choose Caramel?
                    </h2>
                    <p className="mx-auto max-w-3xl text-xl leading-relaxed text-gray-600 lg:text-lg dark:text-gray-300">
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
                    <div className="grid grid-cols-3 gap-8 sm:grid-cols-1 lg:grid-cols-2">
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
                                className="from-caramel/5 to-caramel/5 dark:from-caramel/10 dark:to-caramel/10 border-caramel/20 dark:border-caramel/30 group relative overflow-hidden rounded-2xl border bg-gradient-to-br via-orange-50/30 p-8 shadow-md sm:p-6 dark:via-orange-900/20"
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
                                        className="text-caramel mx-auto mb-6 text-6xl transition-transform duration-300 lg:hidden xl:block"
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
                                            <span className="text-caramel mr-3 flex-shrink-0 text-2xl">
                                                {feat.icon}
                                            </span>
                                            <h3 className="text-2xl font-bold tracking-tight text-gray-800 sm:text-xl dark:text-white">
                                                {feat.title}
                                            </h3>
                                        </div>
                                        <p className="ml-11 text-base leading-relaxed text-gray-600 sm:text-sm dark:text-gray-400">
                                            {feat.desc}
                                        </p>
                                    </div>

                                    {/* Desktop layout - original centered layout */}
                                    <div className="lg:hidden xl:block">
                                        <h3 className="mb-4 text-3xl font-bold tracking-tight text-gray-800 sm:text-2xl dark:text-white">
                                            {feat.title}
                                        </h3>
                                        <p className="mb-4 text-lg leading-relaxed text-gray-600 sm:text-base dark:text-gray-400">
                                            {feat.desc}
                                        </p>
                                        <p className="text-sm leading-relaxed text-gray-500 sm:text-xs dark:text-gray-400">
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
                        <h3 className="mb-4 text-3xl font-extrabold text-gray-900 lg:text-2xl dark:text-white">
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
                                className="dark:bg-darkerBg dark:border-caramel/30 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm"
                            >
                                <div className="grid grid-cols-2 sm:grid-cols-1 lg:grid-cols-2">
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
                                    <div className="from-caramel/5 to-caramel/5 dark:from-caramel/10 dark:to-caramel/10 border-caramel/20 flex items-center space-x-4 border-l bg-gradient-to-br via-orange-50/30 p-6 sm:border-l-0 sm:border-t dark:via-orange-900/20">
                                        <div className="flex-shrink-0">
                                            <HiCheckCircle className="text-caramel h-8 w-8" />
                                        </div>
                                        <div className="flex-1">
                                            <h4 className="text-caramel mb-1 text-sm font-medium uppercase tracking-wide">
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
                <BrowserSupport />
            </div>
        </section>
    )
}
