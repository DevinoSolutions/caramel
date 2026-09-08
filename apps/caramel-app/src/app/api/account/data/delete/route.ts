import { withRoute } from '@/lib/api/withRoute'
import prisma from '@/lib/prisma'
import {
    SITE_SUGGESTION_SCRUB_DATA,
    siteSuggestionIdentityWhere,
} from '@/lib/siteSuggestionIdentity'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// POST /api/account/data/delete — the danger zone's "Delete my data".
//
// Removes the three login-features tables' rows for the caller: their synced
// savings history, the stores they follow, and the coupon reports they made.
// It also SCRUBS the caller's identity off their site suggestions — see below.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//  - It does NOT delete the account or the login. That is a larger job (Better
//    Auth session teardown, extension session revocation, an email
//    confirmation step) and is out of scope here. See the TODO in
//    DataPrivacySection.tsx.
//  - It does NOT delete site_suggestions rows, it SCRUBS them. The row's
//    identifying half (user_id, requester_email, user_agent) is nulled; the
//    domain and the status stay. A "please support this store" request is not
//    personal data once the requester is off it, and it is the pipeline's
//    input: deleting the row would silently retract a store request that other
//    people may also have made, and would corrupt a queue this user does not
//    own. Nothing new is stamped — a scrub is not an ANSWER to the request.
//  - It does NOT flip the savings-sync preference. Turning sync OFF and
//    DELETING history are two deliberately separate acts: a delete that also
//    changed a setting the user never touched would make the danger zone do
//    something it did not say it would.
//
// POST, never DELETE-with-no-body: this endpoint must not be reachable as a
// bare unauthenticated-intent request. The literal confirmation string is
// REQUIRED IN THE BODY and checked server-side, so the client-side
// type-to-confirm dialog is a second lock rather than the only one — a
// mis-issued request with no body is a 422 and destroys nothing.
const DELETE_CONFIRMATION = 'DELETE'

const DeleteDataBodySchema = z.object({
    // z.literal so withRoute's body gate 422s anything else BEFORE the handler
    // runs — the confirmation is enforced by the schema, not by a hand-written
    // if inside the handler that a later edit could drop.
    confirm: z.literal(DELETE_CONFIRMATION),
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'account/data-delete',
        rateLimit: 'mutation',
        origin: true,
        auth: 'session',
        body: DeleteDataBodySchema,
    },
    async ({ session }) => {
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const userId = session.user.id
        const email = session.user.email ?? null

        // Which rows identify this account, and what a scrub removes from them,
        // both come from src/lib/siteSuggestionIdentity.ts. GET
        // /api/account/overview counts rows with the SAME predicate so the
        // danger-zone button knows whether there is anything to do — two
        // hand-written copies would let the page say "Nothing to delete" about
        // rows this route would happily have scrubbed.
        //
        // ONE transaction. A partial delete is the worst outcome available
        // here: the user is told their data is gone while some of it remains,
        // and the counts the UI just showed them become a lie. If any of the
        // four fails, Prisma rolls the whole interactive batch back and
        // withRoute's catch turns it into a 500 + Sentry — nothing deleted,
        // and the failure toast ("Nothing was removed") is then true.
        //
        // The scrub belongs IN here for exactly that reason: run as a fourth
        // loose await after a successful transaction, a failure would leave the
        // three tables emptied and the email still sitting in site_suggestions,
        // with a 500 telling the user nothing had been removed.
        const [savingsEvents, favoriteStores, couponReports, siteSuggestions] =
            await prisma.$transaction([
                prisma.savingsEvent.deleteMany({ where: { userId } }),
                prisma.favoriteStore.deleteMany({ where: { userId } }),
                prisma.couponReport.deleteMany({ where: { userId } }),
                prisma.siteSuggestion.updateMany({
                    where: siteSuggestionIdentityWhere({ userId, email }),
                    data: SITE_SUGGESTION_SCRUB_DATA,
                }),
            ])

        return NextResponse.json({
            deleted: {
                savingsEvents: savingsEvents.count,
                favoriteStores: favoriteStores.count,
                couponReports: couponReports.count,
            },
            // Reported under its own key, never folded into `deleted`: these
            // rows still exist, and calling that a deletion would be a lie the
            // next reader of this response would believe.
            scrubbed: { siteSuggestions: siteSuggestions.count },
        })
    },
)
