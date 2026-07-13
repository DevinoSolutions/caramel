'use client'

import { motion } from 'framer-motion'
import { useState } from 'react'
import {
    FaExternalLinkAlt,
    FaEye,
    FaHandHoldingHeart,
    FaPlay,
    FaShieldAlt,
    FaTimesCircle,
} from 'react-icons/fa'

// This copy isn't rendered by the JSX below yet (F-009 oxlint sweep found
// it while adding the gate — flagged as a new-finding candidate: either
// wire up a comparison grid or delete the dead copy; not this finding's
// call to make).
// oxlint-disable-next-line no-unused-vars
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

// Same as problemsWithHoney above: unrendered, flagged as a new-finding
// candidate rather than deleted here.
// oxlint-disable-next-line no-unused-vars
const caramelSolutions = [
    {
        title: 'Respects Creator Links',
        desc: 'We never override affiliate links - creators keep 100% of their rightful commissions',
    },
    {
        title: 'Zero Data Collection',
        desc: "Your browsing habits stay private - we don't track, store, or sell your personal information",
    },
    {
        title: 'Supports Content Creators',
        desc: 'Help sustain the creators you love while still getting the best deals available',
    },
    {
        title: 'Fully Open Source',
        desc: 'Every line of code is public and auditable - see exactly what we do with your data',
    },
]

export default function WhyNotHoneySection() {
    const [videoLoaded, setVideoLoaded] = useState(false)

    return (
        <section id="why-not" className="relative overflow-hidden py-32">
            {/* Background Elements */}
            <div className="absolute inset-0">
                <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-red-500/20 to-transparent"></div>
                <div className="absolute bottom-0 left-0 h-px w-full bg-gradient-to-r from-transparent via-caramel/20 to-transparent"></div>
                {/* Floating warning elements */}
                <motion.div
                    className="left-1/6 absolute top-1/4 h-24 w-24 rounded-full bg-red-500/5 blur-xl"
                    animate={{
                        x: [0, 20, 0],
                        y: [0, -15, 0],
                    }}
                    transition={{
                        duration: 8,
                        repeat: Infinity,
                        ease: 'easeInOut',
                    }}
                />
                <motion.div
                    className="right-1/6 absolute top-3/4 h-20 w-20 rounded-full bg-orange-500/5 blur-lg"
                    animate={{
                        x: [0, -15, 0],
                        y: [0, 20, 0],
                    }}
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
                    <h2 className="mb-8 text-5xl font-extrabold leading-[80px] tracking-tight text-caramel lg:text-4xl">
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
                                <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-900 to-black">
                                    <motion.button
                                        onClick={() => setVideoLoaded(true)}
                                        className="flex items-center gap-4 rounded-full bg-red-600 px-8 py-4 font-semibold text-white shadow-lg transition-all duration-300 hover:bg-red-700"
                                        whileHover={{ scale: 1.05 }}
                                        whileTap={{ scale: 0.95 }}
                                    >
                                        <FaPlay className="text-lg" />
                                        Watch: The Truth About Honey
                                    </motion.button>
                                </div>
                            )}
                            {videoLoaded && (
                                <iframe
                                    src="https://www.youtube.com/embed/vc4yL3YTwWk?autoplay=1"
                                    title="The Truth About Honey"
                                    className="h-full w-full"
                                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                    allowFullScreen
                                />
                            )}
                        </div>
                        <motion.a
                            href="https://www.youtube.com/watch?v=vc4yL3YTwWk"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-4 inline-flex items-center gap-2 text-sm text-gray-600 transition-colors duration-200 hover:text-caramel dark:text-gray-400"
                            whileHover={{ scale: 1.02 }}
                        >
                            <FaExternalLinkAlt />
                            Watch on YouTube
                        </motion.a>
                    </motion.div>
                </motion.div>

                {/* Call to Action */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.8, ease: 'easeOut' }}
                    className="rounded-3xl bg-gradient-to-r from-caramel to-orange-600 p-12 text-center text-white shadow-2xl lg:p-8"
                >
                    <h3 className="mb-6 text-3xl font-semibold tracking-tight lg:text-2xl">
                        Make the Switch to Caramel
                    </h3>
                    <p className="mx-auto mb-8 max-w-3xl text-lg leading-relaxed opacity-90">
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
