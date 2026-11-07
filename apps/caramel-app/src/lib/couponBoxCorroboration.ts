// src/lib/couponBoxCorroboration.ts
//
// Which coupon-box proposals are backed by a real win (T-10535). The extension
// saves a box (POST /api/extension/coupon-box-save) right after a code typed
// into it took money off the total, and right before that it reports the code
// as `worked` (POST /api/coupons/:id/report). A signed-in report is kept, with
// its user, in coupon_reports. So a proposal counts toward a store's quorum
// only when the SAME user has a `worked` report for a coupon of THAT store
// made shortly before the proposal: the save alone proves nothing the server
// can check, the report is the closest thing to the win it describes.
//
// A proposal without that evidence is still recorded (couponBoxSave
// recordBoxProposal), it just never counts. Evaluated whenever a quorum is
// counted, so a report that lands a moment after its save (the extension sends
// the two without waiting on each other) counts from the next save on.
//
// Known gap: the report route keeps one attributed row per user, coupon and
// outcome per UTC day, so a user who reported the same coupon as `worked`
// earlier that day and saves a box now leaves no fresh row. Such a proposal
// does not count; another install's can.
import { Prisma } from '@/generated/prisma/client'
import { parseCouponRows } from '@/lib/couponsDb'
import prisma from '@/lib/prisma'
import { z } from 'zod'

/** How long before its proposal a `worked` report still backs it. */
const CORROBORATING_REPORT_MAX_AGE_MS = 30 * 60 * 1000
/** How long after its proposal a report may land and still back it: the two
 * requests race. */
const CORROBORATING_REPORT_GRACE_MS = 2 * 60 * 1000

const AgreementRowSchema = z.object({
    agreeing: z.number().int(),
    own_corroborated: z.boolean(),
})

// A duration as a Postgres interval literal, bound as a parameter.
const interval = (ms: number) => `${ms / 1000} seconds`

/** The catalog sites a store's coupons are filed under: the store name with
 * and without `www.`. */
function storeSites(storeName: string): string[] {
    const bare = storeName.replace(/^www\./, '')
    return [bare, `www.${bare}`]
}

/**
 * For one box of one store: how many established users' proposals of it are
 * backed by a `worked` report of their own (within the proposal window), and
 * whether `userId`'s own proposal is.
 */
export async function corroboratedAgreement(args: {
    storeName: string
    boxHash: string
    userId: string
    proposedAfter: Date
    establishedBy: Date
}): Promise<{ agreeing: number; ownCorroborated: boolean }> {
    const { storeName, boxHash, userId, proposedAfter, establishedBy } = args
    const sites = storeSites(storeName)
    const backed = Prisma.sql`EXISTS (
        SELECT 1 FROM coupon_reports r
        JOIN coupons c ON c.id = r.coupon_id
        WHERE r.user_id = p.user_id
          AND r.outcome = 'worked'
          AND c.site IN (${Prisma.join(sites)})
          AND r.created_at >= p.created_at - ${interval(CORROBORATING_REPORT_MAX_AGE_MS)}::interval
          AND r.created_at <= p.created_at + ${interval(CORROBORATING_REPORT_GRACE_MS)}::interval
    )`
    const rows = parseCouponRows(
        AgreementRowSchema,
        await prisma.$queryRaw(Prisma.sql`
            SELECT
                (count(*) FILTER (
                    WHERE p.created_at > ${proposedAfter}
                      AND u."createdAt" <= ${establishedBy}
                      AND ${backed}
                ))::int AS agreeing,
                coalesce(bool_or(p.user_id = ${userId} AND ${backed}), false)
                    AS own_corroborated
            FROM coupon_box_proposals p
            JOIN users u ON u.id = p.user_id
            WHERE p.store_name = ${storeName} AND p.box_hash = ${boxHash}
        `),
        'couponBoxCorroboration.corroboratedAgreement',
    )
    const row = rows[0]
    return {
        agreeing: row?.agreeing ?? 0,
        ownCorroborated: row?.own_corroborated ?? false,
    }
}
