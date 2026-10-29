import { cachedActiveSources } from '@/lib/anonymousReadCaches'
import { consumeAnonymousWriteQuota } from '@/lib/anonymousWriteQuota'
import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { nextApiResponse } from '@/lib/apiResponseNext'
import { requestSource } from '@/lib/couponsRepo'
import { normalizeSuggestedDomain } from '@/lib/siteSuggestions'
import { toSourceMetrics } from '@/lib/sourceMetrics'
import * as Sentry from '@sentry/nextjs'
import { z } from 'zod'

// Strict on presence only (missing/empty `website` -> 422 — the flagged
// PLAN-F-007.md §Breaking change for this route, table row "POST
// strict(website)->422"). Deeper semantic validity (parses as a plausible
// domain, length <= 253) stays the route's own business logic below,
// returning its pre-existing custom 400 "Invalid website." — same split
// as extension/oauth's signed-state check: presence is a body-shape
// concern (the wrapper's job), plausibility is not.
//
// T-6225: `.max(2048)` bounds what an anonymous caller can make the route
// parse (a URL with megabytes of path/userinfo is not a store request); it
// answers 422 like any other shape violation.
const SourceCreateBodySchema = z.object({
    website: z.string().trim().min(1).max(2048),
})

// The page's toast reads `error`, so both go in the body.
const QUOTA_MESSAGE =
    'You have requested a lot of stores. Please try again later.'
const QUEUE_FULL_MESSAGE =
    'Too many store requests are waiting. Please try again later.'

export const GET = withRoute(
    { method: 'GET', routeName: 'sources', rateLimit: 'read' },
    async ({ req }) => {
        try {
            // Same mapper the /sources server component uses — see
            // lib/sourceMetrics.ts for why the two must never drift. The rows
            // come through the 5-minute in-process cache (T-6226): the
            // aggregate LEFT JOINs the whole coupons table and Cloudflare
            // reports this path DYNAMIC, so it was a Postgres scan per call.
            const sourcesWithMetrics = toSourceMetrics(
                await cachedActiveSources(),
            )

            return nextApiResponse(req, 200, 'sources', sourcesWithMetrics)
        } catch (error) {
            console.error('Error fetching sources:', error)
            return handleRouteError(error, {
                req,
                message: 'Error fetching sources.',
            })
        }
    },
)

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'sources',
        rateLimit: 'mutation',
        origin: true,
        body: SourceCreateBodySchema,
    },
    async ({ req, body }) => {
        try {
            // T-6225: the same normalizer /api/sites/suggest uses, so a host
            // that is not a store (no registrable domain under a real public
            // suffix, e.g. `zzz1.xx`) cannot be minted in bulk. What is stored
            // is the lowercased, www-less HOSTNAME, never the typed string
            // (path/query/userinfo are attacker bytes that ops would later
            // read as a store name).
            const host = normalizeSuggestedDomain(body.website)
            if (!host || host.length > 253) {
                return nextApiResponse(req, 400, 'Invalid website.', null)
            }

            // One address cannot fill the REQUESTED queue by itself.
            const quota = await consumeAnonymousWriteQuota(req, 'sources')
            if (!quota.allowed) {
                const res = nextApiResponse(
                    req,
                    429,
                    QUOTA_MESSAGE,
                    null,
                    QUOTA_MESSAGE,
                )
                res.headers.set('Retry-After', String(quota.retryAfterSec))
                return res
            }

            const outcome = await requestSource(host)
            if (outcome === 'queue_full') {
                // Said out loud: a full queue means ops must drain it (or it
                // is being abused), and every honest request now gets a 429.
                Sentry.captureMessage(
                    'sources REQUESTED queue is full; new store requests are refused',
                    {
                        level: 'warning',
                        tags: { operation: 'source_request_queue_full' },
                    },
                )
                return nextApiResponse(
                    req,
                    429,
                    QUEUE_FULL_MESSAGE,
                    null,
                    QUEUE_FULL_MESSAGE,
                )
            }
            // 'duplicate' answers exactly like 'created': the shopper's intent
            // (the store is on the list) holds either way, and a different
            // answer would let a caller probe which hosts were requested.
            return nextApiResponse(
                req,
                200,
                'Source submission requested successfully!',
            )
        } catch (error) {
            console.error('Error creating source:', error)
            return handleRouteError(error, {
                req,
                message: 'Error creating source.',
            })
        }
    },
)
