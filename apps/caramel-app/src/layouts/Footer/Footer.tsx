'use client'

import {
    DISCORD_INVITE_URL,
    GITHUB_REPO_URL,
    INSTAGRAM_URL,
} from '@/lib/brandLinks'
import { motion } from 'framer-motion'
import Image from 'next/image'
import Link from 'next/link'
import { FaDiscord, FaGithub } from 'react-icons/fa'
import { RiInstagramFill } from 'react-icons/ri'

/* Read once at module scope so the server render and the first client render
   produce the same string. The only divergence possible is a page that is
   server-rendered on Dec 31 and hydrated on Jan 1, which is acceptable. */
const currentYear = new Date().getFullYear()

const productLinks = [
    { name: 'Home', url: '/' },
    { name: 'Pricing', url: '/pricing' },
    { name: 'Coupons', url: '/coupons' },
    { name: 'Supported Stores', url: '/supported-stores' },
    { name: 'Sources', url: '/sources' },
]

const communityLinks = [
    {
        name: 'GitHub',
        url: GITHUB_REPO_URL,
        icon: <FaGithub aria-hidden="true" />,
    },
    {
        name: 'Discord',
        url: DISCORD_INVITE_URL,
        icon: <FaDiscord aria-hidden="true" />,
    },
    {
        name: 'Instagram',
        url: INSTAGRAM_URL,
        icon: <RiInstagramFill aria-hidden="true" />,
    },
]

const legalLinks = [{ name: 'Privacy Policy', url: '/privacy' }]

const headingClasses =
    'text-sm font-semibold uppercase tracking-wider text-white dark:text-caramel'
const linkClasses =
    'rounded text-[15px] text-white transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 dark:text-gray-300 dark:hover:text-white dark:focus-visible:ring-caramel/70'

export default function Footer() {
    return (
        // WCAG AA: white 15px links need 4.5:1 against BOTH gradient stops.
        // The brand slab (from-caramel #ea6925 → #c9531a) gives 3.21/4.43 —
        // both fail — so the footer runs a deepened caramel pair instead:
        // #c14e14 (4.81:1) → #a63f10 (6.29:1). Same hue family, text stays
        // white. Don't lighten these back to from-caramel without re-checking.
        //
        // Re-verified 2026-07-28 — the nav links in linkClasses are the same
        // white (4.81:1 / 6.29:1 vs the two stops), hover keeps white (underline
        // only). gray-300 here would FAIL: 3.26:1 / 4.27:1 — never use it on
        // this gradient. Dark mode swaps the surface to darkSurface #1E1916,
        // where gray-300 links hit 11.8:1 (hover white 17.4:1) — both pass.
        <footer className="border-t-2 border-dashed border-white/40 bg-gradient-to-br from-[#c14e14] to-[#a63f10] text-white dark:border-caramel/40 dark:bg-darkSurface dark:bg-none">
            <div className="container mx-auto px-6 pt-12">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                    viewport={{ once: true }}
                    className="grid grid-cols-[1.6fr_1fr_1fr_1fr] gap-10 md:grid-cols-2 sm:grid-cols-1 sm:text-center"
                >
                    <div className="flex flex-col items-start gap-4 sm:items-center">
                        <Link
                            href="/"
                            className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 dark:focus-visible:ring-caramel/70"
                        >
                            <Image
                                src="/full-logo.png"
                                alt="Caramel"
                                width={140}
                                height={45}
                                className="brightness-0 invert"
                            />
                        </Link>
                        <p className="max-w-xs text-[15px] text-white dark:text-gray-300">
                            The open-source, privacy-first way to save at
                            checkout.
                        </p>
                    </div>

                    <nav aria-label="Product">
                        <h2 className={headingClasses}>Product</h2>
                        <ul className="mt-4 flex flex-col gap-2.5">
                            {productLinks.map(link => (
                                <li key={link.name}>
                                    <Link
                                        href={link.url}
                                        className={linkClasses}
                                    >
                                        {link.name}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </nav>

                    <nav aria-label="Community">
                        <h2 className={headingClasses}>Community</h2>
                        <ul className="mt-4 flex flex-col gap-2.5">
                            {communityLinks.map(link => (
                                <li key={link.name}>
                                    <a
                                        href={link.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className={`inline-flex items-center gap-2 ${linkClasses}`}
                                    >
                                        <span className="text-base">
                                            {link.icon}
                                        </span>
                                        {link.name}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </nav>

                    <nav aria-label="Legal">
                        <h2 className={headingClasses}>Legal</h2>
                        <ul className="mt-4 flex flex-col gap-2.5">
                            {legalLinks.map(link => (
                                <li key={link.name}>
                                    <Link
                                        href={link.url}
                                        className={linkClasses}
                                    >
                                        {link.name}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </nav>
                </motion.div>
            </div>

            {/* Copyright and Powered By */}
            <div className="container mx-auto px-6 py-6">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                    viewport={{ once: true }}
                    className="mt-6 flex items-center justify-between gap-4 border-t border-white/25 pt-6 dark:border-white/10 sm:flex-col sm:text-center"
                >
                    <p className="text-sm text-white dark:text-gray-300">
                        © {currentYear} Caramel. All Rights Reserved.
                    </p>
                    <div className="flex items-center gap-2">
                        <span className="text-sm text-white dark:text-gray-300">
                            Powered by
                        </span>
                        <Image
                            src="/devino.png"
                            alt="Devino"
                            width={60}
                            height={20}
                            className="inline-block"
                        />
                    </div>
                </motion.div>
            </div>
        </footer>
    )
}
