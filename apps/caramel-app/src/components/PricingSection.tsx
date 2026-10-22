'use client'

import { GITHUB_REPO_URL } from '@/lib/brandLinks'
import {
    PRICING_FEATURES as features,
    PRICING_COPY,
    PRICING_STATS,
} from '@/lib/marketing/pricingContent'
import { motion } from 'framer-motion'
import { FaDollarSign, FaGithub, FaHeart } from 'react-icons/fa'
import { HiCheckCircle } from 'react-icons/hi'

const statIcons = [
    <FaDollarSign key="price" />,
    <FaGithub key="source" />,
    <FaHeart key="stores" />,
]
const stats = PRICING_STATS.map((stat, index) => ({
    ...stat,
    icon: statIcons[index],
}))

export default function PricingSection() {
    return (
        <section className="relative overflow-hidden py-32">
            {/* Background Elements */}
            <div className="absolute inset-0">
                <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-caramel/20 to-transparent"></div>
                <div className="absolute inset-0 bg-caramel/5"></div>
                <motion.div
                    className="absolute left-1/4 top-1/4 h-64 w-64 rounded-full bg-caramel/10 blur-3xl"
                    animate={{
                        x: [0, 50, 0],
                        y: [0, -30, 0],
                    }}
                    transition={{
                        duration: 10,
                        repeat: Infinity,
                        ease: 'easeInOut',
                    }}
                />
            </div>

            <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
                {/* Header — enters via the CSS `hero-enter*` keyframes
                    (globals.css), not framer `initial`/`whileInView`: this
                    block is the page's LCP element on phones, and framer's
                    serialised `opacity:0` kept it invisible until hydration
                    (Lighthouse mobile: LCP render delay 5.3 s of a 5.4 s LCP).
                    It sits at the top of the viewport, so "on load" and
                    "when in view" are the same moment. */}
                <div className="hero-enter mb-20 mt-32 text-center">
                    {/* h1, not h2: this is /pricing's page title, and that route
                        had no h1 at all. Only PricingPageClient renders this
                        section, so `/` keeps its single hero h1. Tailwind's
                        preflight resets heading size/weight to inherit, so the
                        classes below render this byte-identically to the h2. */}
                    <h1
                        className="hero-enter-scale mb-6 text-5xl font-bold text-gray-900 dark:text-white lg:text-4xl"
                        style={{ animationDelay: '0.2s' }}
                    >
                        {PRICING_COPY.headingPrefix}{' '}
                        <span className="text-caramel">
                            {PRICING_COPY.headingEmphasis}
                        </span>
                    </h1>
                    <p
                        className="hero-enter mx-auto max-w-3xl text-xl text-gray-600 dark:text-gray-300 lg:text-lg"
                        style={{ animationDelay: '0.3s' }}
                    >
                        {PRICING_COPY.summary}
                    </p>
                </div>

                {/* Stats Grid */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.2 }}
                    className="mx-auto mb-20 grid max-w-4xl grid-cols-3 gap-6 lg:grid-cols-2 sm:grid-cols-1"
                >
                    {stats.map((stat, index) => (
                        <motion.div
                            key={stat.desc}
                            initial={{ opacity: 0, y: 20 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.5, delay: 0.1 * index }}
                            className="group relative overflow-hidden rounded-2xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-6 text-center shadow-md transition-shadow duration-300 hover:shadow-lg dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10 sm:p-5"
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

                            <div className="relative z-10">
                                <motion.div className="mb-3 flex justify-center text-4xl text-caramel">
                                    {stat.icon}
                                </motion.div>
                                <h3 className="mb-2 text-4xl font-bold text-gray-900 dark:text-white lg:text-3xl">
                                    {stat.title}
                                </h3>
                                <p className="text-gray-600 dark:text-gray-300">
                                    {stat.desc}
                                </p>
                            </div>
                        </motion.div>
                    ))}
                </motion.div>

                {/* Main Pricing Card */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.3 }}
                    className="mx-auto max-w-4xl"
                >
                    <motion.div className="relative overflow-hidden rounded-2xl border border-caramel/30 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-12 shadow-xl ring-1 ring-caramel/10 dark:border-caramel/40 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10 lg:p-8 sm:p-6">
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

                        <div className="relative z-10">
                            <div className="absolute right-0 top-0 rounded-full bg-gradient-to-br from-caramel to-orange-600 px-5 py-2 text-xs font-bold tracking-[0.15em] text-white shadow-lg sm:px-4 sm:py-1.5 sm:text-[0.65rem]">
                                {PRICING_COPY.badge}
                            </div>

                            <div className="pb-10">
                                <h3 className="mb-4 text-4xl font-bold text-gray-900 dark:text-white lg:text-3xl sm:text-2xl">
                                    {PRICING_COPY.planHeading}
                                </h3>
                                <p className="text-xl text-gray-600 dark:text-gray-300 lg:text-lg sm:text-base">
                                    {PRICING_COPY.planSummary}
                                </p>
                            </div>

                            {/* Coupon perforation: the tear line plus the two
                                side notches. Full-bleed via negative margins
                                (mirroring the card's own p-12/lg:p-8/sm:p-6) so
                                each circle straddles a card edge and the card's
                                overflow-hidden clips it into a bite. The notch
                                fill must equal what sits behind the card: the
                                page background (globals.css body = gray-50 /
                                darkBg) under this section's caramel/5 wash. */}
                            <div
                                aria-hidden="true"
                                className="relative -mx-12 lg:-mx-8 sm:-mx-6"
                            >
                                <div className="border-t-2 border-dashed border-caramel/30" />
                                <div className="absolute left-0 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gray-50 dark:bg-darkBg">
                                    <div className="h-full w-full rounded-full bg-caramel/5" />
                                </div>
                                <div className="absolute right-0 top-1/2 h-10 w-10 -translate-y-1/2 translate-x-1/2 rounded-full bg-gray-50 dark:bg-darkBg">
                                    <div className="h-full w-full rounded-full bg-caramel/5" />
                                </div>
                            </div>

                            <div className="mb-10 mt-10 grid grid-cols-2 gap-4 sm:grid-cols-1">
                                {features.map((feature, index) => (
                                    <motion.div
                                        key={feature}
                                        initial={{ opacity: 0, x: -20 }}
                                        whileInView={{ opacity: 1, x: 0 }}
                                        viewport={{ once: true }}
                                        transition={{
                                            duration: 0.4,
                                            delay: 0.05 * index,
                                        }}
                                        className="flex items-start gap-3"
                                    >
                                        <HiCheckCircle className="mt-1 shrink-0 text-xl text-caramel" />
                                        <span className="text-gray-700 dark:text-gray-200">
                                            {feature}
                                        </span>
                                    </motion.div>
                                ))}
                            </div>

                            <motion.a
                                href={GITHUB_REPO_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                className="mx-auto flex w-full max-w-md items-center justify-center gap-3 rounded-full bg-caramel px-10 py-5 text-lg font-bold text-white shadow-lg transition-shadow hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:focus-visible:ring-offset-darkBg lg:px-8 lg:py-4 lg:text-lg sm:px-6 sm:py-4 sm:text-base"
                            >
                                <FaGithub className="text-2xl" />
                                {PRICING_COPY.cta}
                            </motion.a>

                            {/* Serial strip: the printed barcode + coupon code
                                every real ticket carries. Decorative only. */}
                            <div
                                aria-hidden="true"
                                className="mt-10 flex flex-col items-center gap-3"
                            >
                                <div
                                    className="h-8 w-full max-w-xs opacity-20"
                                    style={{
                                        backgroundImage:
                                            'repeating-linear-gradient(90deg, #ea6925 0 2px, transparent 2px 5px, #ea6925 5px 6px, transparent 6px 11px)',
                                    }}
                                />
                                <p className="font-mono text-xs tracking-[0.35em] text-gray-500 dark:text-gray-400">
                                    {PRICING_COPY.serial}
                                </p>
                            </div>
                        </div>
                    </motion.div>
                </motion.div>

                {/* Why Free Section */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.4 }}
                    className="mt-20 text-center"
                >
                    <h3 className="mb-6 text-3xl font-bold text-gray-900 dark:text-white lg:text-2xl sm:text-xl">
                        {PRICING_COPY.whyHeading}
                    </h3>
                    <div className="mx-auto max-w-3xl space-y-4 text-left text-gray-600 dark:text-gray-300 lg:text-base sm:text-sm">
                        <motion.p
                            initial={{ opacity: 0 }}
                            whileInView={{ opacity: 1 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.5, delay: 0.5 }}
                        >
                            <strong className="text-caramel">
                                {PRICING_COPY.transparencyHeading}
                            </strong>{' '}
                            {PRICING_COPY.transparency}
                        </motion.p>
                        <motion.p
                            initial={{ opacity: 0 }}
                            whileInView={{ opacity: 1 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.5, delay: 0.6 }}
                        >
                            <strong className="text-caramel">
                                {PRICING_COPY.openSourceHeading}
                            </strong>{' '}
                            {PRICING_COPY.openSource}
                        </motion.p>
                        <motion.p
                            initial={{ opacity: 0 }}
                            whileInView={{ opacity: 1 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.5, delay: 0.7 }}
                        >
                            <strong className="text-caramel">
                                {PRICING_COPY.privacyHeading}
                            </strong>{' '}
                            {PRICING_COPY.privacy}
                        </motion.p>
                    </div>
                </motion.div>
            </div>
        </section>
    )
}
