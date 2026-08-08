'use client'

import { useReducedMotion } from '@/lib/reducedMotion'
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
        detail: 'We monitor thousands of coupon codes across 3,000+ stores, ensuring you always get the best deal without lifting a finger.',
        icon: <FaDollarSign />,
    },
    {
        title: 'Privacy-First & Transparent',
        desc: 'Your data stays yours. We never sell or monetize your personal information.',
        detail: 'Unlike other extensions, we never sell your data, build ad profiles, or hijack affiliate commissions from content creators.',
        icon: <FaLock />,
    },
    {
        title: '100% Open Source',
        desc: 'Our extension and web app are fully public and community-driven.',
        detail: 'Join our GitHub to contribute features, report issues, or request enhancements. Reviewed in the open by contributors and the community.',
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
        other: 'Opaque data practices',
        caramel: '100% privacy-first approach',
    },
    {
        title: 'Data Collection',
        other: 'Tracks your browsing habits',
        caramel: 'No ad tracking or data selling',
    },
    {
        title: 'Creator Support',
        other: 'Hijacks affiliate commissions',
        caramel: 'Protects creator earnings',
    },
    {
        title: 'Code Transparency',
        other: 'Closed source & hidden',
        caramel: 'Fully open source & peer-reviewed',
    },
    {
        title: 'Performance',
        other: 'Slow and resource-heavy',
        caramel: 'Lightning fast & lightweight',
    },
]

