import { withRoute } from '@/lib/api/withRoute'
import prisma from '@/lib/prisma'
import {
    foldRequesterEmail,
    SITE_SUGGESTION_SCRUB_DATA,
    siteSuggestionIdentityWhere,
} from '@/lib/siteSuggestionIdentity'
import type { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// POST /api/account/delete — "Delete my account", the in-app deletion Apple
// App Review guideline 5.1.1(v) requires of an app that lets people create an
// account (the iOS app, T-4906). Unlike POST /api/account/data/delete, which
// empties the synced-data tables and keeps the login, this removes the USER.
//
// WHAT DELETING THE USER ROW DOES (prisma/schema.prisma is the authority, this
// route adds no per-table deletes of its own so it cannot drift from it):
//  - Cascade: accounts (the Google/Apple links), sessions (every extension,
//    app and website login, the presented bearer included, so it stops working
//    the moment this commits), coupon reports, favorite stores, savings events.
//  - SetNull: coupons the user submitted keep the code and lose the
//    attribution ("deleting an account drops the attribution, not the code");
//    site suggestions keep their domain and status.
//  - site_suggestions also carry the requester's email and user agent as plain
//    columns, not a foreign key, and a signed-out request carries NO user id,
//    so the SetNull alone would leave the address behind. They are scrubbed in
//    the same transaction with the same predicate the data-delete route uses.
//  - verification_tokens (better-auth's one-time tokens) hang off no foreign
//    key either: their `identifier` holds the address (or a purpose prefix plus
//    the address) and, for a password-reset token, `value` holds the user id.
//    Rows matching either are erased in the same transaction.
//
// Authenticated by the bearer the app already holds (auth: 'session' resolves a
// bearer or a website cookie). The app sends no Origin header, which
// isOriginAllowed lets through; a cross-origin BROWSER caller still carries an
// Origin and is refused, which is the CSRF gate for the cookie case.
//
// Confirmation is REQUIRED IN THE BODY and enforced by the schema, like
// data/delete: the app's confirmation dialog is a second lock, not the only one.
//
// ONE transaction: a partial deletion (suggestions scrubbed, account still
// there, or the reverse) is the outcome to rule out. A failure rolls the whole
// batch back and withRoute turns it into a 500 + Sentry, so a client that sees
// an error may retry safely. A retry AFTER success is not answered by this
// handler at all: the sessions are gone, so the auth gate answers 401 (the
// client treats that as "already signed out"). Only a lost race (two submits
// arriving together, both authenticated) reaches here twice, and deleteMany
// makes the second a no-op answered with `deleted: false` rather than an error.
//
// NOT done here, by design of what is stored: Sign in with Apple token
// revocation. Apple wants the grant revoked when an account is deleted, which
// needs the refresh token, and extensionOAuthSession.ts does not persist one
// (only the short-lived access and id tokens).
// TODO(T-4906): persist Apple's refresh token at mint and call
// appleid.apple.com/auth/revoke from here.
//
// Also NOT done: deleting the user's PostHog person. posthogServer.ts holds a
// capture-only client (project token, no personal API key), and a person delete
// is a private-API call.
// TODO(T-4906): give the server a PostHog personal API key and delete the
// person (distinct id = the user id) here, or on a queue, once it exists.
const DELETE_CONFIRMATION = 'DELETE'

/** The verification_tokens rows that belong to this account (see above). */
function verificationWhere(args: {
    userId: string
    email: string | null
}): Prisma.VerificationWhereInput {
    return {
        OR: [
            { value: args.userId },
            // The bare address, or better-auth's `<purpose>-<address>` /
            // `<purpose>:<address>` forms: anchored at the END so another
            // person's address that merely contains this one is left alone.
            // The FOLDED (lower-case) address, matched exactly and
            // case-sensitively (no `mode: 'insensitive'`, which compiles to an
            // unescaped ILIKE: see siteSuggestionIdentity.ts): better-auth
            // lower-cases the address it stores.
            ...(args.email
                ? [
                      { identifier: foldRequesterEmail(args.email) },
                      {
                          identifier: {
                              endsWith: `-${foldRequesterEmail(args.email)}`,
                          },
                      },
                      {
                          identifier: {
                              endsWith: `:${foldRequesterEmail(args.email)}`,
                          },
                      },
                  ]
                : []),
        ],
    }
}

const DeleteAccountBodySchema = z.object({
    confirm: z.literal(DELETE_CONFIRMATION),
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'account/delete',
        rateLimit: 'mutation',
        origin: true,
        auth: 'session',
        body: DeleteAccountBodySchema,
    },
    async ({ session }) => {
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const userId = session.user.id
        const email = session.user.email ?? null

        const [siteSuggestions, , users] = await prisma.$transaction([
            prisma.siteSuggestion.updateMany({
                where: siteSuggestionIdentityWhere({ userId, email }),
                data: SITE_SUGGESTION_SCRUB_DATA,
            }),
            prisma.verification.deleteMany({
                where: verificationWhere({ userId, email }),
            }),
            prisma.user.deleteMany({ where: { id: userId } }),
        ])

        return NextResponse.json({
            deleted: users.count > 0,
            scrubbed: { siteSuggestions: siteSuggestions.count },
        })
    },
)
