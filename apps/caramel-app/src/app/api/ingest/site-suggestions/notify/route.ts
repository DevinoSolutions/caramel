import { withRoute } from '@/lib/api/withRoute'
import {
    notifySupportedRequesters,
    SiteSuggestionNotifyBodySchema,
} from '@/lib/siteSuggestions'
import { NextResponse } from 'next/server'

// POST /api/ingest/site-suggestions/notify — the OWNER'S SEND.
//
// The product rule this route exists for: nothing emails a person who asked for
// a store until somebody decides to. The ack endpoint only MARKS a row
// `supported`; this is the deliberate act that turns a mark into mail, and it
// works whether or not SITE_SUGGESTIONS_AUTO_NOTIFY is on — the switch decides
// whether the ACK may send on its own, never whether the owner may.
//
// Same `ingest` bearer as its siblings: the operator drives it with the same
// credential (the exact curl is printed in the ops notice every `supported` ack
// sends, with the pending ids already filled in).
//
// Cross-repo contract:
//   body { ids: string[] }
//   200  {
//          ok: true,
//          sent: n, alreadyNotified: n, notEligible: n, failed: n,
//          results: [{ id, outcome, reason? }]
//                   outcome: sent | already_notified | not_eligible | failed
//        }
//   401 without the bearer; 422 on a bad body.
//
// Eligible = the row is `supported`, carries a requester email, and has never
// been notified. Everything else is REPORTED with a reason rather than quietly
// skipped, so "nothing happened" can always be told apart from "nothing needed
// to happen".
//
// IDEMPOTENT by claim, not by check: `notified_at` is stamped before the mail
// goes out, so a second call — or two concurrent ones — cannot re-send. One
// mail per requester email per domain, however many times that person suggested
// the store; the duplicate rows are stamped alongside the one that was mailed.
// A send that FAILS releases its claim and is reported `failed`, so the notice
// stays pending and this same command retries it.
export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'ingest/site-suggestions/notify',
        apiKey: 'ingest',
        body: SiteSuggestionNotifyBodySchema,
    },
    async ({ body }) => {
        const summary = await notifySupportedRequesters(body.ids)
        return NextResponse.json({ ok: true, ...summary })
    },
)
