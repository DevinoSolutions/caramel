import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { nextApiResponse } from '@/lib/apiResponseNext'
import { listActiveSources, requestSource } from '@/lib/couponsRepo'
import { toSourceMetrics } from '@/lib/sourceMetrics'
import { z } from 'zod'

// Strict on presence only (missing/empty `website` -> 422 — the flagged
// PLAN-F-007.md §Breaking change for this route, table row "POST
// strict(website)->422"). Deeper semantic validity (parses as a plausible
// domain, length <= 253) stays the route's own business logic below,
// returning its pre-existing custom 400 "Invalid website." — same split
// as extension/oauth's signed-state check: presence is a body-shape
// concern (the wrapper's job), plausibility is not.
const SourceCreateBodySchema = z.object({
    website: z.string().trim().min(1),
})

export const GET = withRoute(
    { method: 'GET', routeName: 'sources', rateLimit: 'read' },
    async ({ req }) => {
        try {
            // Same mapper the /sources server component uses — see
            // lib/sourceMetrics.ts for why the two must never drift.
            const sourcesWithMetrics = toSourceMetrics(
                await listActiveSources(),
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
            let host = website
            try {
                host = new URL(
                    website.startsWith('http') ? website : `https://${website}`,
                ).hostname
            } catch {
                return nextApiResponse(req, 400, 'Invalid website.', null)
            }
            if (host.length > 253 || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
                return nextApiResponse(req, 400, 'Invalid website.', null)
            }

            await requestSource(website)
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
