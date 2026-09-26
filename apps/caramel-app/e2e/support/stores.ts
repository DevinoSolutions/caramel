// e2e/support/stores.ts
//
// Pick a real store page from the site's own server-rendered links, never a
// hard-coded domain: the hermetic lane serves the synthetic seed, e2e-push and
// prod serve the real catalog, and any store named in a spec would be absent
// from one of them. Read-only, so it is deployment-safe.
import type { Page } from '@playwright/test'

const STORE_LINK = /^\/coupons\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/

/** The first store domain /supported-stores links to (e.g. "tradeinn.com"). */
export async function firstLinkedStoreDomain(page: Page): Promise<string> {
    await page.goto('/supported-stores')
    const hrefs = await page
        .locator('main a[href^="/coupons/"]')
        .evaluateAll(links => links.map(a => a.getAttribute('href') ?? ''))
    const site = hrefs
        .map(href => STORE_LINK.exec(href)?.[1])
        .find(match => match !== undefined)
    if (!site) {
        throw new Error('no store linked from /supported-stores')
    }
    return site
}
