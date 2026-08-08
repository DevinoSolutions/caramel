'use client'

import { useReducedMotion } from '@/lib/reducedMotion'
import { motion } from 'framer-motion'
import Image from 'next/image'
import { useState } from 'react'
import {
    FaExternalLinkAlt,
    FaEye,
    FaHandHoldingHeart,
    FaPlay,
    FaShieldAlt,
    FaTimesCircle,
} from 'react-icons/fa'
import { HiCheckCircle } from 'react-icons/hi'

const VIDEO_ID = 'vc4yL3YTwWk'
const VIDEO_TITLE = 'The Truth About Honey'
// maxresdefault verified 200 (166 KB) for this video; i.ytimg.com is
// allowlisted in next.config.mjs images.remotePatterns.
const VIDEO_THUMBNAIL = `https://i.ytimg.com/vi/${VIDEO_ID}/maxresdefault.jpg`

// Rendered as the "Honey vs Caramel" comparison below (wired 2026-07-28 —
// this copy sat unrendered since the F-009 oxlint sweep flagged it). The
// Honey-side claims are documented public reporting (affiliate-link
// replacement, data collection, creator revenue loss, closed source); the
// Caramel-side claims are scoped to what the extension verifiably does.
const problemsWithHoney = [
    {
        title: 'Affiliate Link Hijacking',
        desc: "Honey secretly replaces creators' affiliate links with their own, stealing commissions from content creators you want to support",
        icon: <FaTimesCircle />,
    },
    {
        title: 'Hidden Data Collection',
        desc: 'Your browsing data, purchase history, and personal information is collected and sold to third parties without clear disclosure',
        icon: <FaEye />,
    },
    {
        title: 'Creator Revenue Loss',
        desc: 'YouTubers, bloggers, and influencers lose millions in rightful earnings when Honey overrides their referral links',
        icon: <FaHandHoldingHeart />,
    },
    {
        title: 'Closed Source Operation',
        desc: "You can't verify what Honey actually does behind the scenes - their code is completely hidden from public scrutiny",
        icon: <FaShieldAlt />,
    },
]

// Paired row-for-row with problemsWithHoney in the comparison grid below.
// "No Data Selling" is deliberately NOT "zero data collection": the extension
// does send cart/page context to Caramel's own API to classify the cart, and
// the website runs standard analytics — the honest, verifiable claim is that
// personal information is never sold or shared (claim-verify ruling 2026-07-28).
const caramelSolutions = [
    {
        title: 'Respects Creator Links',
        desc: 'We never override affiliate links - creators keep 100% of their rightful commissions',
    },
    {
        title: 'No Data Selling',
        desc: 'Your browsing habits stay private - we never sell or share your personal information',
    },
    {
        title: 'Supports Content Creators',
        desc: 'Help sustain the creators you love while still getting the best deals available',
    },
    {
        title: 'Fully Open Source',
        desc: 'Every line of code is public and auditable under the AGPL-3.0 license - see exactly what the extension does',
    },
]

