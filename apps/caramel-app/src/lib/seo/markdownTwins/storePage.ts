import { attachSignals } from '@/lib/couponSignals'
import { listStoreCoupons } from '@/lib/couponsRepo'
import { buildStoreFaq } from '@/lib/seo/storeFaq'
import { evaluateStorePageIndexability } from '@/lib/seo/storeIndexability'
import { storeDisplayName } from '@/lib/seo/storeMetadata'
import { isUkStoreDomain, resolveStoreDomain } from '@/lib/storeDomain'
import {
    couponMarkdown,
    markdownLink,
    markdownText,
    type MarkdownPageContent,
} from './content'
import { MARKDOWN_ORIGIN } from './registry.mjs'

type StoreMarkdown = MarkdownPageContent & { canonicalPath: string }
type StoreDependencies = {
    listStoreCoupons: typeof listStoreCoupons
    attachSignals: typeof attachSignals
}

/**
 * Created inside each twin request: one catalog read shared by the policy,
 * codes and FAQ, just like the HTML page's request-scoped React cache.
 * No cross-request cache/ISR: store HTML also has no revalidate window.
 */
export function createStoreMarkdownBuilder(
    dependencies: StoreDependencies = { listStoreCoupons, attachSignals },
): (store: string) => Promise<StoreMarkdown | null> {
    const requests = new Map<string, Promise<StoreMarkdown | null>>()
    return store => {
        const base = resolveStoreDomain(store)
        if (!base) return Promise.resolve(null)
        const existing = requests.get(base)
        if (existing) return existing
        const pending = buildStore(base, dependencies)
        requests.set(base, pending)
        return pending
    }
}

async function buildStore(
    base: string,
    dependencies: StoreDependencies,
): Promise<StoreMarkdown | null> {
    // Same limit and repository visibility predicate as the frozen HTML page.
    const { coupons, total, facts } = await dependencies.listStoreCoupons(
        base,
        20,
    )
    if (
        !evaluateStorePageIndexability({ base, visibleCouponCount: total })
            .indexable
    ) {
        return null
    }
    const withSignals = await dependencies.attachSignals(coupons)
    const seen = new Set<string>()
    const visible = withSignals.filter(coupon => {
        if (seen.has(coupon.id)) return false
        seen.add(coupon.id)
        return !coupon.keepsFailing
    })
    const first = visible[0]
    const faq = buildStoreFaq({
        base,
        total,
        facts,
        topCoupon: first ? { title: first.title, code: first.code } : null,
        uk: isUkStoreDomain(base),
    })
    const canonicalPath = `/coupons/${encodeURIComponent(base)}`
    return {
        canonicalPath,
        title: storeDisplayName(base),
        summary: faq[1]?.answer ?? '',
        body: [
            ...visible.map(couponMarkdown),
            ...faq.map(
                item =>
                    `## ${markdownText(item.question)}\n\n${markdownText(item.answer)}`,
            ),
            markdownLink(
                storeDisplayName(base),
                `${MARKDOWN_ORIGIN}${canonicalPath}`,
            ),
            markdownLink('Get the extension', `${MARKDOWN_ORIGIN}/apps`),
        ].join('\n\n'),
    }
}
