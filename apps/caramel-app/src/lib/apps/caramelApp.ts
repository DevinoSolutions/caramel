// src/lib/apps/caramelApp.ts
//
// Caramel's OWN entry in the shared Devino manifest vocabulary.
//
// TODO(2026-09-22): the producer (devino-landing-page `data/apps.ts`, served
// as https://devino.ca/devino-apps.json) does not list Caramel yet. Until it
// does, this is the one place Caramel describes itself in that contract; the
// store URLs are the canonical ones from `brandLinks.ts` so they can never
// drift from the footer, llms.txt and the root JSON-LD. Once the producer
// carries a `caramel` entry, replace this object with a lookup in
// `DEVINO_APPS_MANIFEST.apps` and delete the literal — the test
// (`tests/unit/devino-apps-manifest.test.ts`) that parses it through the
// shared schema is the contract either way.
//
// AUDIENCES. The fixed vocabulary has no "shoppers" bucket; `students` is the
// closest match for a free coupon extension (budget-first, browser-native)
// and is what the cross-app rule matches on.
//
// STORES. Every listing is live under the Devino developer accounts
// (2026-09-22), so all four appear. Safari ships through Apple's App Store
// and the producer has no `safari` type, so it rides on `macos` (the Mac App
// Store); `storeListings.ts` maps it back to the Safari card.
import {
    CHROME_WEB_STORE_URL,
    EDGE_ADDONS_URL,
    FIREFOX_ADDONS_URL,
    SAFARI_APP_STORE_URL,
} from '@/lib/brandLinks'
import { parseDevinoApp, type DevinoApp } from './devinoAppsManifest'

export const CARAMEL_APP: DevinoApp = parseDevinoApp({
    id: 'caramel',
    name: 'Caramel',
    tagline:
        'Free, open-source coupon extension that applies codes at checkout without selling your data.',
    url: 'https://grabcaramel.com',
    icon: 'https://devino.ca/app-icons/caramel.png',
    stores: [
        { type: 'chrome', url: CHROME_WEB_STORE_URL },
        { type: 'firefox', url: FIREFOX_ADDONS_URL },
        { type: 'edge', url: EDGE_ADDONS_URL },
        { type: 'macos', url: SAFARI_APP_STORE_URL },
    ],
    audiences: ['students'],
    // No MCP server: the extension's only LLM surface is the internal cart
    // classifier. The /apps AI section is gated on this flag.
    mcp: false,
})
