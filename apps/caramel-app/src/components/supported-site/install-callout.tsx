'use client'

import { listingForBrowser } from '@/app/(marketing)/apps/storeListings'
import InstallSurfaceGate from '@/components/growth/InstallSurfaceGate'
import { trackGrowthEvent } from '@/lib/analytics/growthEvents'
import type { DevicePlatform } from '@/lib/surface/detectPlatform'
import { useSurface } from '@/lib/surface/SurfaceProvider'
import Link from 'next/link'

// The install step for /supported-stores, directly under the search box.
//
// PostHog, 30 days to 2026-09-25: /supported-stores was the second-biggest
// landing page (175 landing sessions; 213 sessions typed a store into the
// search), yet the page carried NO install link at all — 5 of those 175
// landing sessions ever clicked through to a browser store, against 621 of
// 1,310 for the homepage. A shopper who has just confirmed their store is
// supported had no next step on the page that answered them.
//
// Desktop only gets a store link: an extension cannot be installed from a
// phone (Android Chrome has none; the Safari listing is the Mac App Store), and
// before hydration the browser is not known yet. Both send the shopper to
// /apps, which shows every build.
const DESKTOP: ReadonlySet<DevicePlatform> = new Set<DevicePlatform>([
    'macos',
    'windows',
    'unknown',
])

const INSTALL_CALLOUT_PLACEMENT = 'supported_stores'

export default function InstallCallout() {
    const { platform, browser } = useSurface()
    const listing = DESKTOP.has(platform) ? listingForBrowser(browser) : null

    return (
        <InstallSurfaceGate>
            <div className="mt-6 flex items-center justify-between gap-4 rounded-3xl border border-caramel/20 bg-white/80 px-6 py-4 shadow-sm dark:border-caramel/30 dark:bg-darkSurface sm:flex-col sm:text-center">
                <p className="text-sm text-gray-700 dark:text-gray-300">
                    <span className="font-semibold text-gray-900 dark:text-white">
                        Found your store?
                    </span>{' '}
                    Caramel applies the best code for you at checkout. Free and
                    open source.
                </p>
                {listing ? (
                    // canonicalHref, not href: `href` carries the /apps
                    // page's utm_medium, and this click is attributed by the
                    // `placement` on its own PostHog event instead.
                    <a
                        href={listing.canonicalHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-store={listing.platform}
                        onClick={() =>
                            trackGrowthEvent('install_cta_click', {
                                store: listing.platform,
                                browser,
                                placement: INSTALL_CALLOUT_PLACEMENT,
                            })
                        }
                        className="shrink-0 rounded-full bg-gradient-to-r from-caramel to-orange-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:focus-visible:ring-offset-darkSurface"
                    >
                        Add to {listing.browserLabel}
                    </a>
                ) : (
                    <Link
                        href="/apps"
                        className="shrink-0 rounded-full bg-gradient-to-r from-caramel to-orange-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:focus-visible:ring-offset-darkSurface"
                    >
                        Get Caramel
                    </Link>
                )}
            </div>
        </InstallSurfaceGate>
    )
}
