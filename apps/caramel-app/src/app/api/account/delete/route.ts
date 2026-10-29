import type { Prisma } from '@/generated/prisma/client'
import { deletePosthogPerson } from '@/lib/analytics/posthogPersonDeletion'
import { withRoute } from '@/lib/api/withRoute'
import {
    loadAppleRevocationTargets,
    revokeAppleGrants,
    type AppleRevocationOutcome,
} from '@/lib/auth/appleTokenRevocation'
import prisma from '@/lib/prisma'
import {
    foldRequesterEmail,
    SITE_SUGGESTION_SCRUB_DATA,
    siteSuggestionIdentityWhere,
} from '@/lib/siteSuggestionIdentity'
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
// SIGN IN WITH APPLE (T-5065, App Review 5.1.1(v)): the Apple tokens are read
// from the accounts row BEFORE the transaction (the cascade removes it) and
// revoked at appleid.apple.com/auth/revoke AFTER it commits
// (appleTokenRevocation.ts). A revoke that fails does NOT fail the request: the
// account is already gone and a 5xx would only make the client retry into a
// 401. The failure goes to Sentry (never silent) and the response says so in
// `appleRevocation` ('not_applicable' | 'revoked' | 'failed'); a user without
// an Apple account triggers no call at all.
//
// POSTHOG (T-7505): after the commit, the user's PostHog person and events are
// deleted through PostHog's private API (posthogPersonDeletion.ts). The user id
// is still in hand because it comes from the session, not the deleted row. Like
// the Apple revoke, a failure never fails the request (the account is already
// gone): it goes to Sentry and the response says `analyticsDeletion: 'failed'`.
// 'not_applicable' means PostHog is disabled for this deploy. Success means
// PostHog QUEUED the delete; it finishes in the background.
const DELETE_CONFIRMATION = 'DELETE'

/** better-auth's email-OTP identifier is `${type}-otp-${email}` (toOTPIdentifier
 * in better-auth/dist/plugins/email-otp/utils.mjs, v1.6.23). The change-email
 * type embeds a second address and cannot be listed exactly. */
const EMAIL_OTP_TYPES = ['sign-in', 'email-verification', 'forget-password']

/** The verification_tokens rows that belong to this account (see above): the
 * rows keyed by the user id in `value` (core better-auth writes
 * `reset-password:<token>` and `delete-account-<token>` that way) and the
 * rows whose identifier IS this account's address in one of the exact forms
 * better-auth writes. EXACT identifiers only, never a suffix match: another
 * person's `a-<address>` must survive. The address is folded (lower case) and
 * matched case-sensitively; `mode: 'insensitive'` compiles to an unescaped
 * ILIKE (see siteSuggestionIdentity.ts). */
function verificationWhere(args: {
    userId: string
    email: string | null
}): Prisma.VerificationWhereInput {
    if (!args.email) return { value: args.userId }
    const email = foldRequesterEmail(args.email)
    return {
        OR: [
            { value: args.userId },
            {
                identifier: {
                    in: [
                        email,
                        ...EMAIL_OTP_TYPES.map(type => `${type}-otp-${email}`),
                    ],
                },
            },
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

        // Before the delete: the accounts cascade away with the user.
        const appleTargets = await loadAppleRevocationTargets(userId)

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

        const deleted = users.count > 0
        // Only the request that actually deleted the user revokes; the loser of
        // a double-submit race leaves it to the winner.
        const appleRevocation: AppleRevocationOutcome = deleted
            ? await revokeAppleGrants(appleTargets)
            : 'not_applicable'

        // Same rule as the revoke: only the request that deleted the user.
        const analyticsDeletion = deleted
            ? await deletePosthogPerson(userId)
            : 'not_applicable'

        return NextResponse.json({
            deleted,
            scrubbed: { siteSuggestions: siteSuggestions.count },
            appleRevocation,
            analyticsDeletion,
        })
    },
)
