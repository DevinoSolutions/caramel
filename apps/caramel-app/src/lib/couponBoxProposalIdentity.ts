// src/lib/couponBoxProposalIdentity.ts
//
// The ONE definition of "which coupon_box_proposals rows belong to this
// account" (T-12391), the sibling of siteSuggestionIdentity.ts.
//
// A LEAF on purpose: types from the generated Prisma client and nothing else.
// Three callers read through it and must not each spell it out —
//   - POST /api/account/data/delete   deletes the rows it selects
//   - GET  /api/account/overview      counts them, so the danger-zone button
//                                     knows there is something to delete
//   - GET  /api/account/export        exports them
// If the delete and the count ever disagreed, the account page would say
// "Nothing to delete" about rows the route would happily have deleted.
import type { Prisma } from '@/generated/prisma/client'

/**
 * A proposal is only ever written by a signed-in extension
 * (couponBoxSave.recordBoxProposal, `auth: 'session'`), so `user_id` is NOT NULL
 * and is the whole tie to the account: no email branch exists to match, unlike
 * a site suggestion made while signed out.
 */
export function couponBoxProposalIdentityWhere(
    userId: string,
): Prisma.CouponBoxProposalWhereInput {
    return { userId }
}