export default function FeaturesSection() {
    const reduceMotion = useReducedMotion()

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
                    <h2 className="mb-8 text-5xl font-extrabold leading-tight tracking-tight text-caramel lg:text-4xl">
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
                                initial={
                                    reduceMotion
                                        ? { opacity: 0 }
                                        : {
                                              opacity: 0,
                                              x: index % 2 === 0 ? -32 : 32,
                                          }
                                }
                                whileInView={{ opacity: 1, x: 0 }}
                                viewport={{
                                    once: true,
                                    margin: '0px 0px -60px 0px',
                                }}
                                transition={{
                                    duration: 0.6,
                                    delay: index * 0.08,
                                    type: 'spring',
                                    stiffness: 100,
                                    damping: 15,
                                }}
                            >
                                {/* The entrance animation and the card chrome
                                    are deliberately on separate elements:
                                    framer leaves an inline `transform: none` on
                                    anything it animates, which would outrank
                                    the hover-lift class. */}
                                <div className="group relative h-full overflow-hidden rounded-2xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-8 shadow-md transition-all duration-300 hover:-translate-y-1 hover:border-caramel/60 hover:shadow-[0_12px_32px_-8px_rgba(234,105,37,0.35)] dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10 sm:p-6">
                                    {/* Animated Background Pattern */}
                                    <div
                                        aria-hidden="true"
                                        className="absolute inset-0 opacity-5"
                                    >
                                        <motion.div
                                            className="h-full w-full"
                                            style={{
                                                backgroundImage: `
                                                linear-gradient(90deg, #ea6925 1px, transparent 1px),
                                                linear-gradient(#ea6925 1px, transparent 1px)
                                            `,
                                                backgroundSize: '20px 20px',
                                            }}
                                            animate={
                                                reduceMotion
                                                    ? undefined
                                                    : {
                                                          backgroundPosition: [
                                                              '0px 0px',
                                                              '20px 20px',
                                                              '0px 0px',
                                                          ],
                                                      }
                                            }
                                            transition={{
                                                duration: 8,
                                                repeat: Infinity,
                                                ease: 'linear',
                                                repeatType: 'loop',
                                            }}
                                        />
                                    </div>

                                    <div className="relative z-10 text-center">
                                        {/* Large icon - hidden on lg and down. The
                                        card-hover scale lives on this wrapper
                                        because the inner element's ambient
                                        framer animation owns its inline
                                        transform; nesting lets both compose. */}
                                        <div
                                            aria-hidden="true"
                                            className="mx-auto mb-6 text-6xl text-caramel transition-transform duration-300 group-hover:scale-110 xl:block lg:hidden"
                                        >
                                            <motion.div
                                                animate={
                                                    reduceMotion
                                                        ? undefined
                                                        : {
                                                              rotate: [
                                                                  0, 2, -2, 0,
                                                              ],
                                                              scale: [
                                                                  1, 1.02, 1,
                                                              ],
                                                          }
                                                }
                                                transition={{
                                                    duration: 4,
                                                    repeat: Infinity,
                                                    ease: 'easeInOut',
                                                    repeatType: 'loop',
                                                }}
                                            >
                                                {feat.icon}
                                            </motion.div>
                                        </div>

                                        {/* Mobile layout - icon + title in one row */}
                                        <div className="hidden text-left lg:block">
                                            <div className="mb-3 flex items-center">
                                                <span
                                                    aria-hidden="true"
                                                    className="mr-3 flex-shrink-0 text-2xl text-caramel transition-transform duration-300 group-hover:scale-110"
                                                >
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
                        <h3 className="mb-4 text-3xl font-extrabold tracking-tight text-gray-900 dark:text-white lg:text-2xl">
                            Caramel vs Others
                        </h3>
                        <p className="mx-auto max-w-2xl text-gray-600 dark:text-gray-400">
                            See how we stack up against traditional coupon
                            extensions
                        </p>
                    </div>

                    <div className="mx-auto max-w-4xl">
                        {/* ONE column header for the whole table. The per-row
                            "Other Extensions" / "Caramel" labels are gone — the
                            columns are labelled once and the rows just compare.
                            Padding here mirrors the row cells' so the two
                            column edges line up. */}
                        <div className="mb-4 grid grid-cols-2">
                            <div className="px-6 text-sm font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 sm:px-4">
                                Other Extensions
                            </div>
                            <div className="px-6 text-sm font-semibold uppercase tracking-wide text-caramel sm:px-4">
                                Caramel
                            </div>
                        </div>

                        <div className="space-y-4">
                            {comparisonItems.map((item, index) => (
                                <motion.div
                                    key={item.title}
                                    initial={
                                        reduceMotion
                                            ? { opacity: 0 }
                                            : { opacity: 0, y: 10 }
                                    }
                                    whileInView={{ opacity: 1, y: 0 }}
                                    viewport={{
                                        once: true,
                                        margin: '0px 0px -60px 0px',
                                    }}
                                    transition={{
                                        duration: 0.4,
                                        delay: index * 0.08,
                                        ease: 'easeOut',
                                    }}
                                >
                                    {/* Card chrome sits inside the motion
                                        element for the same reason as the
                                        feature cards: framer's inline
                                        transform would beat the hover lift.
                                        Stays two columns at every width — the
                                        comparison only reads as a comparison
                                        side by side, and the labels that used
                                        to carry a stacked layout are gone. */}
                                    <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm transition-all duration-300 ease-caramel hover:-translate-y-1 hover:border-caramel/60 hover:shadow-[0_12px_32px_-8px_rgba(234,105,37,0.35)] dark:border-caramel/30 dark:bg-darkSurface">
                                        {/* Losing column — neutral card surface
                                            (never darker than the page) and
                                            muted so the eye lands on Caramel. */}
                                        <div className="flex items-center space-x-4 p-6 opacity-50 sm:space-x-3 sm:p-4">
                                            <div className="flex-shrink-0">
                                                <HiXCircle
                                                    aria-hidden="true"
                                                    className="h-8 w-8 rounded-full bg-gray-400/20 text-gray-500 dark:bg-white/10 dark:text-gray-400"
                                                />
                                            </div>
                                            <p className="flex-1 font-medium text-gray-900 dark:text-white">
                                                {item.other}
                                            </p>
                                        </div>

                                        {/* Winning column — tinted and ringed
                                            at full strength. The ring is inset
                                            so the card's overflow-hidden can't
                                            clip it. */}
                                        <div className="flex items-center space-x-4 bg-caramel/[0.08] p-6 ring-1 ring-inset ring-caramel/40 sm:space-x-3 sm:p-4">
                                            <div className="flex-shrink-0">
                                                <HiCheckCircle
                                                    aria-hidden="true"
                                                    className="h-8 w-8 text-caramel"
                                                />
                                            </div>
                                            <p className="flex-1 font-medium text-gray-900 dark:text-white">
                                                {item.caramel}
                                            </p>
                                        </div>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </div>
                </motion.div>

                {/* Browser Support Section. The transparent border is always
                    present so the dark theme's caramel border doesn't change
                    the slab's size. */}
                <motion.div
                    id="install-extension"
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.2, ease: 'easeOut' }}
                    className="rounded-3xl border border-transparent bg-gradient-to-br from-caramel to-[#c9531a] p-12 text-center text-white shadow-lg ring-1 ring-inset ring-white/20 dark:border-caramel/30 dark:bg-caramel/[0.12] dark:bg-none dark:ring-0 lg:p-8"
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
                                href: 'https://chromewebstore.google.com/detail/caramel-trusted-honey-alt/gaimofgglbackoimfjopicmbmnlccfoe',
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
                                        className="inline-flex items-center rounded-full bg-white px-8 py-4 font-semibold text-caramel shadow-md transition-all duration-200 ease-caramel hover:bg-orange-50 hover:shadow-xl md:min-w-[200px]"
                                    >
                                        <span
                                            aria-hidden="true"
                                            className="mr-3 text-2xl"
                                        >
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
