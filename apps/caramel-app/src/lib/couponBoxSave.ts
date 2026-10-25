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
//   - A signed-in extension only (T-6221): the route's withRoute `auth:
//     'session'` takes the extension's bearer, so a forged Origin alone is 401.
//   - A save is a PROPOSAL, not a config (recordBoxProposal): the box becomes
//     the store's store_configs row, and so is served, only once
//     COUPON_BOX_SAVE_MIN_AGREEING_INSTALLS distinct users proposed the same
//     box for the same store. Until then nothing is served and nothing blocks
//     a different box from being corroborated later.
//   - A write budget (recordBoxProposal): per user, per store and across all
//     callers per 24 hours; over a cap the route answers 429.
//   - Selectors only, each inside the grammar in couponBoxSelector.ts, and an
//     apply or toggle selector must be NAMED for a coupon (namesCouponControl:
//     coupon, discount, promo, voucher, code, apply, redeem, reduction, gift in
//     its id, class or attributes) AND must not name a checkout, payment,
//     order or delete control or be able to submit a form
//     (isRiskyControlSelector): both gates, because a denylist alone passes
//     `button.btn`. No codes, amounts, page text or anything about the
//     shopper is accepted: the body is refused whole if it carries more.
//   - The host must belong to a store the catalog knows (resolveSaveStoreName),
//     matched the way the extension matches a host to a config row.
//   - Never for a store with a served config (couponsRepo.hasServedStoreConfig)
//     and never over any existing row (insert-only).
//   - A pipeline config pushed later replaces the saved row whole
//     (applyCatalogRows).
import {
    AUTO_DETECT_CONFIG_MAX_AGE_DAYS,
    insertAutoDetectedStoreConfig,
    type AutoDetectedStoreConfig,
} from '@/lib/catalog/applyCatalogRows'
import { couponBoxDomainSchema } from '@/lib/couponBoxPick'
import {
    isCouponBoxSelector,
    isRiskyControlSelector,
    namesCouponControl,
} from '@/lib/couponBoxSelector'
import { findCatalogStoreNames } from '@/lib/couponsRepo'
import { env } from '@/lib/env'
import prisma from '@/lib/prisma'
import { resolveStoreDomain } from '@/lib/storeDomain'
import * as Sentry from '@sentry/nextjs'
import { createHash } from 'node:crypto'
import { z } from 'zod'

export function couponBoxSaveEnabled(): boolean {
    return env.COUPON_BOX_SAVE_ENABLED
}

const selectorSchema = z.string().refine(isCouponBoxSelector, {
    error: 'not an accepted coupon box selector',
})

// The extension CLICKS these on other shoppers' browsers (T-6221), so two gates
// must both pass: the element must be named for a coupon (allowlist), and it
// may never name a control that places an order, pays, deletes something or
// can submit a form (denylist).
const clickedSelectorSchema = selectorSchema
    .refine(namesCouponControl, {
        error: 'does not name a coupon, promo, discount or code control',
    })
    .refine(s => !isRiskyControlSelector(s), {
        error: 'names a checkout, payment, order, delete or form-submit control',
    })

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

const DAY_MS = 24 * 60 * 60 * 1000
const PROPOSAL_WINDOW_MS = AUTO_DETECT_CONFIG_MAX_AGE_DAYS * DAY_MS

/** Which 24-hour write budget a refused proposal ran into. */
export type BoxBudgetScope = 'user' | 'store' | 'global'

export type BoxProposalOutcome =
    | { kind: 'over_budget'; scope: BoxBudgetScope }
    /** Recorded, not served: fewer than the required distinct users agree. */
    | { kind: 'pending'; agreeing: number; needed: number }
    /** Corroborated and written as the store's served config. */
    | { kind: 'published' }
    /** Corroborated, but the store already has a row (a racing or earlier save). */
    | { kind: 'has_config' }

/** The identity of a box for corroboration: a SHA-256 over the four stored
 * selectors (the Enter-only convention already applied, whitespace trimmed),
 * so two installs that found the same box agree whatever else they sent. */
export function boxHash(config: AutoDetectedStoreConfig): string {
    return createHash('sha256')
        .update(
            JSON.stringify([
                config.couponInputXpath.trim(),
                config.applyButtonXpath.trim(),
                config.showInputXpath?.trim() ?? null,
                config.priceContainerXpath?.trim() ?? null,
            ]),
        )
        .digest('hex')
}

// A sustained cap hit is ONE Sentry event per hour per process per cap kind,
// not one per request; the breadcrumb is every time.
const CAP_REPORT_INTERVAL_MS = 60 * 60 * 1000
const nextCapReportAt: Record<BoxBudgetScope, number> = {
    user: 0,
    store: 0,
    global: 0,
}

function reportCapHit(
    scope: BoxBudgetScope,
    cap: number,
    storeName: string,
): void {
    const message = `coupon-box-save ${scope} daily write cap reached`
    Sentry.addBreadcrumb({
        category: 'coupon-box-save',
        level: 'warning',
        message,
        data: { scope, cap, storeName },
    })
    const now = Date.now()
    if (now < nextCapReportAt[scope]) return
    nextCapReportAt[scope] = now + CAP_REPORT_INTERVAL_MS
    Sentry.captureMessage(message, {
        level: 'warning',
        tags: { route: 'extension/coupon-box-save', cap_scope: scope },
        extra: { cap, storeName },
    })
}

