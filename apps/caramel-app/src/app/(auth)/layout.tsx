'use client'

import ThemeToggle from '@/components/ThemeToggle'
import { ThemeContext } from '@/lib/contexts'
import Image from 'next/image'
import { useContext } from 'react'
import { HiCheckCircle } from 'react-icons/hi'

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
// toggle. Pages render only their card.
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
            <div className="relative flex min-h-screen items-center justify-center gap-10 overflow-hidden bg-gray-50 px-4 py-12 dark:bg-darkBg sm:py-8 xs:px-3">
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -top-32 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-caramel/10 blur-3xl dark:bg-caramel/15"
                />
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -bottom-40 -right-32 h-96 w-96 rounded-full bg-caramel/[0.07] blur-3xl dark:bg-caramel/10"
                />
                <ThemeToggle className="absolute right-6 top-6 sm:right-4 sm:top-4" />

                {/* Brand side panel — desktop only (this repo's Tailwind is
                    desktop-first: unprefixed = desktop, lg: is a MAX-width
                    override, so lg:hidden removes it ≤1023px). Static markup,
                    no client-only branching → hydration-safe. The gradient
                    pair matches the AA-fixed footer slab (#c14e14/#a63f10:
                    white text ≥4.5:1 at both stops — from-caramel fails). */}
                <aside className="relative w-full max-w-md overflow-hidden rounded-2xl border border-transparent bg-gradient-to-br from-[#c14e14] to-[#a63f10] p-10 text-white shadow-xl ring-1 ring-inset ring-white/20 dark:border-caramel/30 dark:bg-caramel/[0.12] dark:bg-none dark:ring-0 lg:hidden">
                    <Image
                        src="/full-logo.png"
                        alt="Caramel"
                        width={140}
                        height={45}
                        className="brightness-0 invert"
                    />
                    <p className="mt-6 text-2xl font-bold leading-snug">
                        The open-source, privacy-first way to save at checkout.
                    </p>

                    {/* Coupon perforation: dashed tear line + two side punch
                        holes, same ticket motif as the pricing card. Notches
                        straddle the panel edge and are filled with the page
                        background so overflow-hidden clips them into bites. */}
                    <div aria-hidden="true" className="relative -mx-10 my-8">
                        <div className="border-t-2 border-dashed border-white/30 dark:border-caramel/30" />
                        <div className="absolute left-0 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gray-50 dark:bg-darkBg" />
                        <div className="absolute right-0 top-1/2 h-8 w-8 -translate-y-1/2 translate-x-1/2 rounded-full bg-gray-50 dark:bg-darkBg" />
                    </div>

                    <ul className="space-y-3">
                        {brandPoints.map(point => (
                            <li
                                key={point}
                                className="flex items-start gap-3 text-[15px] font-medium"
                            >
                                <HiCheckCircle
                                    aria-hidden="true"
                                    className="mt-0.5 shrink-0 text-xl text-white/90 dark:text-caramel"
                                />
                                {point}
                            </li>
                        ))}
                    </ul>

                    <p
                        aria-hidden="true"
                        className="mt-8 font-mono text-xs tracking-[0.35em] text-white/70 dark:text-gray-400"
                    >
                        CARAMEL-FREE-FOREVER
                    </p>
                </aside>

                {children}
            </div>
        </div>
    )
}
