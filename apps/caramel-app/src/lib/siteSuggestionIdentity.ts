// src/lib/siteSuggestionIdentity.ts
//
// The ONE definition of "which site_suggestions rows identify this account",
// and of what a scrub removes from them.
//
// A LEAF on purpose: types from @prisma/client and nothing else. Two callers
// need this predicate and they must not each spell it out —
//   - POST /api/account/data/delete   scrubs the rows it selects
//   - GET  /api/account/overview      counts them, so the danger-zone button
//                                     knows there is something to do
// If those two ever disagreed, the account page would say "Nothing to delete"
// about rows the delete route would happily have scrubbed, or offer a delete
// that removes nothing — and both readings look fine in isolation.
import type { Prisma } from '@prisma/client'

/**
 * How a suggestion is tied to an account, matched TWO ways.
 *
 * `user_id` finds the requests made while signed in. The requester email finds
 * the ones made while signed OUT, where the row carries no user id at all and
 * the address the person typed is the only thing on it. Matching by user id
 * alone is the predicate that looks right and misses exactly those.
 *
 * Case-insensitive, because the suggest form records what the visitor typed
 * (`Shopper@Example.COM`) while the account holds its own spelling.
 *
 * An account with NO email (the schema allows one) contributes no email branch
 * rather than a `null` one, which would match every anonymous suggestion ever
 * made.
 *
 * Note what this predicate already guarantees, so that nothing adds a second
 * condition saying it again: every branch requires a non-null column, so a row
 * that has ALREADY been scrubbed (user id, email and user agent all null)
 * matches neither branch and is therefore never selected or counted. An
 * anonymous row that carries only a `user_agent` belongs to nobody and is not
 * matched either. Both are pinned rather than left as reasoning.
 */
export function siteSuggestionIdentityWhere(input: {
    userId: string
    email: string | null
}): Prisma.SiteSuggestionWhereInput {
    const { userId, email } = input
    return {
        OR: [
            { userId },
            ...(email
                ? [
                      {
                          requesterEmail: {
                              equals: email,
                              mode: 'insensitive' as const,
                          },
                      },
                  ]
                : []),
        ],
    }
}

/**
 * What a scrub nulls.
 *
 * The row is SCRUBBED, never deleted: a "please support this store" request is
 * not personal data once the requester is off it, and it is the coupons
 * pipeline's input — deleting it would silently retract a store request other
 * people may also have made, and corrupt a queue this user does not own.
 *
 * `domain` and `status` survive, because they are the request. `rawUrl` does
 * NOT: it is a URL the person pasted, and a pasted URL can carry a session or
 * affiliate token, while the pipeline only ever keys on `domain` (2026-09-08,
 * owner call). It is EMPTIED rather than nulled — the column is NOT NULL and
 * `rawUrl` is a required string on the wire the coupons pipeline reads, so
 * making it nullable would be a cross-repo contract change for no gain. The
 * empty string is unambiguous: the suggest route's body schema requires at
 * least one character, so no live row can be born with one.
 *
 * Nothing new is stamped. A scrub is not an ANSWER to the request, so
 * `statusChangedAt`, `notifiedAt` and `importedAt` are left exactly as they are.
 */
export const SITE_SUGGESTION_SCRUB_DATA = {
    userId: null,
    requesterEmail: null,
    userAgent: null,
    rawUrl: '',
} satisfies Prisma.SiteSuggestionUncheckedUpdateManyInput
