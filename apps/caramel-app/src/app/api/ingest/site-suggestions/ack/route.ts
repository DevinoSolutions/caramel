import { withRoute } from '@/lib/api/withRoute'
import {
    SiteSuggestionAckBodySchema,
    transitionSiteSuggestions,
} from '@/lib/siteSuggestions'
import { NextResponse } from 'next/server'

// POST /api/ingest/site-suggestions/ack — how a suggestion is ANSWERED.
//
// Originally (PR #225) the one answer was "imported": the pipeline confirming
// it had taken the rows it read from GET /api/ingest/site-suggestions. That is
// still the default and still behaves identically, but a hand-over is not an
// answer to the person who asked — three more are:
//
//   rejected     the URL does not name a store; there is nothing to support
//   unsupported  we tried and cannot support it
//   supported    the store is live — the one the requester cares about
//
// Same bearer + server-to-server posture as the GET.
//
// Cross-repo contract (consumed verbatim by caramel-coupons):
//   body   { ids: string[], status?: 'imported'|'rejected'|'unsupported'|'supported' }
//          `status` absent = 'imported', so the existing `{ids}`-only caller is
//          untouched.
//   200    {
//            ok: true,
//            status,                  the status that was applied
//            acknowledged: n,         = changed.length (the legacy key, kept)
//            changed:  string[],      ids that really moved on THIS call
//            refused:  [{ id, from, reason }],
//                                     reason: not_found | already | backwards | raced
//            notified: { sent, pending, failed },
//            opsNotified: boolean|null
//          }
//   401 without the bearer; 422 on a bad body.
//
// The rule behind `refused`/`backwards`: a CLOSED row (rejected, unsupported,
// supported) can never be dragged back to `imported`. A re-drain of stale ids
// would otherwise re-open every store we had already decided about, and would
// send `supported` rows round the loop again to re-notify their requesters.
// Terminal-to-terminal IS allowed — `unsupported` becoming `supported` later is
// the ordinary happy path.
//
// NOTHING here mails a requester unless SITE_SUGGESTIONS_AUTO_NOTIFY is on
// (default OFF). With it off a `supported` ack only MARKS the rows and reports
// how many people are waiting; the send is an explicit act — POST
// /api/ingest/site-suggestions/notify.
export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'ingest/site-suggestions/ack',
        apiKey: 'ingest',
        body: SiteSuggestionAckBodySchema,
    },
    async ({ body }) => {
        const result = await transitionSiteSuggestions(body.ids, body.status)
        return NextResponse.json({
            ok: true,
            status: result.status,
            // The pre-#226 key, preserved: the count of rows that actually
            // moved. Dropping or redefining it would break the shipped
            // caramel-coupons caller for no gain.
            acknowledged: result.changed.length,
            changed: result.changed,
            refused: result.refused,
            notified: {
                sent: result.notifiedSent,
                pending: result.notifiedPending,
                failed: result.notifiedFailed,
            },
            opsNotified: result.opsNotified,
        })
    },
)
