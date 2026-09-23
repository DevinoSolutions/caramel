'use client'
// src/app/(marketing)/apps/AppsPageClient.tsx
//
// The download page (fleet growth-prompts spec §C). Store URLs come from
// Caramel's manifest entry via storeListings.ts; the reasons-to-install come
// from appsAdvantages.ts (read its header before adding a line); the sibling
// apps come from the shared manifest via crossAppPromotions.ts.
//
// BREAKPOINTS: this repo's Tailwind screens are MAX-width (`md:` = ≤767px),
// so the base class is the desktop layout and `md:` collapses it. Shipping the
// mobile-first reading of these classes put two columns on phones (caught
// in PR #255 review screenshots).
//
// SURFACE: on the `extension` surface the badges are NOT rendered — nothing
// that advertises the extension may render where it already is (spec §A).
// The page still has a job there (the sibling apps), so it is not redirected
// away; it opens with an "already installed" note instead.
import { trackGrowthEvent } from '@/lib/analytics/growthEvents'
import { canAdvertiseInstall } from '@/lib/surface/detectSurface'
import { useSurface } from '@/lib/surface/SurfaceProvider'
import Link from 'next/link'
import { useEffect, useRef } from 'react'
import {
    FiArrowUpRight,
    FiCheck,
    FiCheckCircle,
    FiDownload,
} from 'react-icons/fi'
import { PLATFORM_ADVANTAGES } from './appsAdvantages'
import { CROSS_APP_PROMOTIONS } from './crossAppPromotions'
import {
    STORE_CARDS,
    STORE_TRADEMARK_NOTICE,
    type AppStoreListing,
    type ComingSoonStoreListing,
    type StoreCard,
} from './storeListings'

/**
 * The store's own badge as a real link with an accessible name. The `<img>`
 * is decorative (`alt=""`) with the name on the `<a>`: the artwork reads
 * "Available in the Chrome Web Store", which does not say WHICH extension on
 * a page listing four. Plain `<img>`, not `next/image`: every guideline set
 * forbids modifying the artwork and an optimizer re-encodes it.
 */
function StoreBadgeLink({
    listing,
    isMatch,
}: {
    listing: AppStoreListing
    isMatch: boolean
}) {
    const { badge, href, platform } = listing
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={badge.accessibleName}
            data-store={platform}
            onClick={() =>
                trackGrowthEvent('store_badge_click', {
                    store: platform,
                    browser: isMatch ? platform : undefined,
                })
            }
            className="inline-flex min-h-[44px] w-fit items-center rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-caramel"
        >
            <img
                src={badge.src}
                alt=""
                width={badge.width}
                height={badge.height}
                className={`${badge.heightClass} w-auto`}
            />
        </a>
    )
}

/**
 * The same official badge for a store Caramel is NOT on yet. NOT A LINK — a
 * `<span>` with a visible "Coming soon" label, so the sighted and the
 * screen-reader answer are the same words and nothing offers itself to be
 * activated. The artwork is greyed with a CSS filter, not swapped for a
 * lookalike (the stores forbid recolouring their badges; a filter over the
 * unmodified asset is not a modified asset).
 */
function ComingSoonBadge({ card }: { card: ComingSoonStoreListing }) {
    const { badge, comingSoonLabel } = card
    return (
        <span
            aria-disabled="true"
            data-store-status="coming-soon"
            className="inline-flex min-h-[44px] w-fit flex-wrap items-center gap-x-3 gap-y-1"
        >
            <img
                src={badge.src}
                alt=""
                aria-hidden="true"
                width={badge.width}
                height={badge.height}
                className={`${badge.heightClass} w-auto opacity-60 grayscale`}
            />
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700 dark:bg-white/10 dark:text-gray-200">
                {comingSoonLabel}
            </span>
        </span>
    )
}

function BrowserCard({ card, isMatch }: { card: StoreCard; isMatch: boolean }) {
    return (
        <li
            data-platform={card.platform}
            className={`flex h-full flex-col gap-4 rounded-2xl border p-5 ${
                isMatch
                    ? 'border-caramel bg-caramel/5 shadow-caramel-lg dark:bg-caramel/10'
                    : 'border-gray-200 bg-white dark:border-white/10 dark:bg-darkSurface'
            }`}
        >
            <div className="flex items-start gap-3">
                <div className="min-w-0">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                        {card.browserLabel}
                    </h3>
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                        {card.status === 'listed' && isMatch
                            ? card.matchedLabel
                            : card.storeName}
                    </p>
                </div>
                {isMatch && (
                    <span className="ml-auto shrink-0 rounded-full bg-caramel px-2 py-0.5 text-xs font-semibold text-white">
                        Your browser
                    </span>
                )}
            </div>

            <ul className="flex flex-col gap-2">
                {PLATFORM_ADVANTAGES[card.platform].map(advantage => (
                    <li
                        key={advantage.text}
                        className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300"
                    >
                        <FiCheck
                            className="mt-0.5 h-4 w-4 shrink-0 text-caramel"
                            aria-hidden="true"
                        />
                        <span>{advantage.text}</span>
                    </li>
                ))}
            </ul>

            <div className="mt-auto pt-1">
                {card.status === 'listed' ? (
                    <StoreBadgeLink listing={card} isMatch={isMatch} />
                ) : (
                    <ComingSoonBadge card={card} />
                )}
            </div>
        </li>
    )
}

const RELATED_LINKS = [
    { href: '/', label: 'Home' },
    { href: '/coupons', label: 'Browse coupons' },
    { href: '/supported-stores', label: 'Supported stores' },
    { href: '/pricing', label: 'Is Caramel free?' },
    { href: '/support', label: 'Support' },
] as const

