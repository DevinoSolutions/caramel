// src/app/(marketing)/apps/appsStructuredData.ts
//
// JSON-LD for /apps. The root layout already declares ONE SoftwareApplication
// for Caramel as a whole (`#software`); these are the per-browser
// distributions, each with its own `@id`, so they do not collide with it.
//
// ONLY STORES WITH A LIVE LISTING: `STORE_LISTINGS` is the listed subset of
// `STORE_CARDS`. A coming-soon card has no `canonicalHref` field to read, so
// the discriminated union is what keeps an undistributable build out of the
// graph. `downloadUrl` is the campaign-free URL — tracking params belong on
// the badge a human clicks, never in the machine-readable graph
// (`tests/unit/apps-structured-data.test.ts` pins the split).
//
// Deliberately NO aggregateRating: no on-page reviews, and fabricated rating
// markup is a manual-action magnet (same rule as the root layout's schema).
import { BASE_URL } from '@/lib/env.client'
import { STORE_LISTINGS, type AppStoreListing } from './storeListings'

/** "A, B and C" — exported so the description can be checked against fixtures. */
export function formatStoreNameList(names: readonly string[]): string {
    if (names.length === 0) return ''
    if (names.length === 1) return names[0]
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function generateAppsStructuredData(
    listings: readonly AppStoreListing[] = STORE_LISTINGS,
): Record<string, unknown>[] {
    const origin = BASE_URL.replace(/\/+$/, '')
    const appsUrl = `${origin}/apps`

    const applications = listings.map(listing => ({
        '@type': 'SoftwareApplication',
        '@id': `${appsUrl}#${listing.platform}`,
        name: `Caramel for ${listing.browserLabel}`,
        operatingSystem: listing.operatingSystem,
        applicationCategory: 'BrowserApplication',
        description:
            'Free, open-source coupon extension that finds and applies promo codes at checkout without selling browsing data.',
        downloadUrl: listing.canonicalHref,
        installUrl: listing.canonicalHref,
        isAccessibleForFree: true,
        offers: {
            '@type': 'Offer',
            price: '0',
            priceCurrency: 'USD',
            url: `${origin}/pricing`,
        },
        publisher: { '@id': `${origin}/#organization` },
    }))

    return [
        {
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            name: 'Get the Caramel extension',
            description: `Caramel on the ${formatStoreNameList(
                listings.map(listing => listing.storeName),
            )}.`,
            url: appsUrl,
            isPartOf: { '@id': `${origin}/#organization` },
            mainEntity: {
                '@type': 'ItemList',
                numberOfItems: applications.length,
                itemListElement: applications.map((app, index) => ({
                    '@type': 'ListItem',
                    position: index + 1,
                    item: app,
                })),
            },
        },
        {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
                {
                    '@type': 'ListItem',
                    position: 1,
                    name: 'Home',
                    item: origin,
                },
                {
                    '@type': 'ListItem',
                    position: 2,
                    name: 'Apps',
                    item: appsUrl,
                },
            ],
        },
    ]
}
