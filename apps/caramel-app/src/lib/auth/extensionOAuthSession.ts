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
// exchange. better-auth 1.5.3 has no PUBLIC server API for that — only
// the INTERNAL, version-unstable `auth.$context.internalAdapter.createSession`
// (used today only by admin-impersonate). PLAN-F-007.md's STOP-DESIGN
// ruling: centralize the existing raw-Prisma mint rather than adopt that
// internal API, since doing so would change the issued token's shape —
// a security-surface risk out of proportion for a High/modularity fix.
// Trigger to revisit: a characterization test proving a
// internalAdapter-minted token authenticates via /api/auth/get-session +
// bearer identically to today's token — until then, this stays raw
// Prisma. DELETE WHEN: better-auth ships a public API for this
// (park as a new finding — see PLAN-F-007.md §Approach).
import { env } from '@/lib/env'
import { BASE_URL } from '@/lib/env.client'
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
 * Finds-or-creates the User + Account link, mints a 7-day raw session
 * token, and resolves a bearer token for it (via better-auth's own
 * /api/auth/session bearer-issuance, falling back to the raw session
 * token if that self-fetch fails) — wire-identical to what the Google
 * and Apple branches of extension/oauth's POST each did independently
 * pre-F-007 (see PLAN-F-007.md §Premise correction: the mint lives here,
 * not in oauth/redirect).
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
        await prisma.user.update({
            where: { id: user.id },
            data: {
                name: providerUser.name ?? user.name,
                image: providerUser.image ?? user.image,
                emailVerified:
                    providerUser.emailVerified !== undefined
                        ? providerUser.emailVerified
                        : user.emailVerified,
            },
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

    // Generate bearer token. Better-auth's bearer plugin issues one based
    // on a live session cookie — self-fetch our own /api/auth/session
    // with the just-minted session cookie to get it. If that fails for
    // any reason, fall back to the raw session token itself, which the
    // extension can also use to authenticate.
    let authToken: string | null = null
    try {
        const baseURL = env.BETTER_AUTH_URL || BASE_URL
        const bearerTokenResponse = await fetch(`${baseURL}/api/auth/session`, {
            method: 'GET',
            headers: {
                Cookie: `better-auth.session_token=${sessionToken}`,
            },
        })
        if (bearerTokenResponse.ok) {
            authToken = bearerTokenResponse.headers.get('set-auth-token')
        }
    } catch (error) {
        console.error('Error getting bearer token:', error)
    }
    if (!authToken) {
        authToken = sessionToken
    }

    return {
        token: authToken,
        username: user.username || user.name || user.email || null,
        image: user.image || null,
    }
}
