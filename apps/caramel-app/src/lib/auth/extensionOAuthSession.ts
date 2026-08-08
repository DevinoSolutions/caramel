// src/lib/auth/extensionOAuthSession.ts
//
// F-007 — centralizes the raw-Prisma session mint that
// extension/oauth/route.ts's POST (code-exchange) handler used to
// hand-roll TWICE, once per provider branch (Google, Apple), free to
// silently diverge — the finding's actual defect ("the auth surface has
// two implementations that can diverge"). Both branches now call this
// ONE function; a change here can never apply to only one provider.
//
// ⚠️ WHY RAW PRISMA, NOT better-auth's own session API: the extension
// exchanges its OAuth `code` for tokens itself (chrome.identity can't do
// a normal browser redirect back through better-auth's own callback), so
// this route needs to mint a session from an ALREADY-COMPLETED provider
// exchange. better-auth (1.6.23 installed) has no PUBLIC server API for
// that — only the INTERNAL, version-unstable
// `auth.$context.internalAdapter.createSession`. So the mint writes the
// Session row itself and returns the RAW session token as the
// extension's bearer credential. That token authenticates as-is:
// better-auth's bearer plugin signs a dot-less bearer with the auth
// secret on the fly, verifies it, and resolves the session from the raw
// token (dist/plugins/bearer in 1.6.23). An earlier version self-fetched
// our own auth API here to trade the raw token for a
// bearer-plugin-issued one; that fetch was structurally dead in BOTH
// halves — better-auth 1.6.23 registers /get-session (the code fetched
// /api/auth/session → 404 every time), and even the correct path
// requires a SIGNED session cookie while the mint only holds the raw
// token — so every mint ever shipped returned the raw token, and the
// dead fetch was deleted (NF-07). Parked per DESIGN.md §2(c): adopt
// better-auth's own mint once a public external-code-exchange API
// exists.
import prisma from '@/lib/prisma'
import { randomBytes } from 'crypto'

export type ExtensionOAuthProvider = 'google' | 'apple'

export interface ExtensionOAuthProviderUser {
    /** The provider's own user id (Google userinfo `id`, Apple ID
     * token's `sub`). */
    id: string
    /** Null only for Apple's private-relay-hidden-email edge case —
     * tolerated when an account already links this provider+id. */
    email: string | null
    name?: string | null
    image?: string | null
    emailVerified?: boolean
}

export interface ExtensionOAuthTokens {
    accessToken?: string | null
    idToken?: string | null
}

export interface MintedExtensionSession {
    token: string
    username: string | null
    image: string | null
}

/** Thrown when no existing user is found AND the provider gave no email
 * to create one with (Google always provides email — see the route's
 * own pre-check — so in practice only Apple's private-relay case
 * reaches this). Each call site maps it to its own pre-existing
 * provider-specific message. */
export class ExtensionOAuthEmailRequiredError extends Error {
    constructor(public readonly provider: ExtensionOAuthProvider) {
        super(`Email is required for ${provider} sign-in`)
        this.name = 'ExtensionOAuthEmailRequiredError'
    }
}

/**
 * Finds-or-creates the User + Account link, mints a 7-day session, and
 * returns the raw session token as `token` — the extension's bearer
 * credential (better-auth's bearer plugin verifies it as-is; see the
 * module header).
 */
export async function mintExtensionSession({
    provider,
    providerUser,
    tokens,
}: {
    provider: ExtensionOAuthProvider
    providerUser: ExtensionOAuthProviderUser
    tokens: ExtensionOAuthTokens
}): Promise<MintedExtensionSession> {
    const email = providerUser.email
        ? providerUser.email.toLowerCase().trim()
        : null

    let user = await prisma.user.findFirst({
        where: {
            OR: email
                ? [
                      { email },
                      {
                          accounts: {
                              some: {
                                  providerId: provider,
                                  accountId: providerUser.id,
                              },
                          },
                      },
                  ]
                : [
                      {
                          accounts: {
                              some: {
                                  providerId: provider,
                                  accountId: providerUser.id,
                              },
                          },
                      },
                  ],
        },
        include: { accounts: true },
    })

    if (!user) {
        if (!email) {
            throw new ExtensionOAuthEmailRequiredError(provider)
        }
        user = await prisma.user.create({
            data: {
                email,
                name: providerUser.name ?? null,
                image: providerUser.image ?? null,
                emailVerified: providerUser.emailVerified ?? false,
                status: providerUser.emailVerified
                    ? 'ACTIVE_USER'
                    : 'NOT_VERIFIED',
            },
            include: { accounts: true },
        })
    } else {
        // Reassign `user` so the minted response below reflects the
        // freshly-updated name/image (NF-12). Previously the update ran
        // but its result was discarded, so the response was built from the
        // stale pre-update findFirst() row (DB correct, response stale).
        // include:{accounts:true} keeps `user`'s type identical to the create
        // branch and the findFirst() above.
        user = await prisma.user.update({
            where: { id: user.id },
            data: {
                name: providerUser.name ?? user.name,
                image: providerUser.image ?? user.image,
                emailVerified:
                    providerUser.emailVerified !== undefined
                        ? providerUser.emailVerified
                        : user.emailVerified,
            },
            include: { accounts: true },
        })
    }

    const account = await prisma.account.findUnique({
        where: {
            providerId_accountId: {
                providerId: provider,
                accountId: providerUser.id,
            },
        },
    })

    if (!account) {
        await prisma.account.create({
            data: {
                providerId: provider,
                accountId: providerUser.id,
                userId: user.id,
                accessToken: tokens.accessToken || null,
                idToken: tokens.idToken || null,
            },
        })
    } else {
        await prisma.account.update({
            where: { id: account.id },
            data: {
                accessToken: tokens.accessToken || account.accessToken,
                idToken: tokens.idToken || account.idToken,
            },
        })
    }

    return createExtensionSessionRow(user)
}

/** The one place a raw-token extension Session row is written. Both mint
 * paths (OAuth code exchange above, signed-in-web relay below) end here,
 * so token shape / lifetime / response shape can never diverge. */
async function createExtensionSessionRow(user: {
    id: string
    username: string | null
    name: string | null
    email: string | null
    image: string | null
}): Promise<MintedExtensionSession> {
    const sessionToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7) // 7 days

    await prisma.session.create({
        data: {
            token: sessionToken,
            userId: user.id,
            expiresAt,
        },
    })

    return {
        token: sessionToken,
        username: user.username || user.name || user.email || null,
        image: user.image || null,
    }
}

/**
 * Mints an extension session for a user who is ALREADY authenticated on
 * the website (better-auth cookie session) — the website→extension
 * sign-in relay. No provider exchange involved; the caller (the
 * session-gated POST /api/extension/session route) has already proven
 * the user's identity. Returns null when the user row is gone (deleted
 * account with a live cookie).
 */
export async function mintExtensionSessionForUser(
    userId: string,
): Promise<MintedExtensionSession | null> {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user) return null
    return createExtensionSessionRow(user)
}
