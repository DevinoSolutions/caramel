'use client'

import ThemeToggle from '@/components/ThemeToggle'
import { ThemeContext } from '@/lib/contexts'
import Image from 'next/image'
import Link from 'next/link'
import { useContext } from 'react'
import { HiArrowLeft, HiCheckCircle } from 'react-icons/hi'

// Claim-safe brand copy only (claim-integrity sweep 2026-07-28): no store
// counts we can't prove, no "zero tracking" phrasing — the analytics stack is
// disclosed in /privacy.
const brandPoints = [
    'Automatic coupons at checkout',
    'Zero ads or data selling',
    'Never hijacks affiliate commissions',
    '100% open source extension & web app',
]

// Auth routes are deliberately layoutless (no Header/Footer — see
// providers.tsx `pagesLayoutless`), so this shell owns what Layout.tsx owns
// everywhere else: the `dark` class scope, the page background, and a theme
// toggle. Pages render only their form column.
//
// LAYOUT NOTE: this repo's Tailwind is DESKTOP-FIRST (tailwind.config.ts uses
// `max` screens) — unprefixed = desktop, and `lg:` is a MAX-width override
// applying at ≤1023px. So `lg:hidden` removes the brand panel on tablet/mobile.
//
// The previous shell centered two separately-rounded cards side by side inside
// a mostly empty viewport: they were different heights, visibly misaligned, and
// the whole composition floated in a large field of background at any desktop
// height. This is a full-bleed split instead — brand panel owns the left edge,
// the form owns an honest column of its own — which is both calmer and gives
// the form room to grow (the reset-password flow adds pages to this group).
export default function AuthLayout({
    children,
}: {
    children: React.ReactNode
}) {
    const { isDarkMode } = useContext(ThemeContext)

    return (
        // The server has no access to the stored theme and renders `light`; so
        // does the first client render (providers.tsx adopts it in an effect),
        // so this needs no hydration suppression. <html> already carries the
        // real theme pre-paint — see app/layout.tsx.
        <div className={isDarkMode ? 'dark' : 'light'}>
            <div className="flex min-h-screen bg-white dark:bg-darkBg">
                {/* Brand panel — desktop only. Static markup, no client-only
                    branching → hydration-safe. The gradient pair matches the
                    AA-fixed footer slab (#c14e14/#a63f10: white text ≥4.5:1 at
                    both stops — from-caramel fails). */}
                <aside className="relative flex w-[44%] shrink-0 flex-col justify-between overflow-hidden bg-gradient-to-br from-[#c14e14] to-[#a63f10] p-12 text-white xl:w-[42%] lg:hidden">
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-3xl"
                    />
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-black/10 blur-3xl"
                    />

                    <div className="relative">
                        <Link
                            href="/"
                            className="inline-flex items-center gap-2 rounded-sm text-sm font-medium text-white/80 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                        >
                            <HiArrowLeft aria-hidden="true" />
                            Back to grabcaramel.com
                        </Link>
                    </div>

                    <div className="relative">
                        <Image
                            src="/full-logo.png"
                            alt="Caramel"
                            width={150}
                            height={48}
                            className="brightness-0 invert"
                        />
                        <p className="mt-7 max-w-sm text-[28px] font-bold leading-[1.25] 3xl:text-2xl">
                            The open-source, privacy-first way to save at
                            checkout.
                        </p>

                        {/* Coupon perforation: dashed tear line + two side punch
                            holes, same ticket motif as the pricing card. The
                            notches straddle the panel edge; the left one is
                            clipped by overflow-hidden, the right one bites into
                            the form column, so it reads as a torn stub. */}
                        <div
                            aria-hidden="true"
                            className="relative -mx-12 my-9"
                        >
                            <div className="border-t-2 border-dashed border-white/30" />
                            <div className="absolute left-0 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white dark:bg-darkBg" />
                            <div className="absolute right-0 top-1/2 h-9 w-9 -translate-y-1/2 translate-x-1/2 rounded-full bg-white dark:bg-darkBg" />
                        </div>

                        <ul className="space-y-3.5">
                            {brandPoints.map(point => (
                                <li
                                    key={point}
                                    className="flex items-start gap-3 text-[15px] font-medium"
                                >
                                    <HiCheckCircle
                                        aria-hidden="true"
                                        className="mt-0.5 shrink-0 text-xl text-white/90"
                                    />
                                    {point}
                                </li>
                            ))}
                        </ul>
                    </div>

                    <p
                        aria-hidden="true"
                        className="relative font-mono text-xs tracking-[0.35em] text-white/60"
                    >
                        CARAMEL-FREE-FOREVER
                    </p>
                </aside>

                {/* Form column */}
                <main className="relative flex flex-1 flex-col items-center justify-center px-8 py-14 sm:px-5 sm:py-10 xs:px-4">
                    <ThemeToggle className="absolute right-6 top-6 sm:right-4 sm:top-4" />

                    {/* Compact brand header, mobile/tablet only — the panel is
                        gone there, and a form with no logo above it reads as a
                        stray page rather than as Caramel. */}
                    <div className="mb-9 hidden w-full max-w-[26rem] lg:block sm:mb-7">
                        <Link
                            href="/"
                            className="inline-flex items-center gap-2 rounded-sm text-sm font-medium text-gray-500 transition hover:text-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50 dark:text-gray-400"
                        >
                            <HiArrowLeft aria-hidden="true" />
                            Back to home
                        </Link>
                        <Image
                            src="/full-logo.png"
                            alt="Caramel"
                            width={132}
                            height={42}
                            className="mt-5 dark:brightness-0 dark:invert"
                        />
                    </div>

                    {children}
                </main>
            </div>
        </div>
    )
}