/**
 * Record one signed-in install's save of `box` for `storeName` and, once
 * COUPON_BOX_SAVE_MIN_AGREEING_INSTALLS distinct users proposed the same box
 * within AUTO_DETECT_CONFIG_MAX_AGE_DAYS, write it as the store's served
 * config (insertAutoDetectedStoreConfig). Until then NOTHING reaches
 * store_configs, so a forged or mistaken box is never served and a squatter
 * cannot hold a store against the box real installs agree on.
 *
 * The write budget counts proposals created in the last 24 hours: per user,
 * then per store, then in total. A user repeating a save they already made is
 * never refused by a cap and adds no row, but it RENEWS the row (created_at =
 * now), which is what lets the same users re-promote a box after its served
 * config has aged out (AUTO_DETECT_CONFIG_MAX_AGE_DAYS): without the renewal
 * their rows would fall out of the corroboration window and never agree again.
 * A renewed row counts in the 24-hour window like a new one. Over a cap nothing
 * is written, and each cap kind raises a throttled Sentry message. The caps are
 * read-then-write, so a burst of simultaneous requests can overshoot a cap by
 * the burst size; the caps bound growth, they are not a strict invariant.
 *
 * RESIDUAL RISK (T-6221): corroboration counts distinct ESTABLISHED accounts
 * (isEstablishedAccount, COUPON_TRUST_MIN_ACCOUNT_AGE_DAYS old), so an
 * attacker needs aged accounts — a fresh batch of signups cannot meet the
 * quorum. The selector gates and the on-page control guard limit what even
 * an aged-account attacker can click.
 */
export async function recordBoxProposal(args: {
    storeName: string
    host: string
    box: CouponBoxSaveRequest['box']
    userId: string
}): Promise<BoxProposalOutcome> {
    const { storeName, host, box, userId } = args
    const config = storeConfigFromBox(storeName, box)
    const hash = boxHash(config)
    const key = { storeName, boxHash: hash, userId }

    const already = await prisma.couponBoxProposal.findUnique({
        where: { storeName_boxHash_userId: key },
        select: { userId: true },
    })
    if (already) {
        // A repeat save renews the row (see above); it spends no budget.
        await prisma.couponBoxProposal.update({
            where: { storeName_boxHash_userId: key },
            data: { createdAt: new Date() },
        })
    } else {
        const since = new Date(Date.now() - DAY_MS)
        const [byUser, byStore, total] = await Promise.all([
            prisma.couponBoxProposal.count({
                where: { userId, createdAt: { gt: since } },
            }),
            prisma.couponBoxProposal.count({
                where: { storeName, createdAt: { gt: since } },
            }),
            prisma.couponBoxProposal.count({
                where: { createdAt: { gt: since } },
            }),
        ])
        const caps = [
            ['user', byUser, env.COUPON_BOX_SAVE_USER_DAILY_CAP],
            ['store', byStore, env.COUPON_BOX_SAVE_STORE_DAILY_CAP],
            ['global', total, env.COUPON_BOX_SAVE_GLOBAL_DAILY_CAP],
        ] as const
        for (const [scope, used, cap] of caps) {
            if (used >= cap) {
                reportCapHit(scope, cap, storeName)
                return { kind: 'over_budget', scope }
            }
        }
        await prisma.couponBoxProposal.createMany({
            data: [
                {
                    ...key,
                    host,
                    input: box.input,
                    apply: box.apply,
                    toggle: box.toggle,
                    total: box.total,
                },
            ],
            skipDuplicates: true,
        })
    }

    const needed = env.COUPON_BOX_SAVE_MIN_AGREEING_INSTALLS
    const establishedCutoff = new Date(
        Date.now() - env.COUPON_TRUST_MIN_ACCOUNT_AGE_DAYS * DAY_MS,
    )
    const agreeing = await prisma.couponBoxProposal.count({
        where: {
            storeName,
            boxHash: hash,
            createdAt: { gt: new Date(Date.now() - PROPOSAL_WINDOW_MS) },
            user: { createdAt: { lte: establishedCutoff } },
        },
    })
    if (agreeing < needed) return { kind: 'pending', agreeing, needed }

    const { inserted } = await insertAutoDetectedStoreConfig(config)
    return inserted ? { kind: 'published' } : { kind: 'has_config' }
}

/**
 * Delete proposals older than the promotion window. Rows past this age can
 * never count toward a quorum, so they are dead weight. Never rejects — a
 * failure is logged and captured to Sentry. Returns the count deleted (0 on
 * error) so callers can log at boot without try/catch.
 */
export async function sweepExpiredProposals(): Promise<number> {
    try {
        const cutoff = new Date(Date.now() - PROPOSAL_WINDOW_MS)
        const { count } = await prisma.couponBoxProposal.deleteMany({
            where: { createdAt: { lt: cutoff } },
        })
        return count
    } catch (error) {
        const { captureException } = await import('@sentry/nextjs')
        captureException(error, {
            tags: { area: 'couponBoxSave.sweepExpiredProposals' },
        })
        console.error('[couponBoxSave] proposal retention sweep failed', error)
        return 0
    }
}
