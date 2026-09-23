// src/app/(marketing)/apps/appsAdvantages.ts
//
// Three reasons to install, per browser.
//
// THE RULE THAT MATTERS (copied from uNotes' appsAdvantages.ts): every line
// here is a capability that exists in THIS repo, and every line carries the
// file that proves it. A download page that promises something the extension
// does not do is worse than a bare one, because the shopper finds out at
// checkout.
//
// CHECKED AND DELIBERATELY NOT CLAIMED (2026-09-22 audit — do not "improve"
// the copy by adding these back):
//
// - CASHBACK / REWARDS. Caramel has none; its whole pitch is that it does not
//   monetise the shopper (PricingSection.tsx, "free forever").
// - PRICE HISTORY / PRICE DROP ALERTS. No such code path anywhere in
//   apps/caramel-extension.
// - FIREFOX FOR ANDROID. `wxt.config.ts` declares `gecko_android` (issue
//   #218) but the LIVE AMO listing is 1.4.1, built before that key existed,
//   so Firefox on Android is not offered the extension yet. Claim it only
//   after the next AMO release is verified live.
// - PUSH / PRICE NOTIFICATIONS. No web push, no notification permission.
// - "WORKS ON EVERY SITE". The extension needs `https://*/*` host access and
//   a store config; the honest number is the catalog count on the home page.
import type { StorePlatform } from './storeListings'

export type PlatformAdvantage = {
    text: string
    /** The file that proves the claim — for the next audit, not the page. */
    provenance: string
}

const AUTO_APPLY: PlatformAdvantage = {
    text: 'Tries every known code at checkout and keeps the one that saves you most.',
    provenance:
        'apps/caramel-extension/coupon-apply.js + coupon-runner.js (apply loop, best-total verdict)',
}

const TOOLBAR_COUNT: PlatformAdvantage = {
    text: 'Shows how many codes Caramel holds for the store you are on, right on the toolbar icon.',
    provenance:
        'apps/caramel-extension/background.js (toolbar badge, per-domain count; counts render even where badge styling is unsupported)',
}

const FIRST_PARTY_ONLY: PlatformAdvantage = {
    text: 'Talks only to grabcaramel.com — no third-party analytics or trackers inside the extension.',
    provenance:
        'apps/caramel-extension/wxt.config.ts (outbound audit 2026-08-13: the only server origin is the build-time baseUrl)',
}

const POPUP_SIGN_IN: PlatformAdvantage = {
    text: 'Sign in from the popup to sync your savings and starred stores to your Caramel account.',
    provenance:
        'apps/caramel-extension/wxt.config.ts (`identity` permission on non-Firefox builds) + background.js (favorite PUT/DELETE, savings sync)',
}

const FIREFOX_DISCLOSURE: PlatformAdvantage = {
    text: 'Every data practice is declared on the add-on listing, under Mozilla’s data-collection consent framework.',
    provenance:
        'apps/caramel-extension/wxt.config.ts (browser_specific_settings.gecko.data_collection_permissions, shipped since 1.4.0)',
}

export const PLATFORM_ADVANTAGES: Record<
    StorePlatform,
    readonly PlatformAdvantage[]
> = {
    chrome: [AUTO_APPLY, TOOLBAR_COUNT, POPUP_SIGN_IN],
    edge: [AUTO_APPLY, TOOLBAR_COUNT, POPUP_SIGN_IN],
    firefox: [AUTO_APPLY, TOOLBAR_COUNT, FIREFOX_DISCLOSURE],
    safari: [AUTO_APPLY, TOOLBAR_COUNT, FIRST_PARTY_ONLY],
}

/** The one line the page repeats above the cards, true on every browser. */
export const SHARED_ADVANTAGE: PlatformAdvantage = FIRST_PARTY_ONLY
