import AppHeader from '@/components/AppHeader'
import BrowserSupport from '@/components/BrowserSupport'
import Doodles from '@/components/Doodles'
import { CheckIcon } from '@heroicons/react/24/outline'
import { motion } from 'framer-motion'

const Pricing = () => {
    const features = [
        'Automatic coupon discovery',
        'Real-time price comparison',
        'Best deals across supported sites',
        'Privacy-focused design',
        'No data collection',
        'No ads or tracking',
        'Open source transparency',
        'Community-driven development',
        'Regular updates and improvements',
        'Cross-platform compatibility',
    ]

    return (
        <>
            <AppHeader
                ogTitle="Caramel | Pricing - Free Forever"
                ogDescription="Caramel is completely free and open source. No subscriptions, no hidden fees, no premium tiers. Download now and start saving money!"
                ogUrl="https://grabcaramel.com/pricing"
            />
            <main className="dark:bg-darkBg relative -mt-[6.7rem] w-full overflow-x-clip">
                <Doodles />

                <div className="scroll-smooth">
                    {/* Hero Section */}
                    <section className="relative mt-[5rem] flex min-h-[70vh] flex-col justify-center overflow-hidden px-4 py-16 text-gray-800 md:px-6 md:py-20 dark:text-white">
                        {/* Floating decorative elements */}
                        <div className="absolute left-1/4 top-20 h-32 w-32 rounded-full bg-gradient-to-br from-orange-400/10 to-orange-600/20 blur-3xl"></div>
                        <div className="absolute right-1/4 top-40 h-24 w-24 rounded-full bg-gradient-to-br from-orange-500/15 to-orange-700/25 blur-2xl"></div>

                        <div className="mx-auto max-w-6xl text-center">
                            <motion.div
                                initial={{ opacity: 0, y: 40 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.8, ease: 'easeOut' }}
                                className="mb-12"
                            >
                                {/* Badge */}
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.8 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    transition={{ duration: 0.6, delay: 0.2 }}
                                    className="mx-auto mb-8 inline-flex items-center rounded-full bg-gradient-to-r from-orange-100 to-orange-50 px-6 py-2 text-sm font-semibold text-orange-800 shadow-lg dark:from-orange-900/30 dark:to-orange-800/20 dark:text-orange-200"
                                >
                                    <svg
                                        className="mr-2 h-4 w-4"
                                        fill="currentColor"
                                        viewBox="0 0 20 20"
                                    >
                                        <path
                                            fillRule="evenodd"
                                            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                                            clipRule="evenodd"
                                        />
                                    </svg>
                                    100% Free & Open Source
                                </motion.div>

                                <h1 className="from-caramel mb-6 bg-gradient-to-r to-orange-600 bg-clip-text text-3xl font-black leading-tight tracking-tight text-transparent md:text-5xl lg:text-6xl xl:text-7xl">
                                    Free To Use!
                                </h1>
                                <p className="mx-auto max-w-4xl text-base leading-relaxed text-gray-600 md:text-lg lg:text-xl xl:text-2xl dark:text-gray-300">
                                    Caramel is completely free and open source.
                                    No registration, no subscriptions, no hidden
                                    fees.
                                    <br />
                                    <span className="from-caramel bg-gradient-to-r to-orange-600 bg-clip-text font-semibold text-transparent">
                                        Just install and start saving money
                                        instantly.
                                    </span>
                                </p>
                            </motion.div>
                        </div>
                    </section>

                    <motion.div
                        className="relative h-px"
                        initial={{ scaleX: 0 }}
                        whileInView={{ scaleX: 1 }}
                        viewport={{ once: true }}
                        transition={{ duration: 2, delay: 0.4 }}
                    >
                        <div className="h-px bg-gradient-to-r from-transparent via-orange-500/40 to-transparent"></div>
                        <div className="absolute inset-0 h-px bg-gradient-to-r from-transparent via-orange-300/20 to-transparent blur-sm"></div>
                    </motion.div>

                    {/* Pricing Card Section */}
                    <section className="px-4 py-16 md:px-6 md:py-24">
                        <div className="mx-auto max-w-5xl">
                            <motion.div
                                initial={{ opacity: 0, y: 60 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                viewport={{ once: true }}
                                transition={{ duration: 0.8, ease: 'easeOut' }}
                                className="mx-auto max-w-3xl"
                            >
                                <div className="from-caramel/10 border-caramel/30 hover:shadow-3xl group relative overflow-hidden rounded-3xl border-2 bg-gradient-to-br to-orange-500/10 p-6 shadow-2xl backdrop-blur-sm transition-all duration-300 md:p-10 lg:p-12">
                                    {/* Enhanced Background decoration */}
                                    <div className="absolute -right-24 -top-24 h-48 w-48 rounded-full bg-gradient-to-br from-orange-400/20 to-orange-600/30 blur-3xl transition-all duration-700 group-hover:blur-2xl"></div>
                                    <div className="absolute -bottom-24 -left-24 h-48 w-48 rounded-full bg-gradient-to-br from-orange-400/20 to-orange-600/30 blur-3xl transition-all duration-700 group-hover:blur-2xl"></div>

                                    {/* Animated grid pattern */}
                                    <div className="absolute inset-0 opacity-5">
                                        <motion.div
                                            className="h-full w-full"
                                            style={{
                                                backgroundImage: `
                                                    linear-gradient(90deg, #ea6925 1px, transparent 1px),
                                                    linear-gradient(#ea6925 1px, transparent 1px)
                                                `,
                                                backgroundSize: '30px 30px',
                                            }}
                                            animate={{
                                                backgroundPosition: [
                                                    '0px 0px',
                                                    '30px 30px',
                                                    '0px 0px',
                                                ],
                                            }}
                                            transition={{
                                                duration: 10,
                                                repeat: Infinity,
                                                ease: 'linear',
                                            }}
                                        />
                                    </div>

                                    <div className="relative text-center">
                                        <motion.div
                                            initial={{ opacity: 0, scale: 0.8 }}
                                            animate={{
                                                opacity: 1,
                                                scale: 1,
                                            }}
                                            transition={{
                                                duration: 0.6,
                                                delay: 0.2,
                                            }}
                                        >
                                            <h2 className="from-caramel mb-6 bg-gradient-to-r to-orange-600 bg-clip-text text-3xl font-black text-transparent md:text-4xl lg:text-5xl">
                                                Everything Included
                                            </h2>
                                        </motion.div>

                                        <motion.div
                                            initial={{ opacity: 0, scale: 0.5 }}
                                            animate={{
                                                opacity: 1,
                                                scale: 1,
                                            }}
                                            transition={{
                                                duration: 0.8,
                                                delay: 0.4,
                                                type: 'spring',
                                                stiffness: 100,
                                            }}
                                            className="mb-8"
                                        >
                                            <div className="relative inline-block">
                                                <span className="text-5xl font-black text-gray-800 md:text-7xl lg:text-8xl dark:text-white">
                                                    $0
                                                </span>
                                                <motion.div
                                                    className="absolute -right-4 -top-2 rounded-full bg-gradient-to-r from-orange-500 to-orange-600 px-3 py-1 text-sm font-bold text-white shadow-lg"
                                                    animate={{
                                                        rotate: [0, 5, -5, 0],
                                                    }}
                                                    transition={{
                                                        duration: 2,
                                                        repeat: Infinity,
                                                        ease: 'easeInOut',
                                                    }}
                                                >
                                                    Free!
                                                </motion.div>
                                            </div>
                                            <div className="mt-2">
                                                <span className="text-lg font-semibold text-gray-600 md:text-xl lg:text-2xl dark:text-gray-400">
                                                    No subscriptions
                                                </span>
                                            </div>
                                        </motion.div>

                                        <motion.p
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            transition={{
                                                duration: 0.6,
                                                delay: 0.6,
                                            }}
                                            className="mb-10 text-base leading-relaxed text-gray-600 md:text-lg lg:text-xl dark:text-gray-300"
                                        >
                                            All features, no limitations, no
                                            strings attached
                                        </motion.p>

                                        {/* Enhanced Features List */}
                                        <div className="mb-10 grid gap-4 text-left lg:grid-cols-2">
                                            {features.map((feature, index) => (
                                                <motion.div
                                                    key={index}
                                                    initial={{
                                                        opacity: 0,
                                                        x: -30,
                                                    }}
                                                    animate={{
                                                        opacity: 1,
                                                        x: 0,
                                                    }}
                                                    transition={{
                                                        duration: 0.5,
                                                        delay:
                                                            0.8 + index * 0.1,
                                                        type: 'spring',
                                                        stiffness: 100,
                                                    }}
                                                    whileHover={{
                                                        scale: 1.02,
                                                        transition: {
                                                            duration: 0.2,
                                                        },
                                                    }}
                                                    className="flex items-center gap-4 rounded-xl bg-white/50 p-4 shadow-sm transition-all duration-200 hover:bg-white/70 hover:shadow-md dark:bg-gray-800/30 dark:hover:bg-gray-800/50"
                                                >
                                                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-orange-500 to-orange-600 shadow-lg">
                                                        <CheckIcon className="h-5 w-5 text-white" />
                                                    </div>
                                                    <span className="font-medium text-gray-800 dark:text-gray-200">
                                                        {feature}
                                                    </span>
                                                </motion.div>
                                            ))}
                                        </div>

                                        {/* Call to action */}
                                        <motion.div
                                            initial={{ opacity: 0, y: 20 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            transition={{
                                                duration: 0.6,
                                                delay: 1.2,
                                            }}
                                        >
                                            <button
                                                onClick={() => {
                                                    document
                                                        .getElementById(
                                                            'download-section',
                                                        )
                                                        ?.scrollIntoView({
                                                            behavior: 'smooth',
                                                            block: 'start',
                                                        })
                                                }}
                                                className="hover:bg-caramel hover:border-caramel group inline-flex items-center gap-2 rounded-2xl border-2 border-orange-500 bg-gradient-to-r from-orange-500 to-orange-600 px-6 py-3 text-base font-bold text-white shadow-xl transition-all duration-300 hover:scale-105 hover:shadow-2xl md:gap-3 md:px-8 md:py-4 md:text-lg"
                                            >
                                                <svg
                                                    className="h-6 w-6 transition-transform duration-300 group-hover:scale-110"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    viewBox="0 0 24 24"
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        strokeWidth={2}
                                                        d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                                    />
                                                </svg>
                                                Get Caramel Now
                                                <motion.div
                                                    className="ml-2"
                                                    animate={{ x: [0, 4, 0] }}
                                                    transition={{
                                                        duration: 1.5,
                                                        repeat: Infinity,
                                                        ease: 'easeInOut',
                                                    }}
                                                >
                                                    →
                                                </motion.div>
                                            </button>
                                        </motion.div>
                                    </div>
                                </div>
                            </motion.div>
                        </div>
                    </section>

                    {/* Download Section */}
                    <section className="px-4 py-16 md:px-6 md:py-20">
                        <div className="mx-auto max-w-6xl">
                            <motion.div
                                initial={{ opacity: 0, y: 30 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                viewport={{ once: true }}
                                transition={{ duration: 0.6 }}
                                className="mb-12 text-center"
                            >
                                <h2 className="mb-4 text-2xl font-bold text-gray-800 md:text-3xl lg:text-4xl dark:text-white">
                                    🚀 Ready to Start Saving?
                                </h2>
                                <p className="mx-auto max-w-3xl text-base text-gray-600 md:text-lg lg:text-xl dark:text-gray-300">
                                    Join thousands of smart shoppers who save
                                    money every day with Caramel
                                </p>
                            </motion.div>

                            <BrowserSupport
                                id="download-section"
                                title="Available on Your Favorite Browser!"
                                description="Choose your browser and install Caramel in seconds. Works seamlessly across all platforms."
                                className="shadow-2xl"
                            />
                        </div>
                    </section>

                    {/* Open Source Section */}
                    <section className="px-6 py-20">
                        <div className="mx-auto max-w-5xl">
                            <motion.div
                                initial={{ opacity: 0, y: 30 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                viewport={{ once: true }}
                                transition={{ duration: 0.6 }}
                                className="from-caramel/5 border-caramel/20 relative overflow-hidden rounded-3xl border-2 bg-gradient-to-br to-orange-500/5 p-10 shadow-xl backdrop-blur-sm md:p-12"
                            >
                                <div className="mb-8 text-center">
                                    <motion.div
                                        initial={{ scale: 0 }}
                                        whileInView={{ scale: 1 }}
                                        viewport={{ once: true }}
                                        transition={{
                                            duration: 0.5,
                                            delay: 0.2,
                                        }}
                                        className="from-caramel mb-6 inline-flex rounded-full bg-gradient-to-r to-orange-500 p-4 text-white shadow-xl"
                                    >
                                        <span className="text-3xl">🎁</span>
                                    </motion.div>
                                    <h3 className="from-caramel mb-4 bg-gradient-to-r to-orange-600 bg-clip-text text-2xl font-black text-transparent md:text-3xl lg:text-4xl">
                                        About Caramel
                                    </h3>
                                    <p className="mx-auto max-w-3xl text-center text-base leading-relaxed text-gray-600 md:text-lg lg:text-xl dark:text-gray-300">
                                        Caramel is a passion project created by{' '}
                                        <a
                                            href="https://devino.ca"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="font-bold text-white transition-colors duration-200 hover:text-orange-200"
                                        >
                                            Devino&nbsp;Solutions
                                        </a>
                                        , our parent SaaS consultancy dedicated
                                        to building high-impact web and mobile
                                        applications. We launched Caramel to
                                        solve a single problem: helping shoppers
                                        find valid coupons without
                                        short-changing merchants or affiliates
                                        who deserve their share of commission.
                                    </p>
                                </div>

                                <div className="mb-10 grid gap-6 md:grid-cols-2">
                                    <motion.div
                                        initial={{ opacity: 0, x: -30 }}
                                        whileInView={{ opacity: 1, x: 0 }}
                                        viewport={{ once: true }}
                                        transition={{
                                            duration: 0.6,
                                            delay: 0.3,
                                        }}
                                        className="rounded-2xl bg-white/60 p-6 shadow-lg backdrop-blur-sm dark:bg-gray-800/40"
                                    >
                                        <div className="mb-4 flex items-center gap-3">
                                            <span className="text-2xl">💡</span>
                                            <h4 className="text-xl font-bold text-gray-800 dark:text-white">
                                                Value First, Revenue Later
                                            </h4>
                                        </div>
                                        <p className="leading-relaxed text-gray-600 dark:text-gray-300">
                                            Our philosophy is simple: create
                                            real value first, and the money will
                                            follow naturally. Caramel is
                                            completely free today. We have no
                                            ads, no paywalls, and no hidden
                                            fees.
                                        </p>
                                    </motion.div>

                                    <motion.div
                                        initial={{ opacity: 0, x: 30 }}
                                        whileInView={{ opacity: 1, x: 0 }}
                                        viewport={{ once: true }}
                                        transition={{
                                            duration: 0.6,
                                            delay: 0.4,
                                        }}
                                        className="rounded-2xl bg-white/60 p-6 shadow-lg backdrop-blur-sm dark:bg-gray-800/40"
                                    >
                                        <div className="mb-4 flex items-center gap-3">
                                            <span className="text-2xl">�</span>
                                            <h4 className="text-xl font-bold text-gray-800 dark:text-white">
                                                Future Support
                                            </h4>
                                        </div>
                                        <p className="leading-relaxed text-gray-600 dark:text-gray-300">
                                            If our community wants to support
                                            Caramel, we may introduce voluntary
                                            donations or a small premium tier
                                            with non-instrusive perks. Any
                                            future offering will attempt to
                                            reduce the free version&apos;s core
                                            value.
                                        </p>
                                    </motion.div>

                                    <motion.div
                                        initial={{ opacity: 0, x: -30 }}
                                        whileInView={{ opacity: 1, x: 0 }}
                                        viewport={{ once: true }}
                                        transition={{
                                            duration: 0.6,
                                            delay: 0.5,
                                        }}
                                        className="rounded-2xl bg-white/60 p-6 shadow-lg backdrop-blur-sm dark:bg-gray-800/40"
                                    >
                                        <div className="mb-4 flex items-center gap-3">
                                            <span className="text-2xl">🔓</span>
                                            <h4 className="text-xl font-bold text-gray-800 dark:text-white">
                                                Open-Source Commitment
                                            </h4>
                                        </div>
                                        <p className="leading-relaxed text-gray-600 dark:text-gray-300">
                                            Transparency matters. Caramel&apos;s
                                            codebase is fully open source, so
                                            anyone can inspect, contribute, or
                                            improve the project. By opening our
                                            work to the public, we ensure
                                            everyone has access to a trustworthy
                                            money-saving tool.
                                        </p>
                                    </motion.div>

                                    <motion.div
                                        initial={{ opacity: 0, x: 30 }}
                                        whileInView={{ opacity: 1, x: 0 }}
                                        viewport={{ once: true }}
                                        transition={{
                                            duration: 0.6,
                                            delay: 0.6,
                                        }}
                                        className="rounded-2xl bg-white/60 p-6 shadow-lg backdrop-blur-sm dark:bg-gray-800/40"
                                    >
                                        <div className="mb-4 flex items-center gap-3">
                                            <span className="text-2xl">🤝</span>
                                            <h4 className="text-xl font-bold text-gray-800 dark:text-white">
                                                Our Promise
                                            </h4>
                                        </div>
                                        <p className="leading-relaxed text-gray-600 dark:text-gray-300">
                                            We will keep focusing on building
                                            features that help users save money
                                            while respecting merchants.
                                            Monetization can wait, delivering
                                            value cannot.
                                        </p>
                                    </motion.div>
                                </div>
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    whileInView={{ opacity: 1, y: 0 }}
                                    viewport={{ once: true }}
                                    transition={{ duration: 0.6, delay: 0.7 }}
                                    className="text-center"
                                >
                                    <motion.button
                                        onClick={() => {
                                            document
                                                .getElementById(
                                                    'download-section',
                                                )
                                                ?.scrollIntoView({
                                                    behavior: 'smooth',
                                                    block: 'start',
                                                })
                                        }}
                                        className="group inline-flex items-center gap-3 rounded-2xl border-2 border-gray-300 bg-white/80 px-8 py-4 font-bold text-gray-700 shadow-xl transition-all duration-300 hover:scale-105 hover:border-orange-500 hover:bg-gradient-to-r hover:from-orange-500 hover:to-orange-600 hover:text-white hover:shadow-2xl dark:border-gray-600 dark:bg-gray-800/60 dark:text-gray-300 dark:hover:text-white"
                                        whileHover={{ scale: 1.05 }}
                                        whileTap={{ scale: 0.95 }}
                                    >
                                        <svg
                                            className="h-6 w-6 transition-transform duration-300 group-hover:scale-110"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24"
                                        >
                                            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                                        </svg>
                                        Get Caramel Now
                                        <motion.div
                                            className="ml-2"
                                            animate={{ x: [0, 4, 0] }}
                                            transition={{
                                                duration: 1.5,
                                                repeat: Infinity,
                                                ease: 'easeInOut',
                                            }}
                                        >
                                            →
                                        </motion.div>
                                    </motion.button>
                                </motion.div>
                            </motion.div>
                        </div>
                    </section>
                </div>
            </main>
        </>
    )
}

export default Pricing
