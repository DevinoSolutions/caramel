'use client'

import { motion } from 'framer-motion'
import { FaDollarSign, FaGithub, FaHeart } from 'react-icons/fa'
import { HiCheckCircle } from 'react-icons/hi'

const features = [
    'Automated coupon application at checkout',
    'Works on 5,000+ supported stores',
    'Zero tracking or data collection',
    'Open source & community-driven',
    'Never hijacks affiliate commissions',
    'Lightning fast performance',
    'Cross-browser support (Chrome, Firefox, Edge, Safari)',
    'Regular updates & new features',
    'No credit card required',
    'No hidden fees ever',
]

const stats = [
    {
        title: '$0',
        desc: 'Forever',
        icon: <FaDollarSign />,
    },
    {
        title: '100%',
        desc: 'Open Source',
        icon: <FaGithub />,
    },
    {
        title: '∞',
        desc: 'Stores Supported',
        icon: <FaHeart />,
    },
]

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
                {/* Header */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6 }}
                    className="mb-20 mt-32 text-center"
                >
                    <motion.h2
                        className="mb-6 text-5xl font-bold text-gray-900 dark:text-white lg:text-4xl"
                        initial={{ opacity: 0, scale: 0.95 }}
                        whileInView={{ opacity: 1, scale: 1 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.5, delay: 0.2 }}
                    >
                        Simple, Transparent{' '}
                        <span className="text-caramel">Pricing</span>
                    </motion.h2>
                    <motion.p
                        className="mx-auto max-w-3xl text-xl text-gray-600 dark:text-gray-300 lg:text-lg"
                        initial={{ opacity: 0 }}
                        whileInView={{ opacity: 1 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.5, delay: 0.3 }}
                    >
                        No tricks, no hidden fees. Caramel is completely free
                        and always will be.
                    </motion.p>
                </motion.div>

                {/* Stats Grid */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.2 }}
                    className="mb-20 grid grid-cols-3 gap-8 lg:grid-cols-2 sm:grid-cols-1"
                >
                    {stats.map((stat, index) => (
                        <motion.div
                            key={stat.desc}
                            initial={{ opacity: 0, y: 20 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.5, delay: 0.1 * index }}
                            className="group relative overflow-hidden rounded-2xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-8 text-center shadow-md dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10 sm:p-6"
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
                                <motion.div className="mb-4 flex justify-center text-5xl text-caramel">
                                    {stat.icon}
                                </motion.div>
                                <h3 className="mb-2 text-5xl font-bold text-gray-900 dark:text-white lg:text-4xl">
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
                    <motion.div className="relative overflow-hidden rounded-2xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-12 shadow-md dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10 lg:p-8 sm:p-6">
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
                            <div className="absolute right-0 top-0 rounded-bl-3xl bg-gradient-to-br from-caramel to-orange-600 px-8 py-3 text-sm font-bold text-white shadow-lg lg:px-6 lg:py-2.5 lg:text-sm sm:px-4 sm:py-2 sm:text-xs">
                                ALWAYS FREE
                            </div>

                            <div className="mb-10 border-b border-caramel/20 pb-10">
                                <h3 className="mb-4 text-4xl font-bold text-gray-900 dark:text-white lg:text-3xl sm:text-2xl">
                                    Free Forever Plan
                                </h3>
                                <p className="text-xl text-gray-600 dark:text-gray-300 lg:text-lg sm:text-base">
                                    Everything you need to save money while
                                    shopping online. No payment required, ever.
                                </p>
                            </div>

                            <div className="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-1">
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
                                href="https://github.com/DevinoSolutions/caramel"
                                target="_blank"
                                rel="noopener noreferrer"
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                className="mx-auto flex w-full max-w-md items-center justify-center gap-3 rounded-full bg-caramel px-10 py-5 text-lg font-bold text-white shadow-lg transition-shadow hover:shadow-xl lg:px-8 lg:py-4 lg:text-lg sm:px-6 sm:py-4 sm:text-base"
                            >
                                <FaGithub className="text-2xl" />
                                Get Started - It's Free
                            </motion.a>
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
                        Why Is Caramel Free?
                    </h3>
                    <div className="mx-auto max-w-3xl space-y-4 text-left text-gray-600 dark:text-gray-300 lg:text-base sm:text-sm">
                        <motion.p
                            initial={{ opacity: 0 }}
                            whileInView={{ opacity: 1 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.5, delay: 0.5 }}
                        >
                            <strong className="text-caramel">
                                We believe in transparency.
                            </strong>{' '}
                            Unlike other extensions that monetize your data or
                            hijack affiliate commissions, Caramel is built by
                            the community, for the community.
                        </motion.p>
                        <motion.p
                            initial={{ opacity: 0 }}
                            whileInView={{ opacity: 1 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.5, delay: 0.6 }}
                        >
                            <strong className="text-caramel">
                                100% Open Source.
                            </strong>{' '}
                            Our entire codebase is public on GitHub. Anyone can
                            audit, contribute, or fork the project. This
                            transparency ensures we stay true to our mission.
                        </motion.p>
                        <motion.p
                            initial={{ opacity: 0 }}
                            whileInView={{ opacity: 1 }}
                            viewport={{ once: true }}
                            transition={{ duration: 0.5, delay: 0.7 }}
                        >
                            <strong className="text-caramel">
                                Your privacy matters.
                            </strong>{' '}
                            We don't track your browsing, sell your data, or
                            serve ads. Caramel exists to save you money, not to
                            profit from your information.
                        </motion.p>
                    </div>
                </motion.div>
            </div>
        </section>
    )
}
