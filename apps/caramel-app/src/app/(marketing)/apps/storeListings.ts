// src/app/(marketing)/apps/storeListings.ts
//
// The four browser builds' copy and official badges, in ONE place. The store
// URL is deliberately NOT here — it comes from Caramel's manifest entry
// (`src/lib/apps/caramelApp.ts`, the shared Devino contract), so a listing
// link lives in exactly one place and this file is the presentation layer
// over it. Copied from uNotes' `src/app/apps/storeListings.ts` and reshaped
// for browsers instead of operating systems.
import { CARAMEL_APP } from '@/lib/apps/caramelApp'
import {
    storeUrl,
    type DevinoApp,
    type DevinoStoreType,
} from '@/lib/apps/devinoAppsManifest'
import type { BrowserFamily } from '@/lib/surface/detectPlatform'

/**
 * The official store badge for a listing. Every asset under
 * `public/store-badges/` is the store owner's own artwork, unmodified —
 * sources and quoted terms in `public/store-badges/LICENSE-NOTES.md`. The
 * rendered size is a HEIGHT only (width stays `auto`).
 */
export type StoreBadge = {
    /** Public path to the unmodified official asset. */
    src: string
    /** Intrinsic artwork size, so the browser reserves the box (no CLS). */
    width: number
    height: number
    /** Tailwind height class — a literal so Tailwind's scanner emits it. */
    heightClass: string
    /** Accessible name for the link: says WHICH app, not just which store. */
    accessibleName: string
}

/** The browsers Caramel ships a build for. */
export type StorePlatform = Exclude<BrowserFamily, 'other'>

type StorePresentation = {
    platform: StorePlatform
    /** Which entry in the manifest's `stores` array holds this listing. */
    manifestStore: DevinoStoreType
    storeName: string
    /** The browser a shopper would call this build, for the card heading. */
    browserLabel: string
    /** schema.org operatingSystem value — the browser, for an extension. */
    operatingSystem: string
    label: string
    /** Shown on the highlighted card instead of the generic label. */
    matchedLabel: string
    badge: StoreBadge
    /** Adds this store's campaign attribution to the canonical listing URL. */
    withCampaign: (canonicalUrl: string) => string
}

/** `?` or `&`, depending on what the canonical URL already carries. */
const appendQuery = (url: string, query: string): string =>
    `${url}${url.includes('?') ? '&' : '?'}${query}`

const UTM = 'utm_source=grabcaramel.com&utm_medium=apps_page'

/**
 * ORDER IS LOAD-BEARING. Apple's marketing guidelines require the App Store
 * badge to be first whenever other platforms' badges share the layout, so
 * Safari leads the declared order. The page hoists the visitor's own browser
 * above the rest — a per-visitor reordering, not a change to the lineup.
 */
const STORE_PRESENTATIONS: readonly StorePresentation[] = [
    {
        platform: 'safari',
        manifestStore: 'macos',
        storeName: 'App Store',
        browserLabel: 'Safari',
        operatingSystem: 'Safari',
        label: 'Download on the App Store (Safari)',
        matchedLabel: 'Download for your Safari',
        badge: {
            src: '/store-badges/apple-app-store-black-en-us.svg',
            width: 120,
            height: 40,
            heightClass: 'h-11',
            accessibleName: 'Download Caramel for Safari on the App Store',
        },
        // ct = campaign token, mt = media type (12 = Mac App Store)
        withCampaign: url => appendQuery(url, 'ct=caramel_website&mt=12'),
    },
    {
        platform: 'chrome',
        manifestStore: 'chrome',
        storeName: 'Chrome Web Store',
        browserLabel: 'Chrome',
        operatingSystem: 'Chrome',
        label: 'Available in the Chrome Web Store',
        matchedLabel: 'Add it to your Chrome',
        badge: {
            src: '/store-badges/chrome-web-store-border-large.png',
            width: 496,
            height: 150,
            heightClass: 'h-11',
            accessibleName: 'Get Caramel from the Chrome Web Store',
        },
        withCampaign: url => appendQuery(url, UTM),
    },
    {
        platform: 'firefox',
        manifestStore: 'firefox',
        storeName: 'Firefox Add-ons',
        browserLabel: 'Firefox',
        operatingSystem: 'Firefox',
        label: 'Get the Add-on (Firefox)',
        matchedLabel: 'Add it to your Firefox',
        badge: {
            src: '/store-badges/firefox-get-the-addon.svg',
            width: 172,
            height: 60,
            heightClass: 'h-11',
            accessibleName: 'Get Caramel from Firefox Add-ons',
        },
        withCampaign: url => appendQuery(url, UTM),
    },
    {
        platform: 'edge',
        manifestStore: 'edge',
        storeName: 'Microsoft Edge Add-ons',
        browserLabel: 'Microsoft Edge',
        operatingSystem: 'Microsoft Edge',
        label: 'Get it from Microsoft Edge',
        matchedLabel: 'Add it to your Edge',
        badge: {
            src: '/store-badges/microsoft-edge-add-ons-en.png',
            width: 1178,
            height: 312,
            heightClass: 'h-11',
            accessibleName: 'Get Caramel from Microsoft Edge Add-ons',
        },
        withCampaign: url => appendQuery(url, UTM),
    },
]

