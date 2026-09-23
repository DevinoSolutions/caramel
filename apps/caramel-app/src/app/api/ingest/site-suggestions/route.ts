import { withRoute } from '@/lib/api/withRoute'
import {
    listSiteSuggestions,
    SiteSuggestionListQuerySchema,
} from '@/lib/siteSuggestions'
import { NextResponse } from 'next/server'

// GET /api/ingest/site-suggestions?status=new&since=<iso>&limit=<n>
//
// The coupons pipeline's READ door onto user-requested stores — the sibling of
// POST /api/ingest/catalog (its write door), same bearer (INGEST_API_KEY via
// withRoute's apiKey:'ingest', constant-time, fail-closed when unset), same
// server-to-server posture: NO CORS, NO OPTIONS, NO rate limit. The pipeline
// drains `status=new` rows, imports the domains, then confirms through
// POST /api/ingest/site-suggestions/ack, which is what moves them off this list.
//
// Cross-repo contract (consumed verbatim by caramel-coupons):
//   200 { suggestions: [{ id, domain, rawUrl, requesterEmail, source, createdAt, status }] }
//   `requesterEmail` is null for an anonymous request; `createdAt` is ISO 8601;
//   rows come oldest-first. 401 without the bearer; 422 on a bad query.
export const GET = withRoute(
    {
        method: 'GET',
        routeName: 'ingest/site-suggestions',
        apiKey: 'ingest',
    },
    async ({ req }) => {
        const params = new URL(req.url).searchParams
        const parsed = SiteSuggestionListQuerySchema.safeParse({
            status: params.get('status') ?? undefined,
            since: params.get('since') ?? undefined,
            limit: params.get('limit') ?? undefined,
        })
        if (!parsed.success) {
            return NextResponse.json(
                { error: 'Invalid query' },
                { status: 422 },
            )
        }
        const suggestions = await listSiteSuggestions(parsed.data)
        return NextResponse.json({ suggestions })
    },
)