export default function AppsPageClient() {
    const { surface, browser, platform } = useSurface()
    const viewCaptured = useRef(false)
    const advertise = canAdvertiseInstall(surface)

    // `apps_page_view` is the denominator for store CTR: exactly once per
    // visit, and only once the surface is KNOWN so an extension-surface view
    // (no badges shown) is still recorded with the right `surface`.
    useEffect(() => {
        if (viewCaptured.current || surface === 'unknown') return
        viewCaptured.current = true
        trackGrowthEvent('apps_page_view', { surface, platform, browser })
    }, [surface, platform, browser])

    // The visitor's own browser leads; every other card still renders below
    // in the declared order (someone fetching a link for another machine is
    // normal), so nothing is ever hidden.
    const matched = STORE_CARDS.find(card => card.platform === browser)
    const ordered = matched
        ? [matched, ...STORE_CARDS.filter(card => card !== matched)]
        : STORE_CARDS

    return (
        <main className="flex min-h-screen w-full flex-col items-center px-6 pb-20 pt-32 dark:bg-darkBg">
            <div className="flex w-full max-w-5xl flex-col gap-8">
                <header className="flex flex-col gap-3">
                    <div className="flex items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-caramel text-white shadow-caramel-sm">
                            <FiDownload
                                className="h-5 w-5"
                                aria-hidden="true"
                            />
                        </span>
                        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
                            Get the Caramel extension
                        </h1>
                    </div>
                    {advertise ? (
                        <p className="max-w-3xl text-gray-600 dark:text-gray-300">
                            Caramel is a free, open-source browser extension.
                            Installed, it finds and applies coupon codes at
                            checkout on its own — every card below lists what
                            that build actually does. Your browser comes first.
                        </p>
                    ) : (
                        <p
                            data-testid="apps-installed-note"
                            className="flex max-w-3xl items-start gap-2 rounded-2xl border border-caramel/40 bg-caramel/5 px-4 py-3 text-gray-700 dark:text-gray-200"
                        >
                            <FiCheckCircle
                                className="mt-0.5 h-5 w-5 shrink-0 text-caramel"
                                aria-hidden="true"
                            />
                            <span>
                                Caramel is already installed in this browser.
                                Codes apply themselves at checkout; there is
                                nothing more to get here.
                            </span>
                        </p>
                    )}
                </header>

                {advertise && (
                    <section
                        aria-labelledby="apps-stores-heading"
                        data-growth="install"
                    >
                        <h2
                            id="apps-stores-heading"
                            className="mb-4 text-xl font-semibold text-gray-900 dark:text-white"
                        >
                            Choose your browser
                        </h2>
                        <ul className="grid grid-cols-2 gap-4 md:grid-cols-1">
                            {ordered.map(card => (
                                <BrowserCard
                                    key={card.platform}
                                    card={card}
                                    isMatch={card === matched}
                                />
                            ))}
                        </ul>
                        <p className="mt-4 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                            {STORE_TRADEMARK_NOTICE}
                        </p>
                    </section>
                )}

                {/* No "use with your AI tools" section: Caramel ships no MCP
                    server (CARAMEL_APP.mcp is false). Add it here, gated on
                    that flag, the day one exists — never before. */}

                <section
                    aria-labelledby="apps-devino-heading"
                    className="border-t border-gray-200 pt-6 dark:border-white/10"
                >
                    <h2
                        id="apps-devino-heading"
                        className="mb-1 text-xl font-semibold text-gray-900 dark:text-white"
                    >
                        More from Devino
                    </h2>
                    <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
                        Caramel is built by Devino, which also makes:
                    </p>
                    <ul className="grid grid-cols-3 gap-4 md:grid-cols-1">
                        {CROSS_APP_PROMOTIONS.map(app => (
                            <li key={app.id}>
                                <a
                                    href={app.href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    data-target-app={app.id}
                                    onClick={() =>
                                        trackGrowthEvent('crossapp_click', {
                                            target_app: app.id,
                                            surface,
                                        })
                                    }
                                    className="group flex h-full items-start gap-3 rounded-2xl border border-gray-200 bg-white px-5 py-4 transition-shadow duration-200 hover:shadow-caramel-lg dark:border-white/10 dark:bg-darkSurface"
                                >
                                    <img
                                        src={app.icon}
                                        alt=""
                                        width={40}
                                        height={40}
                                        loading="lazy"
                                        className="h-10 w-10 shrink-0 rounded-xl"
                                    />
                                    <span className="min-w-0">
                                        <span className="flex items-center gap-1 font-medium text-gray-900 dark:text-white">
                                            {app.name}
                                            <FiArrowUpRight
                                                className="h-4 w-4 shrink-0 text-gray-400 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                                                aria-hidden="true"
                                            />
                                        </span>
                                        <span className="mt-1 block text-sm text-gray-600 dark:text-gray-300">
                                            {app.blurb}
                                        </span>
                                    </span>
                                </a>
                            </li>
                        ))}
                    </ul>
                </section>

                <nav
                    aria-label="Related pages"
                    className="border-t border-gray-200 pt-6 dark:border-white/10"
                >
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Keep exploring
                    </h2>
                    <ul className="flex flex-wrap gap-x-6 gap-y-2">
                        {RELATED_LINKS.map(link => (
                            <li key={link.href}>
                                <Link
                                    href={link.href}
                                    className="text-sm text-caramel underline hover:no-underline"
                                >
                                    {link.label}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </nav>
            </div>
        </main>
    )
}
