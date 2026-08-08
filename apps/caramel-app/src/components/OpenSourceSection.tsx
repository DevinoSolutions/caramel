'use client'

import { useReducedMotion } from '@/lib/reducedMotion'
import { motion } from 'framer-motion'
import {
    FaArrowRight,
    FaBan,
    FaBug,
    FaCode,
    FaDiscord,
    FaEye,
    FaGithub,
    FaLightbulb,
    FaLock,
    FaStore,
    FaUsers,
} from 'react-icons/fa'
import { RiInstagramFill } from 'react-icons/ri'

const platforms = [
    {
        name: 'GitHub',
        href: 'https://github.com/DevinoSolutions/caramel',
        desc: 'Explore our open-source code & contribute',
        icon: <FaGithub />,
        color: 'from-gray-600 to-gray-800',
    },
    {
        name: 'Discord',
        href: 'https://discord.com/invite/2vVVrQ5CEB',
        desc: 'Join our developer community',
        icon: <FaDiscord />,
        color: 'from-indigo-500 to-purple-600',
    },
    {
        name: 'Instagram',
        href: 'https://www.instagram.com/grab.caramel/',
        desc: 'Follow us for updates & tips',
        icon: <RiInstagramFill />,
        color: 'from-pink-500 to-rose-500',
    },
]

const contributions = [
    {
        title: 'Code Contributions',
        desc: 'Help improve our algorithms, add new features, or fix bugs',
        icon: <FaCode />,
        action: 'Start Contributing',
        href: 'https://github.com/DevinoSolutions/caramel/issues/new?assignees=&labels=enhancement&projects=&template=feature-request.md&title=%5BFeature%5D+',
    },
    {
        title: 'Store Requests',
        desc: 'Request support for new e-commerce platforms and stores',
        icon: <FaStore />,
        action: 'Request Store',
        href: 'https://github.com/DevinoSolutions/caramel/issues/new?assignees=&labels=store-request&projects=&template=store-request.md&title=%5BStore+Request%5D+Add+support+for+',
    },
    {
        title: 'Bug Reports',
        desc: 'Help us identify and fix issues to improve user experience',
        icon: <FaBug />,
        action: 'Report Bug',
        href: 'https://github.com/DevinoSolutions/caramel/issues/new?assignees=&labels=bug&projects=&template=bug-report.md&title=%5BBug%5D+',
    },
    {
        title: 'Feature Ideas',
        desc: 'Suggest new features that would benefit the community',
        icon: <FaLightbulb />,
        action: 'Suggest Feature',
        href: 'https://github.com/DevinoSolutions/caramel/issues/new?assignees=&labels=enhancement&projects=&template=feature-request.md&title=%5BFeature%5D+',
    },
]

const securityFeatures = [
    {
        title: 'Open Security Reviews',
        desc: 'Every change is peer-reviewed in public',
        icon: <FaLock />,
    },
    {
        title: 'Transparent Operations',
        desc: 'All code changes are public and reviewable',
        icon: <FaEye />,
    },
    {
        title: 'No Ad Tracking',
        desc: 'We never sell or share your personal information',
        icon: <FaBan />,
    },
    {
        title: 'Community Oversight',
        desc: 'Anyone in the world can audit our code',
        icon: <FaUsers />,
    },
]