/** A store Caramel is live on: the badge is a real link. */
export type AppStoreListing = {
    status: 'listed'
    platform: StorePlatform
    /** What a human clicks — carries the campaign params. */
    href: string
    /** Same listing without campaign params, for structured data. */
    canonicalHref: string
    storeName: string
    browserLabel: string
    operatingSystem: string
    label: string
    matchedLabel: string
    badge: StoreBadge
}

/**
 * A store Caramel is NOT live on: the manifest carries no URL for it, so the
 * badge renders greyed and non-clickable with a visible "Coming soon" label.
 * Deliberately has NO `href` field at all, so nothing can spread an empty
 * string into an anchor and the structured data filters on the discriminant.
 */
export type ComingSoonStoreListing = {
    status: 'coming-soon'
    platform: StorePlatform
    storeName: string
    browserLabel: string
    operatingSystem: string
    label: string
    comingSoonLabel: string
    badge: StoreBadge
}

export type StoreCard = AppStoreListing | ComingSoonStoreListing

/**
 * Resolve every browser build against a manifest entry. PURE and exported so
 * tests can hand it an app whose `stores` array is missing a store — the
 * negative control for the coming-soon path, which the real Caramel entry
 * (live on all four) never exercises.
 */
export function buildStoreCards(app: DevinoApp): readonly StoreCard[] {
    return STORE_PRESENTATIONS.map(presentation => {
        const canonicalHref = storeUrl(app, presentation.manifestStore)
        const {
            platform,
            storeName,
            browserLabel,
            operatingSystem,
            label,
            matchedLabel,
            badge,
        } = presentation

        if (canonicalHref === null) {
            return {
                status: 'coming-soon',
                platform,
                storeName,
                browserLabel,
                operatingSystem,
                label,
                comingSoonLabel: `Coming soon to ${storeName}`,
                badge,
            }
        }

        return {
            status: 'listed',
            platform,
            href: presentation.withCampaign(canonicalHref),
            canonicalHref,
            storeName,
            browserLabel,
            operatingSystem,
            label,
            matchedLabel,
            badge,
        }
    })
}

/** Every browser build, listed or not — what the /apps page renders. */
export const STORE_CARDS: readonly StoreCard[] = buildStoreCards(CARAMEL_APP)

export const isListedStore = (card: StoreCard): card is AppStoreListing =>
    card.status === 'listed'

/**
 * The builds Caramel is actually live on: what the JSON-LD advertises and
 * what `store_badge_click` can name. A store we are not on yet is neither
 * downloadable nor clickable, so it belongs in neither.
 */
export const STORE_LISTINGS: readonly AppStoreListing[] =
    STORE_CARDS.filter(isListedStore)

/** The listing for the visitor's own browser, if Caramel is live there. */
export function listingForBrowser(
    browser: BrowserFamily,
): AppStoreListing | null {
    return STORE_LISTINGS.find(listing => listing.platform === browser) ?? null
}

export const STORE_TRADEMARK_NOTICE =
    'Apple, the Apple logo and App Store are trademarks of Apple Inc. Chrome and the Chrome Web Store badge are trademarks of Google LLC. Firefox is a trademark of the Mozilla Foundation. Microsoft Edge is a trademark of the Microsoft group of companies.'
