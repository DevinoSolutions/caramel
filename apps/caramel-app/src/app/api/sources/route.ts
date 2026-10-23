import { cachedActiveSources } from '@/lib/anonymousReadCaches'
import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { nextApiResponse } from '@/lib/apiResponseNext'
import { requestSource } from '@/lib/couponsRepo'
import { toSourceMetrics } from '@/lib/sourceMetrics'
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
            const website = body.website
            // Validate it's a plausible domain/URL and bound the length, so this
            // public "request a store" endpoint can't be used to bulk-insert junk.
            let host: string
            try {
                host = new URL(
                    /^https?:\/\//i.test(website)
                        ? website
                        : `https://${website}`,
                ).hostname
            } catch {
                return nextApiResponse(req, 400, 'Invalid website.', null)
            }
            if (host.length > 253 || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
                return nextApiResponse(req, 400, 'Invalid website.', null)
            }

            // T-6225: what is stored is the validated, lowercased HOSTNAME,
            // never the typed string (path/query/userinfo are attacker bytes
            // that ops would later read as a store name).
            const outcome = await requestSource(
                host.toLowerCase().replace(/^www\./, ''),
            )
            if (outcome === 'queue_full') {
                return nextApiResponse(
                    req,
                    429,
                    QUEUE_FULL_MESSAGE,
                    null,
                    // The page's toast reads `error`, not `message`.
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