export default function WhyNotHoneySection() {
    const [videoLoaded, setVideoLoaded] = useState(false)
    const reduceMotion = useReducedMotion()

    return (
        <section id="why-not" className="relative overflow-hidden py-32">
            {/* Background Elements */}
            <div className="absolute inset-0">
                <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-red-500/20 to-transparent"></div>
                <div className="absolute bottom-0 left-0 h-px w-full bg-gradient-to-r from-transparent via-caramel/20 to-transparent"></div>
                {/* Floating warning elements */}
                <motion.div
                    className="left-1/6 absolute top-1/4 h-24 w-24 rounded-full bg-red-500/5 blur-xl"
                    animate={
                        reduceMotion
                            ? undefined
                            : {
                                  x: [0, 20, 0],
                                  y: [0, -15, 0],
                              }
                    }
                    transition={{
                        duration: 8,
                        repeat: Infinity,
                        ease: 'easeInOut',
                    }}
                />
                <motion.div
                    className="right-1/6 absolute top-3/4 h-20 w-20 rounded-full bg-orange-500/5 blur-lg"
                    animate={
                        reduceMotion
                            ? undefined
                            : {
                                  x: [0, -15, 0],
                                  y: [0, 20, 0],
                              }
                    }
                    transition={{
                        duration: 10,
                        repeat: Infinity,
                        ease: 'easeInOut',
                        delay: 2,
                    }}
                />
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
                        Why Not Just Use Honey?
                    </h2>
                    <p className="mx-auto mb-8 max-w-4xl text-xl leading-relaxed text-gray-600 dark:text-gray-300 lg:text-lg">
                        Reports show{' '}
                        <span className="font-semibold text-red-600">
                            Honey and many other extensions override affiliate
                            links
                        </span>{' '}
                        — cutting creatorsʼ revenue and your savings.{' '}
                        <span className="font-semibold text-caramel">
                            Caramel is the transparent, open-source fix.
                        </span>{' '}
                        <span className="font-semibold">Watch why →</span>
                    </p>

                    {/* Video Section */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95 }}
                        whileInView={{ opacity: 1, scale: 1 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.6, delay: 0.2 }}
                        className="mx-auto mb-16 max-w-4xl"
                    >
                        <div className="relative aspect-video overflow-hidden rounded-2xl bg-black shadow-2xl">
                            {!videoLoaded && (
                                // Click-to-load facade: the YouTube iframe (and
                                // its cookies) stay off the page until the
                                // visitor asks for the video. The whole poster
                                // is the button so the hit area matches what it
                                // looks like.
                                <motion.button
                                    type="button"
                                    onClick={() => setVideoLoaded(true)}
                                    aria-label={`Play video: ${VIDEO_TITLE}`}
                                    className="group absolute inset-0 block h-full w-full cursor-pointer"
                                    whileHover="hover"
                                    whileTap="tap"
                                >
                                    <Image
                                        src={VIDEO_THUMBNAIL}
                                        alt=""
                                        fill
                                        sizes="(max-width: 896px) 100vw, 896px"
                                        className="object-cover"
                                    />
                                    <span
                                        aria-hidden="true"
                                        className="absolute inset-0 bg-darkerBg/55"
                                    />
                                    <span className="absolute inset-0 flex items-center justify-center">
                                        <motion.span
                                            variants={{
                                                hover: { scale: 1.08 },
                                                tap: { scale: 0.95 },
                                            }}
                                            className="flex h-20 w-20 items-center justify-center rounded-full bg-caramel shadow-lg shadow-black/40 sm:h-16 sm:w-16"
                                        >
                                            <FaPlay
                                                aria-hidden="true"
                                                className="ml-1 text-2xl text-white sm:text-xl"
                                            />
                                        </motion.span>
                                    </span>
                                    <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-darkerBg/85 to-transparent px-6 pb-4 pt-10 text-left text-sm font-semibold text-white sm:px-4 sm:text-xs">
                                        {VIDEO_TITLE}
                                    </span>
                                </motion.button>
                            )}
                            {videoLoaded && (
                                <iframe
                                    src={`https://www.youtube.com/embed/${VIDEO_ID}?autoplay=1`}
                                    title={VIDEO_TITLE}
                                    className="h-full w-full"
                                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                    allowFullScreen
                                />
                            )}
                        </div>
                        <motion.a
                            href={`https://www.youtube.com/watch?v=${VIDEO_ID}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-4 inline-flex items-center gap-2 text-sm text-gray-600 transition-colors duration-200 hover:text-caramel dark:text-gray-400"
                            whileHover={{ scale: 1.02 }}
                        >
                            <FaExternalLinkAlt aria-hidden="true" />
                            Watch on YouTube
                        </motion.a>
                    </motion.div>
                </motion.div>

                {/* Honey vs Caramel — the NAMED comparison. Same table
                    treatment as FeaturesSection's "Caramel vs Others" (classes
                    copied, not refactored — that file is owned by a parallel
                    branch): one header row, muted losing column, tinted+ringed
                    winning column. */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, ease: 'easeOut' }}
                    className="mb-24"
                >
                    <div className="mb-12 text-center">
                        <h3 className="mb-4 text-3xl font-extrabold tracking-tight text-gray-900 dark:text-white lg:text-2xl">
                            Honey vs Caramel
                        </h3>
                        <p className="mx-auto max-w-2xl text-gray-600 dark:text-gray-400">
                            The documented problems with Honey — and what
                            Caramel does instead
                        </p>
                    </div>

                    <div className="mx-auto max-w-5xl">
                        {/* ONE column header for the whole table; padding
                            mirrors the row cells' so the edges line up. */}
                        <div className="mb-4 grid grid-cols-2">
                            <div className="px-6 text-sm font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 sm:px-4">
                                Honey
                            </div>
                            <div className="px-6 text-sm font-semibold uppercase tracking-wide text-caramel sm:px-4">
                                Caramel
                            </div>
                        </div>

                        <div className="space-y-4">
                            {problemsWithHoney.map((problem, index) => {
                                const solution = caramelSolutions[index]
                                return (
                                    <motion.div
                                        key={problem.title}
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
                                        {/* Chrome + hover live on this plain
                                            div: framer writes an inline
                                            transform on the motion wrapper,
                                            which would beat any Tailwind
                                            hover translate placed there. */}
                                        <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm transition-all duration-300 ease-caramel hover:-translate-y-1 hover:border-caramel/60 hover:shadow-[0_12px_32px_-8px_rgba(234,105,37,0.35)] dark:border-caramel/30 dark:bg-darkSurface">
                                            {/* Losing column — muted so the
                                                eye lands on Caramel. */}
                                            <div className="flex items-start gap-4 p-6 opacity-50 sm:gap-3 sm:p-4">
                                                <span
                                                    aria-hidden="true"
                                                    className="mt-1 flex-shrink-0 text-xl text-red-500"
                                                >
                                                    {problem.icon}
                                                </span>
                                                <div>
                                                    <h4 className="mb-1 font-bold text-gray-900 dark:text-white">
                                                        {problem.title}
                                                    </h4>
                                                    <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                                                        {problem.desc}
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Winning column — inset ring so
                                                overflow-hidden can't clip it. */}
                                            <div className="flex items-start gap-4 bg-caramel/[0.08] p-6 ring-1 ring-inset ring-caramel/40 sm:gap-3 sm:p-4">
                                                <HiCheckCircle
                                                    aria-hidden="true"
                                                    className="mt-1 h-6 w-6 flex-shrink-0 text-caramel"
                                                />
                                                <div>
                                                    <h4 className="mb-1 font-bold text-gray-900 dark:text-white">
                                                        {solution.title}
                                                    </h4>
                                                    <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                                                        {solution.desc}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    </motion.div>
                                )
                            })}
                        </div>
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
                        Make the Switch to Caramel
                    </h3>
                    <p className="mx-auto mb-8 max-w-3xl text-lg leading-relaxed text-white/90">
                        Join thousands of users whoʼve made the switch to
                        Caramel. Save money while supporting the creators you
                        love, all with complete transparency and privacy
                        protection.
                    </p>
                    <div className="flex justify-center gap-6 lg:flex-col lg:items-center lg:gap-4">
                        <motion.a
                            href="#install-extension"
                            className="inline-flex items-center rounded-full bg-white px-8 py-4 font-semibold text-caramel shadow-md transition-all duration-200 hover:bg-orange-50 hover:shadow-xl"
                            whileHover={{
                                scale: 1.05,
                                transition: { duration: 0.2 },
                            }}
                            whileTap={{ scale: 0.95 }}
                        >
                            Install Caramel Now
                        </motion.a>
                        <motion.a
                            href="#features"
                            className="inline-flex items-center rounded-full border-2 border-white bg-transparent px-8 py-4 font-semibold text-white transition-all duration-200 hover:bg-white hover:text-caramel"
                            whileHover={{
                                scale: 1.05,
                                transition: { duration: 0.2 },
                            }}
                            whileTap={{ scale: 0.95 }}
                        >
                            Learn More About Caramel
                        </motion.a>
                    </div>
                </motion.div>
            </div>
        </section>
    )
}
