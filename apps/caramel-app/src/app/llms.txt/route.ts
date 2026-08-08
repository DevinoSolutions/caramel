import {
    CHROME_WEB_STORE_URL,
    EDGE_ADDONS_URL,
    FIREFOX_ADDONS_URL,
    GITHUB_REPO_URL,
    SAFARI_APP_STORE_URL,
} from '@/lib/brandLinks'
import { BASE_URL } from '@/lib/env.client'

// Deliberately NOT a `withRoute` handler: withRoute owns the /api surface
// (CORS, rate limits, origin gates, zod bodies). This is a static public text
// asset in the same family as robots.ts and sitemap.ts — no request input, no
// auth, no DB. It lives as a route rather than a public/ file so the origin
// stays a single source of truth (env.client's BASE_URL).
const origin = BASE_URL.replace(/\/+$/, '')

const LLMS_TXT = `# Caramel

> Caramel is a free, open-source, privacy-first browser extension that finds and
> applies coupon codes automatically at checkout. It does not sell browsing data
> and does not overwrite creators' affiliate commissions.

## What it is

- A browser extension for Chrome, Firefox, Edge, and Safari.
- Free to use, with no paid tier and no account required to install.
- Open source under the DevinoSolutions organization: ${GITHUB_REPO_URL}
- Positioned as an alternative to Honey for shoppers who care about privacy and
  about not hijacking creator commissions.

## How it works

1. You shop normally; Caramel detects a supported store's checkout page.
2. It looks up known coupon codes for that store from its own catalog.
3. It tries the codes at checkout and keeps the one with the best discount.

## Key pages

- [Home](${origin}/): what Caramel is and how it works.
- [Pricing](${origin}/pricing): the plan structure — Caramel is free.
- [Coupons](${origin}/coupons): browse the full coupon catalog.
- [Store coupon pages](${origin}/coupons/amazon.com): per-store codes, one page
  per store domain, e.g. /coupons/amazon.com or /coupons/nike.com.
- [Supported stores](${origin}/supported-stores): which stores Caramel can
  auto-apply codes on.
- [Sources](${origin}/sources): the transparency page listing where Caramel's
  coupon codes come from.
- [Privacy policy](${origin}/privacy): what data Caramel does and does not
  collect.

## Install

- Chrome Web Store: ${CHROME_WEB_STORE_URL}
- Firefox Add-ons: ${FIREFOX_ADDONS_URL}
- Microsoft Edge Add-ons: ${EDGE_ADDONS_URL}
- Safari (App Store): ${SAFARI_APP_STORE_URL}
`

export function GET(): Response {
    return new Response(LLMS_TXT, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
        },
    })
}
