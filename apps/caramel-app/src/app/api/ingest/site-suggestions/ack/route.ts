import { withRoute } from '@/lib/api/withRoute'
import {
    acknowledgeSiteSuggestions,
    SiteSuggestionAckBodySchema,
} from '@/lib/siteSuggestions'
import { NextResponse } from 'next/server'

// POST /api/ingest/site-suggestions/ack — the pipeline confirms it imported the
// suggestions it read from GET /api/ingest/site-suggestions, which flips them
// `new` -> `imported` (and stamps imported_at) so the next drain does not hand
// them over again. Same bearer + server-to-server posture as the GET.
//
// Cross-repo contract (consumed verbatim by caramel-coupons):
//   body     { ids: string[] }            (1..1000 ids from the GET)
//   200      { ok: true, acknowledged: n } n = rows that were `new` and flipped
//   Idempotent: an id already past `new` is untouched and not counted, so a
//   retried ack cannot drag a row backwards. 401 without the bearer; 422 on a
//   bad body.
export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'ingest/site-suggestions/ack',
        apiKey: 'ingest',
        body: SiteSuggestionAckBodySchema,
    },
    async ({ body }) => {
        const result = await acknowledgeSiteSuggestions(body.ids)
        return NextResponse.json({ ok: true, ...result })
    },
)
