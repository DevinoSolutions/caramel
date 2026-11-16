// src/lib/mcp/tools/coupons.ts
//
// Coupon and store tools: the public catalog every shopper sees on
// grabcaramel.com and in the extension, plus the signed-in contributions
// (submit a code, report whether one worked, ask for a store). Each tool runs
// the same API route the website calls (routeBridge.ts), except the store page
// read, which uses the same repository call the store page renders from.
import { POST as couponReportPost } from '@/app/api/coupons/[id]/report/route'
import { GET as couponFiltersGet } from '@/app/api/coupons/filters/route'
import { GET as recentlyWorkedGet } from '@/app/api/coupons/recently-worked/route'
import { GET as couponsGet } from '@/app/api/coupons/route'
import { GET as couponStatsGet } from '@/app/api/coupons/stats/route'
import { GET as couponStoresGet } from '@/app/api/coupons/stores/route'
import { POST as couponSubmitPost } from '@/app/api/coupons/submit/route'
import { POST as searchSupportedPost } from '@/app/api/sites/search-supported/route'
import { POST as siteSuggestPost } from '@/app/api/sites/suggest/route'
import { GET as topSitesGet } from '@/app/api/sites/top-sites/route'
import { GET as sourcesGet, POST as sourcesPost } from '@/app/api/sources/route'
import { attachSignals } from '@/lib/couponSignals'
import { getVisibleCoupon, listStoreCoupons } from '@/lib/couponsRepo'
import { BASE_URL } from '@/lib/env.client'
import { McpDenialError } from '@/lib/mcp/denial'
import { callRouteOk } from '@/lib/mcp/routeBridge'
import { resolveStoreDomain } from '@/lib/storeDomain'
import { z } from 'zod'
import { defineTool, IDEMPOTENT_WRITE, READ, WRITE } from './defineTool'

const origin = BASE_URL.replace(/\/+$/, '')

const storeArg = z
    .string()
    .trim()
    .min(1)
    .max(253)
    .describe(
        'The store as a domain or web address, e.g. "nike.com" or "https://www.nike.com/cart".',
    )

const couponIdArg = z
    .string()
    .regex(/^\d{1,18}$/, 'a coupon id is digits only')
    .describe(
        'A coupon id, as returned by search_coupons, get_store_deals or list_recently_worked_coupons.',
    )

function storeDomainOrRefuse(store: string): string {
    const domain = resolveStoreDomain(store)
    if (!domain) {
        throw new McpDenialError({
            code: 'VALIDATION_ERROR',
            details: `store: "${store}" is not a store domain (e.g. nike.com).`,
        })
    }
    return domain
}

/** The public page for a store's codes, for the user to open. */
function storePageUrl(domain: string): string {
    return `${origin}/coupons/${encodeURIComponent(domain)}`
}

export const searchCoupons = defineTool({
    id: 'search_coupons',
    title: 'Search Coupons',
    description:
        'Search Caramel\'s coupon catalog by store, keyword or discount type. Returns codes ranked best first with their trust signals (lastWorkedAt, recentlyFailing). Use get_store_deals for "best codes for one store".',
    tier: 'read',
    annotations: READ,
    covers: ['GET /api/coupons'],
    inputSchema: z.object({
        store: storeArg.optional(),
        query: z
            .string()
            .trim()
            .max(100)
            .optional()
            .describe(
                'Free text matched against the store, title, description and code.',
            ),
        keywords: z
            .array(z.string().trim().min(1).max(40))
            .max(10)
            .optional()
            .describe(
                'Words that must appear in the description, e.g. ["shipping"].',
            ),
        discountType: z
            .string()
            .trim()
            .max(30)
            .optional()
            .describe(
                'Only codes of this discount type, e.g. "PERCENTAGE" (get_catalog_overview lists them).',
            ),
        page: z.number().int().min(1).max(500).optional(),
        limit: z.number().int().min(1).max(50).optional(),
    }),
    run: async (args, { principal }) => {
        const site = args.store ? storeDomainOrRefuse(args.store) : undefined
        return callRouteOk<{
            coupons: unknown[]
            page: number
            limit: number
            total: number
            hasMore: boolean
        }>(principal.session, {
            handler: couponsGet,
            method: 'GET',
            path: '/api/coupons',
            query: {
                site,
                search: args.query,
                key_words: args.keywords?.join(','),
                type: args.discountType,
                page: args.page,
                limit: args.limit ?? 10,
            },
        })
    },
})

