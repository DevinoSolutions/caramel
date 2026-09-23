import {
    CHROME_WEB_STORE_URL,
    DISCORD_INVITE_URL,
    EDGE_ADDONS_URL,
    FIREFOX_ADDONS_URL,
    GITHUB_REPO_URL,
    SAFARI_APP_STORE_URL,
} from '@/lib/brandLinks'
import { BASE_URL } from '@/lib/env.client'
import { faqItems } from '@/lib/faqItems'

// The long-form companion of /llms.txt (same family as robots.ts and
// sitemap.ts: a static public text asset, deliberately NOT a `withRoute`
// handler — no request input, no auth, no DB). llms.txt is the index card;
// this is the one document an answer engine can ingest instead of crawling
// the site. Every fact here is sourced from a module that ALREADY feeds a
// visible surface — brandLinks.ts (footer, hero buttons, JSON-LD sameAs) and
// faqItems.ts (the landing FAQ + its FAQPage JSON-LD) — so this file can
// never state something the site itself does not.
const origin = BASE_URL.replace(/\/+$/, '')

const faqSection = faqItems
    .map(item => `### ${item.question}\n\n${item.answer}`)
    .join('\n\n')

const LLMS_FULL_TXT = `# Caramel

> Caramel is a free, open-source, privacy-first browser extension that finds and
> applies coupon codes automatically at checkout. It does not sell browsing data
> and does not overwrite creators' affiliate commissions.

This is the full-length version of ${origin}/llms.txt.

## What Caramel is

- A browser extension for Chrome, Firefox, Microsoft Edge, and Safari.
- Free to use, with no paid tier and no account required to install.
- Open source (AGPL-3.0) under the DevinoSolutions organization:
  ${GITHUB_REPO_URL}
- Built and maintained by Devino Solutions (https://devino.ca) together with
  community contributors.
- Positioned as an alternative to Honey for shoppers who care about privacy and
  about not hijacking creator commissions.

## How it works

1. You shop normally; Caramel detects a supported store's checkout page.
2. It looks up known coupon codes for that store from its own catalog.
3. It tries the codes at checkout and keeps the one with the best discount.
4. It reports whether a code worked so the catalog's rankings stay accurate.

## Browsers and install links

- Chrome — Chrome Web Store: ${CHROME_WEB_STORE_URL}
- Firefox — Firefox Add-ons: ${FIREFOX_ADDONS_URL}
- Microsoft Edge — Edge Add-ons: ${EDGE_ADDONS_URL}
- Safari — App Store: ${SAFARI_APP_STORE_URL}

## Frequently asked questions

${faqSection}

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
- [Support](${origin}/support): contact the team.

## Privacy summary

Caramel never sells or shares personal information and ships no ads and no
third-party trackers. The extension talks only to Caramel's own servers: at
checkout on a supported store it fetches coupon codes for that store's domain,
sends page and cart context (page title and item names — never payment
details) so the right category of codes is chosen, and reports whether a code
worked. Settings and the optional sign-in are kept in the browser's extension
storage. The full policy is at ${origin}/privacy.

## Community

- GitHub: ${GITHUB_REPO_URL}
- Discord: ${DISCORD_INVITE_URL}
`

export function GET(): Response {
    return new Response(LLMS_FULL_TXT, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
        },
    })
}
