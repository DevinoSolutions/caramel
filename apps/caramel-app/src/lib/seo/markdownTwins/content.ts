import { discountBadgeText, isRecentlyFailing } from '@/lib/coupons'
import { formatFailedAgo, formatWorkedAgo } from '@/lib/relativeTime'
import type { Coupon } from '@/types/coupon'

export type MarkdownPageContent = {
    title: string
    summary: string
    body: string
}

/** Catalog text is plain text, never Markdown supplied by a merchant. */
export function markdownText(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/([\\`*_{}[\]()#+.!|~-])/g, '\\$1')
        .replace(/\r?\n/g, ' ')
}

export function markdownLink(label: string, url: string): string {
    return `[${markdownText(label)}](${url})`
}

/** The same discount and trust labels the public CouponCard renders. */
export function couponMarkdown(
    coupon: Pick<
        Coupon,
        | 'code'
        | 'title'
        | 'description'
        | 'discount_type'
        | 'discount_amount'
        | 'lastWorkedAt'
        | 'lastFailedAt'
        | 'failCount'
    >,
): string {
    const discount = discountBadgeText(
        coupon.discount_type,
        coupon.discount_amount,
    )
    const failing = isRecentlyFailing(coupon)
    const worked = formatWorkedAgo(failing ? null : coupon.lastWorkedAt)
    const failed = failing ? formatFailedAgo(coupon.lastFailedAt) : null
    return [
        `### ${markdownText(coupon.title)}`,
        `Code: ${markdownText(coupon.code)}`,
        discount ? `${markdownText(discount)} off` : 'DEAL',
        coupon.description ? markdownText(coupon.description) : '',
        worked ?? failed ?? '',
    ]
        .filter(Boolean)
        .join('\n\n')
}