export const getStoreDeals = defineTool({
    id: 'get_store_deals',
    title: 'Get Store Deals',
    description:
        "The best coupon codes for one store, ranked exactly as the store's Caramel page ranks them (codes that worked recently first, failing codes last), with facts such as the best percent-off and the page address.",
    tier: 'read',
    annotations: READ,
    covers: ['PAGE /coupons/[store]'],
    inputSchema: z.object({
        store: storeArg,
        limit: z.number().int().min(1).max(50).optional(),
    }),
    run: async args => {
        const domain = storeDomainOrRefuse(args.store)
        const { coupons, total, facts } = await listStoreCoupons(
            domain,
            args.limit ?? 10,
        )
        return {
            store: domain,
            storePage: storePageUrl(domain),
            total,
            facts: {
                percentOffCodes: facts.percentOffCodes,
                bestPercentOff: facts.bestPercentOff,
                fixedAmountCodes: facts.fixedAmountCodes,
                lastUpdated: facts.lastUpdated?.toISOString() ?? null,
            },
            coupons: await attachSignals(coupons),
        }
    },
})

export const getCoupon = defineTool({
    id: 'get_coupon',
    title: 'Get Coupon',
    description:
        'One coupon by id: its code, store, terms, expiry and trust signals.',
    tier: 'read',
    annotations: READ,
    covers: [],
    inputSchema: z.object({ couponId: couponIdArg }),
    run: async args => {
        const coupon = await getVisibleCoupon(args.couponId)
        if (!coupon) {
            throw new McpDenialError({
                code: 'NOT_FOUND',
                details: `No visible coupon has id ${args.couponId}.`,
                next: { tool: 'search_coupons', args: {} },
            })
        }
        const [withSignals] = await attachSignals([coupon])
        return {
            coupon: withSignals,
            storePage: storePageUrl(coupon.site),
        }
    },
})

export const searchStores = defineTool({
    id: 'search_stores',
    title: 'Search Stores',
    description:
        'Find stores by name or domain: the stores Caramel has codes for, and the stores where the Caramel extension can test codes at checkout automatically.',
    tier: 'read',
    annotations: READ,
    covers: ['GET /api/coupons/stores', 'POST /api/sites/search-supported'],
    inputSchema: z.object({
        query: z.string().trim().min(2).max(100),
        limit: z.number().int().min(1).max(50).optional(),
    }),
    run: async (args, { principal }) => {
        const [withCoupons, autoApply] = await Promise.all([
            callRouteOk<{ sites: string[] }>(principal.session, {
                handler: couponStoresGet,
                method: 'GET',
                path: '/api/coupons/stores',
                query: { q: args.query, limit: args.limit ?? 20 },
            }),
            callRouteOk<{ sites: string[] }>(principal.session, {
                handler: searchSupportedPost,
                method: 'POST',
                path: '/api/sites/search-supported',
                body: { query: args.query },
            }),
        ])
        return {
            storesWithCoupons: withCoupons.sites,
            storesWithCheckoutAutoApply: autoApply.sites,
        }
    },
})

export const listTopStores = defineTool({
    id: 'list_top_stores',
    title: 'List Top Stores',
    description: 'The stores with the most coupon codes on Caramel.',
    tier: 'read',
    annotations: READ,
    covers: ['GET /api/sites/top-sites'],
    inputSchema: z.object({}),
    run: async (_args, { principal }) =>
        callRouteOk<{ sites: string[] }>(principal.session, {
            handler: topSitesGet,
            method: 'GET',
            path: '/api/sites/top-sites',
        }),
})

export const listRecentlyWorkedCoupons = defineTool({
    id: 'list_recently_worked_coupons',
    title: 'List Recently Worked Coupons',
    description:
        'Codes that shoppers confirmed worked at checkout most recently, across all stores.',
    tier: 'read',
    annotations: READ,
    covers: ['GET /api/coupons/recently-worked'],
    inputSchema: z.object({}),
    run: async (_args, { principal }) =>
        callRouteOk<{ coupons: unknown[] }>(principal.session, {
            handler: recentlyWorkedGet,
            method: 'GET',
            path: '/api/coupons/recently-worked',
        }),
})

export const getCatalogOverview = defineTool({
    id: 'get_catalog_overview',
    title: 'Get Catalog Overview',
    description:
        'Caramel catalog totals (active and expired codes) and the discount types search_coupons can filter on.',
    tier: 'read',
    annotations: READ,
    covers: ['GET /api/coupons/stats', 'GET /api/coupons/filters'],
    inputSchema: z.object({}),
    run: async (_args, { principal }) => {
        const [stats, filters] = await Promise.all([
            callRouteOk<{ total: number; expired: number; active: number }>(
                principal.session,
                {
                    handler: couponStatsGet,
                    method: 'GET',
                    path: '/api/coupons/stats',
                },
            ),
            callRouteOk<{ discountTypes: string[] }>(principal.session, {
                handler: couponFiltersGet,
                method: 'GET',
                path: '/api/coupons/filters',
                query: { includeSites: false },
            }),
        ])
        return { ...stats, discountTypes: filters.discountTypes }
    },
})