export default function OpenSourceSection() {
    const reduceMotion = useReducedMotion()

    return (
        <section id="opensource" className="relative overflow-hidden py-32">
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
                    <h2 className="mb-8 bg-gradient-to-r from-caramel to-orange-600 bg-clip-text pb-1 text-5xl font-extrabold leading-tight tracking-tight text-transparent lg:text-4xl">
                        Open Source & Community Driven
                    </h2>
                    <p className="mx-auto max-w-3xl text-xl leading-relaxed text-gray-600 dark:text-gray-300 lg:text-lg">
                        Transparency is our core. Every line of code is open,
                        auditable, and community-driven. Join the developers
                        building a better alternative to proprietary extensions.
                    </p>
                </motion.div>

                {/* Security First */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.2, ease: 'easeOut' }}
                    className="mb-16"
                >
                    <h3 className="mb-8 text-center text-3xl font-extrabold tracking-tight text-gray-900 dark:text-white lg:text-2xl">
                        Security Through Transparency
                    </h3>
                    {/* Deliberately COMPACT: this row supports the two richer
                        groups below (Community, Contribution Pathways), so its
                        cards are quiet — small inline icon, tight padding, no
                        ambient icon/grid animation. Visual hierarchy, not a
                        third row of hero cards. */}
                    <div className="grid grid-cols-4 gap-6 lg:grid-cols-2 sm:grid-cols-1">
                        {securityFeatures.map((feature, index) => (
                            <motion.div
                                key={feature.title}
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
                                {/* A framer motion element writes its
                                    transform inline — including `none` at rest
                                    — so a Tailwind hover:-translate-y-1 placed
                                    on it never applies. Every card here splits
                                    the two: the motion element owns only the
                                    entrance, a plain child owns the chrome and
                                    the hover. Same reason the icon scale below
                                    rides on its own inner span. */}
                                <div className="group relative h-full overflow-hidden rounded-2xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-5 transition-all duration-300 hover:-translate-y-1 hover:border-caramel/60 hover:shadow-[0_12px_32px_-8px_rgba(234,105,37,0.35)] dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10">
                                    <div className="flex items-start gap-3">
                                        <span
                                            aria-hidden="true"
                                            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-caramel/10 text-lg text-caramel transition-transform duration-300 group-hover:scale-110 dark:bg-caramel/20"
                                        >
                                            {feature.icon}
                                        </span>
                                        <div>
                                            <h4 className="mb-1 text-lg font-bold text-gray-800 dark:text-white">
                                                {feature.title}
                                            </h4>
                                            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                                                {feature.desc}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        ))}
                    </div>
                </motion.div>

                {/* Community Platforms */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.15, ease: 'easeOut' }}
                    className="mb-24"
                >
                    <h3 className="mb-12 text-center text-3xl font-extrabold tracking-tight text-gray-900 dark:text-white lg:text-2xl">
                        Connect With Our Community
                    </h3>
                    <div className="grid grid-cols-3 gap-8 lg:grid-cols-2 sm:grid-cols-1">
                        {platforms.map((platform, index) => (
                            <motion.a
                                key={platform.name}
                                href={platform.href}
                                target="_blank"
                                rel="noopener noreferrer"
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
                                <div className="group relative h-full overflow-hidden rounded-3xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-8 transition-all duration-300 hover:-translate-y-1 hover:border-caramel/60 hover:shadow-[0_12px_32px_-8px_rgba(234,105,37,0.35)] dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10 sm:p-6">
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
                                    <div className="relative z-10 flex items-start gap-6 sm:flex-col sm:items-center sm:gap-4">
                                        <motion.div
                                            className="flex h-16 w-16 items-center justify-center rounded-2xl bg-caramel/10 text-2xl text-caramel dark:bg-caramel/20"
                                            animate={
                                                reduceMotion
                                                    ? undefined
                                                    : {
                                                          rotate: [0, 2, -2, 0],
                                                          scale: [1, 1.02, 1],
                                                      }
                                            }
                                            transition={{
                                                duration: 4,
                                                repeat: Infinity,
                                                ease: 'easeInOut',
                                                repeatType: 'loop',
                                            }}
                                        >
                                            <span className="block transition-transform duration-300 group-hover:scale-110">
                                                {platform.icon}
                                            </span>
                                        </motion.div>
                                        <div className="flex-1 sm:text-center">
                                            <h3 className="mb-3 text-2xl font-bold text-gray-800 dark:text-white sm:text-xl">
                                                {platform.name}
                                            </h3>
                                            <p className="text-base leading-relaxed text-gray-600 dark:text-gray-400 sm:text-sm">
                                                {platform.desc}
                                            </p>
                                            <span className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-caramel underline-offset-4 group-hover:underline">
                                                Open {platform.name}
                                                <FaArrowRight
                                                    aria-hidden="true"
                                                    className="transition-transform duration-300 group-hover:translate-x-1"
                                                />
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </motion.a>
                        ))}
                    </div>
                </motion.div>

                {/* Contribution Pathways */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.15, ease: 'easeOut' }}
                    className="mb-24"
                >
                    <h3 className="mb-12 text-center text-3xl font-extrabold tracking-tight text-gray-900 dark:text-white lg:text-2xl">
                        Contribution Pathways
                    </h3>
                    <div className="grid grid-cols-2 gap-8 sm:grid-cols-1 sm:gap-6">
                        {contributions.map((contribution, index) => (
                            <motion.div
                                key={contribution.title}
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
                                <div className="group relative h-full overflow-hidden rounded-3xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-8 transition-all duration-300 hover:-translate-y-1 hover:border-caramel/60 hover:shadow-[0_12px_32px_-8px_rgba(234,105,37,0.35)] dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10 sm:p-6">
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
                                    <div className="relative z-10 flex items-start gap-6 sm:flex-col sm:items-center sm:gap-4">
                                        <motion.div
                                            className="text-4xl text-caramel sm:text-3xl"
                                            animate={
                                                reduceMotion
                                                    ? undefined
                                                    : {
                                                          rotate: [0, 2, -2, 0],
                                                          scale: [1, 1.02, 1],
                                                      }
                                            }
                                            transition={{
                                                duration: 4,
                                                repeat: Infinity,
                                                ease: 'easeInOut',
                                                repeatType: 'loop',
                                            }}
                                        >
                                            <span className="block transition-transform duration-300 group-hover:scale-110">
                                                {contribution.icon}
                                            </span>
                                        </motion.div>
                                        <div className="flex-1 sm:text-center">
                                            <h4 className="mb-3 text-2xl font-bold text-gray-800 dark:text-white sm:text-xl">
                                                {contribution.title}
                                            </h4>
                                            <p className="mb-6 text-base leading-relaxed text-gray-600 dark:text-gray-400 sm:text-sm">
                                                {contribution.desc}
                                            </p>
                                            <motion.a
                                                href={contribution.href}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center rounded-full bg-gradient-to-r from-caramel to-orange-600 px-6 py-3 text-sm font-semibold text-white shadow-md transition-all duration-200 hover:shadow-xl"
                                                whileHover={{
                                                    scale: 1.05,
                                                    transition: {
                                                        duration: 0.2,
                                                    },
                                                }}
                                                whileTap={{ scale: 0.95 }}
                                            >
                                                {contribution.action}
                                            </motion.a>
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        ))}
                    </div>
                </motion.div>

                {/* Call to Action */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.15, ease: 'easeOut' }}
                    className="rounded-3xl bg-gradient-to-br from-caramel to-[#c9531a] p-12 text-center text-white shadow-2xl ring-1 ring-inset ring-white/20 dark:border dark:border-caramel/30 dark:bg-caramel/[0.12] dark:bg-none dark:ring-0 lg:p-8 sm:p-6"
                >
                    <h3 className="mb-6 text-3xl font-semibold tracking-tight text-white lg:text-2xl">
                        Ready to Make a Difference?
                    </h3>
                    <p className="mx-auto mb-8 max-w-2xl text-lg leading-relaxed text-white/90">
                        Join our mission to create ethical, transparent, and
                        user-first shopping tools. Your contribution, no matter
                        how small, helps build a better internet for everyone.
                    </p>
                    <div className="flex justify-center gap-6 lg:flex-col lg:items-center lg:gap-4">
                        <motion.a
                            href="https://github.com/DevinoSolutions/caramel"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center rounded-full bg-white px-8 py-4 font-semibold text-caramel shadow-md transition-all duration-200 hover:bg-orange-50 hover:shadow-xl"
                            whileHover={{
                                scale: 1.05,
                                transition: { duration: 0.2 },
                            }}
                            whileTap={{ scale: 0.95 }}
                        >
                            View on GitHub
                        </motion.a>
                        <motion.a
                            href="https://discord.com/invite/2vVVrQ5CEB"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center rounded-full border-2 border-white bg-transparent px-8 py-4 font-semibold text-white transition-all duration-200 hover:bg-white hover:text-caramel"
                            whileHover={{
                                scale: 1.05,
                                transition: { duration: 0.2 },
                            }}
                            whileTap={{ scale: 0.95 }}
                        >
                            Join Discord
                        </motion.a>
                    </div>
                </motion.div>
            </div>
        </section>
    )
}
