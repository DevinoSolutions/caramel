// src/lib/couponBoxSave.ts
//
// Saving an auto-detected coupon box as a store's config. When the extension
// finds a promo box itself on a store with no config, and a code typed into it
// works, the background posts the box to POST /api/extension/coupon-box-save.
// The box becomes that store's `store_configs` row, the same row and columns
// the pipeline's configs land in and GET /api/extension/supported-stores
// serves, so the next shopper's extension uses it as a config.
//
// The rules (the route applies them in this order):
//   - Off unless COUPON_BOX_SAVE_ENABLED (the extension reads it as
//     `couponBoxSave` on GET /api/extension/features).
//   - Selectors only, each inside the grammar in couponBoxSelector.ts, and an
//     apply or toggle selector never names a checkout, payment, order or
//     delete control. No codes, amounts, page text or anything about the
//     shopper is accepted: the body is refused whole if it carries more.
//   - The host must belong to a store the catalog knows (resolveSaveStoreName),
//     matched the way the extension matches a host to a config row.
//   - Never for a store with a served config (couponsRepo.hasServedStoreConfig)
//     and never over any existing row (insert-only).
//   - A pipeline config pushed later replaces the saved row whole
//     (applyCatalogRows).
import type { AutoDetectedStoreConfig } from '@/lib/catalog/applyCatalogRows'
import { couponBoxDomainSchema } from '@/lib/couponBoxPick'
import {
    isCouponBoxSelector,
    isRiskyControlSelector,
} from '@/lib/couponBoxSelector'
import { findCatalogStoreNames } from '@/lib/couponsRepo'
import { env } from '@/lib/env'
import { resolveStoreDomain } from '@/lib/storeDomain'
import { z } from 'zod'

export function couponBoxSaveEnabled(): boolean {
    return env.COUPON_BOX_SAVE_ENABLED
}

const selectorSchema = z.string().refine(isCouponBoxSelector, {
    error: 'not an accepted coupon box selector',
})

// The extension CLICKS these, so they may never name a control that places an
// order, pays or deletes something.
const clickedSelectorSchema = selectorSchema.refine(
    s => !isRiskyControlSelector(s),
    { error: 'names a checkout, payment, order or delete control' },
)

export const couponBoxSaveRequestSchema = z
    .object({
        // location.hostname of the page where the box worked.
        host: couponBoxDomainSchema,
        box: z
            .object({
                input: selectorSchema,
                // null: the box applies on Enter.
                apply: clickedSelectorSchema.nullable(),
                // The control that had to be opened to reveal the box, if any.
                toggle: clickedSelectorSchema.nullable(),
                // The order-total element the saving was read from. Required:
                // the next shopper's run measures the saving there, and a box
                // whose total cannot be read again cannot prove a code works.
                total: selectorSchema,
            })
            .strict(),
    })
    .strict()

export type CouponBoxSaveRequest = z.infer<typeof couponBoxSaveRequestSchema>

/** The saved box as store_configs columns. A box with no apply button stores
 * its input as the apply selector (the Enter-only convention the extension
 * reads). The other four selectors stay NULL. */
export function storeConfigFromBox(
    storeName: string,
    box: CouponBoxSaveRequest['box'],
): AutoDetectedStoreConfig {
    return {
        storeName,
        couponInputXpath: box.input,
        applyButtonXpath: box.apply ?? box.input,
        showInputXpath: box.toggle,
        priceContainerXpath: box.total,
    }
}

// The extension's hyphen-joined checkout prefixes (store-detect.js
// HYPHEN_CHECKOUT_PREFIXES: `secure-athleta.gap.com` is `athleta.gap.com`).
const HYPHEN_CHECKOUT_PREFIXES: ReadonlySet<string> = new Set([
    'secure',
    'checkout',
    'www',
    'shop',
    'store',
])
const SHOPIFY_HOST_SUFFIX = '.myshopify.com'

const withoutWww = (name: string) => name.replace(/^www\./, '')

/**
 * The store names whose config row the extension would apply on `host`
 * (store-detect.js _hostMatchesDomain), most of them only possibly known: the
 * host itself and each parent domain down to its registrable domain, the
 * store behind a hyphen checkout prefix (only when that store sits below its
 * registrable domain, as the extension requires), each also with `www.` in
 * front. For `<shop>.myshopify.com` the names are the host alone, plus
 * `shopLabel`: any known store whose first label is `<shop>`.
 */
export function storeNameCandidates(host: string): {
    names: string[]
    shopLabel: string | null
} {
    const out = new Set<string>()
    let shopLabel: string | null = null
    if (host.endsWith(SHOPIFY_HOST_SUFFIX)) {
        const shop = host.slice(0, -SHOPIFY_HOST_SUFFIX.length)
        if (shop && !shop.includes('.')) {
            shopLabel = shop
            out.add(host)
        }
    } else {
        const registrable = resolveStoreDomain(host)
        if (registrable && host.endsWith(registrable)) {
            const labels = host.split('.')
            const minLabels = registrable.split('.').length
            for (let i = 0; labels.length - i >= minLabels; i++) {
                out.add(labels.slice(i).join('.'))
            }
            const [first = ''] = labels
            const dash = first.indexOf('-')
            if (
                dash > 0 &&
                HYPHEN_CHECKOUT_PREFIXES.has(first.slice(0, dash))
            ) {
                const stripped = host.slice(dash + 1)
                if (
                    stripped !== registrable &&
                    resolveStoreDomain(stripped) === registrable
                ) {
                    out.add(stripped)
                }
            }
        }
    }
    for (const name of Array.from(out)) {
        if (!name.startsWith('www.')) out.add(`www.${name}`)
    }
    return { names: Array.from(out), shopLabel }
}

/**
 * Of the known store names found for a host, the one the save is filed
 * under, ranked the way the extension ranks config rows (getDomainRecord):
 * the most specific name wins (length without `www.`), a bare name beats its
 * `www.` twin, and a myshopify shop-label match counts only when no name
 * matched directly and exactly one store carries that label. Null when
 * nothing (or nothing unambiguous) matched.
 */
export function pickSaveStoreName(
    directNames: readonly string[],
    known: readonly string[],
): string | null {
    const direct = new Set(directNames)
    let best: string | null = null
    let bestRank = -1
    for (const name of known) {
        if (!direct.has(name)) continue
        const rank =
            withoutWww(name).length * 2 + (name.startsWith('www.') ? 0 : 1)
        if (rank > bestRank) {
            best = name
            bestRank = rank
        }
    }
    if (best) return best
    const byShopLabel = known.filter(name => !direct.has(name))
    return byShopLabel.length === 1 ? (byShopLabel[0] ?? null) : null
}

/** The catalog store a box found on `host` is saved under, or null when the
 * host belongs to no store Caramel knows. `host` is already validated
 * (couponBoxDomainSchema). */
export async function resolveSaveStoreName(
    host: string,
): Promise<string | null> {
    const { names, shopLabel } = storeNameCandidates(host)
    if (names.length === 0) return null
    const known = await findCatalogStoreNames(names, shopLabel)
    return pickSaveStoreName(names, known)
}