export const listCouponSources = defineTool({
    id: 'list_coupon_sources',
    title: 'List Coupon Sources',
    description:
        'The websites Caramel collects coupon codes from, with how many codes each one supplies.',
    tier: 'read',
    annotations: READ,
    covers: ['GET /api/sources'],
    inputSchema: z.object({}),
    run: async (_args, { principal }) =>
        callRouteOk<unknown>(principal.session, {
            handler: sourcesGet,
            method: 'GET',
            path: '/api/sources',
        }),
})

const SUBMIT_ERRORS: Record<string, string> = {
    'invalid-code': 'code: that does not look like a coupon code.',
    'not-a-store': 'store: Caramel does not list that store.',
    'daily-limit':
        'You have submitted the most codes allowed today. Try again tomorrow.',
}

export const submitCoupon = defineTool({
    id: 'submit_coupon',
    title: 'Submit Coupon',
    description:
        'Add a coupon code the user found for a store, exactly like the "Submit a code" form. It is listed as unverified until shoppers confirm it works.',
    tier: 'write',
    annotations: WRITE,
    covers: ['POST /api/coupons/submit'],
    inputSchema: z.object({
        store: storeArg,
        code: z.string().trim().min(1).max(64),
    }),
    run: async (args, { principal }) => {
        try {
            return await callRouteOk<{
                couponId: string
                created: boolean
                status: string
            }>(principal.session, {
                handler: couponSubmitPost,
                method: 'POST',
                path: '/api/coupons/submit',
                body: { site: args.store, code: args.code, source: 'manual' },
            })
        } catch (error) {
            throw withKnownErrorText(error, SUBMIT_ERRORS)
        }
    },
})

export const reportCoupon = defineTool({
    id: 'report_coupon',
    title: 'Report Coupon',
    description:
        'Tell Caramel whether a code worked or failed for the user. Reports from signed-in shoppers move codes up or down for everyone.',
    tier: 'write',
    annotations: IDEMPOTENT_WRITE,
    covers: ['POST /api/coupons/[id]/report'],
    inputSchema: z.object({
        couponId: couponIdArg,
        outcome: z.enum(['worked', 'failed']),
        storeMessage: z
            .string()
            .trim()
            .max(200)
            .optional()
            .describe(
                'For a failed code: the message the store showed, if any.',
            ),
    }),
    run: async (args, { principal }) =>
        callRouteOk<{ ok: boolean; deduped?: boolean }>(principal.session, {
            handler: couponReportPost,
            method: 'POST',
            path: `/api/coupons/${args.couponId}/report`,
            body: {
                outcome: args.outcome,
                ...(args.storeMessage
                    ? { storeReason: args.storeMessage }
                    : {}),
            },
        }),
})

export const requestStore = defineTool({
    id: 'request_store',
    title: 'Request Store',
    description:
        'Ask Caramel to support a store it does not cover yet, like the "Suggest a store" form. The request is tied to the user so they can be told when it ships.',
    tier: 'write',
    annotations: IDEMPOTENT_WRITE,
    covers: ['POST /api/sites/suggest'],
    inputSchema: z.object({ store: storeArg }),
    run: async (args, { principal }) =>
        callRouteOk<{ ok: boolean; notified?: boolean }>(principal.session, {
            handler: siteSuggestPost,
            method: 'POST',
            path: '/api/sites/suggest',
            body: { url: args.store, source: 'web' },
        }),
})

export const requestCouponSource = defineTool({
    id: 'request_coupon_source',
    title: 'Request Coupon Source',
    description:
        'Ask Caramel to start collecting codes from a coupon website, like the request form on the Sources page.',
    tier: 'write',
    annotations: IDEMPOTENT_WRITE,
    covers: ['POST /api/sources'],
    inputSchema: z.object({
        website: z.string().trim().min(1).max(2048),
    }),
    run: async (args, { principal }) =>
        callRouteOk<unknown>(principal.session, {
            handler: sourcesPost,
            method: 'POST',
            path: '/api/sources',
            body: { website: args.website },
        }),
})

/** Swap a route's terse error code for a sentence, keeping the denial code. */
function withKnownErrorText(
    error: unknown,
    known: Record<string, string>,
): unknown {
    if (!(error instanceof McpDenialError)) return error
    const sentence = known[error.denial.details]
    return sentence
        ? new McpDenialError({ ...error.denial, details: sentence })
        : error
}
