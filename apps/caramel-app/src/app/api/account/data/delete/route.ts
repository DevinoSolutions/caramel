import { withRoute } from '@/lib/api/withRoute'
import prisma from '@/lib/prisma'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// POST /api/account/data/delete — the danger zone's "Delete my data".
//
// Removes the three login-features tables' rows for the caller: their synced
// savings history, the stores they follow, and the coupon reports they made.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//  - It does NOT delete the account or the login. That is a larger job (Better
//    Auth session teardown, extension session revocation, an email
//    confirmation step) and is out of scope here. See the TODO in
//    DataPrivacySection.tsx.
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

        // ONE transaction. A partial delete is the worst outcome available
        // here: the user is told their data is gone while some of it remains,
        // and the counts the UI just showed them become a lie. If any of the
        // three fails, Prisma rolls the whole interactive batch back and
        // withRoute's catch turns it into a 500 + Sentry — nothing deleted,
        // and the failure toast ("Nothing was removed") is then true.
        const [savingsEvents, favoriteStores, couponReports] =
            await prisma.$transaction([
                prisma.savingsEvent.deleteMany({ where: { userId } }),
                prisma.favoriteStore.deleteMany({ where: { userId } }),
                prisma.couponReport.deleteMany({ where: { userId } }),
            ])

        return NextResponse.json({
            deleted: {
                savingsEvents: savingsEvents.count,
                favoriteStores: favoriteStores.count,
                couponReports: couponReports.count,
            },
        })
    },
)
