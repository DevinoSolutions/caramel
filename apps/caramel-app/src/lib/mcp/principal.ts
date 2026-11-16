// src/lib/mcp/principal.ts
//
// Who is calling the MCP server: verifies the OAuth access token on a request
// to /api/mcp and checks, on EVERY request, that the grant behind it is still
// live. Returns the principal the tools act as, or a reason to answer 401.
//
// Token check (RFC 9068 access-token JWT, signed by better-auth's jwt plugin):
//   - signature against the auth server's own JWKS, read in-process through
//     `auth.api.getJwks()` (no HTTP self-fetch: inside the container the public
//     origin may not hairpin back);
//   - `iss` = the better-auth base URL including /api/auth;
//   - `aud` = MCP_RESOURCE, `typ` = at+jwt and an `azp` claim, which together
//     refuse a session JWT signed with the same key (OAuth Provider Mode docs);
//   - a DPoP-bound token (`cnf`) is refused: this resource accepts Bearer only.
//
// Grant check (why a 30-day stateless JWT is safe):
//   - an oauth_consents row for (user, client) must exist, and the token's
//     scopes are narrowed to what that consent still grants;
//   - the token must have been issued AFTER the grant's Disconnect watermark
//     (mcp_grant_revocations), so a reconnect cannot revive an old token.
// The lookup fails CLOSED: a database error refuses the call.
import { auth } from '@/lib/auth/auth'
import {
    ACCESS_TOKEN_ISSUED_AT_MS_CLAIM,
    MCP_RESOURCE,
    tiersFromScopes,
    type McpTier,
} from '@/lib/mcp/oauthConfig'
import { loadBridgedSession } from '@/lib/mcp/routeBridge'
import type { BridgedSession } from '@/lib/mcp/routeBridgeContext'
import prisma from '@/lib/prisma'
import * as Sentry from '@sentry/nextjs'
import { verifyJwsAccessToken } from 'better-auth/oauth2'
import type { JSONWebKeySet, JWTPayload } from 'jose'

export type McpPrincipal = {
    userId: string
    clientId: string
    /** Granted OAuth scopes still covered by the live consent. */
    scopes: readonly string[]
    /** The permission tiers those scopes carry. */
    tiers: readonly McpTier[]
    issuedAt: Date
    expiresAt: Date
    /** The user as the API routes see a signed-in caller (routeBridge.ts). */
    session: BridgedSession
}

export type PrincipalResult =
    | { ok: true; principal: McpPrincipal }
    | {
          ok: false
          /** RFC 6750 error code for the WWW-Authenticate challenge. */
          error: 'invalid_request' | 'invalid_token'
          description: string
      }

/** The Bearer credential of an Authorization header, or null. */
export function extractBearerToken(headers: Headers): string | null {
    const raw = headers.get('authorization')
    if (!raw) return null
    const match = /^Bearer\s+(\S+)\s*$/i.exec(raw.trim())
    return match?.[1] ?? null
}

let issuerPromise: Promise<string> | null = null
/** The OAuth issuer: better-auth's baseURL, which includes /api/auth. */
export function authIssuer(): Promise<string> {
    if (!issuerPromise) issuerPromise = auth.$context.then(ctx => ctx.baseURL)
    return issuerPromise
}

// Stable cache key: better-auth caches the in-process JWKS under it with its
// usual TTL and refetches on an unknown `kid` (key rotation).
const JWKS_CACHE_KEY = {}
async function readJwks(): Promise<JSONWebKeySet> {
    return (await auth.api.getJwks()) as JSONWebKeySet
}

function scopesOf(payload: JWTPayload): string[] {
    const scope = payload.scope
    if (typeof scope === 'string') return scope.split(' ').filter(Boolean)
    if (Array.isArray(scope))
        return scope.filter((s): s is string => typeof s === 'string')
    return []
}

function issuedAtOf(payload: JWTPayload): Date | null {
    const ms = payload[ACCESS_TOKEN_ISSUED_AT_MS_CLAIM]
    if (typeof ms === 'number' && Number.isFinite(ms)) return new Date(ms)
    if (typeof payload.iat === 'number') return new Date(payload.iat * 1000)
    return null
}

/** Injectable data side, so the grant rules are unit-testable. */
export type GrantStateDeps = {
    findConsentScopes: (key: {
        userId: string
        clientId: string
    }) => Promise<string[][]>
    findRevokedAt: (key: {
        userId: string
        clientId: string
    }) => Promise<Date | null>
}

const prismaGrantState: GrantStateDeps = {
    findConsentScopes: async ({ userId, clientId }) => {
        const rows = await prisma.oauthConsent.findMany({
            where: { userId, clientId },
            select: { scopes: true },
        })
        return rows.map(row => row.scopes)
    },
    findRevokedAt: async ({ userId, clientId }) => {
        const row = await prisma.mcpGrantRevocation.findUnique({
            where: { userId_clientId: { userId, clientId } },
            select: { revokedAt: true },
        })
        return row?.revokedAt ?? null
    },
}

/**
 * The scopes of a token that the live grant still covers, or null when the
 * grant is gone (no consent, or the token predates a Disconnect). A tie with
 * the watermark is refused: the safe side of the rounding.
 */
export async function liveGrantScopes(
    input: {
        userId: string
        clientId: string
        tokenScopes: readonly string[]
        issuedAt: Date
    },
    deps: GrantStateDeps = prismaGrantState,
): Promise<string[] | null> {
    const key = { userId: input.userId, clientId: input.clientId }
    const [consentScopes, revokedAt] = await Promise.all([
        deps.findConsentScopes(key),
        deps.findRevokedAt(key),
    ])
    if (consentScopes.length === 0) return null
    if (revokedAt && input.issuedAt.getTime() <= revokedAt.getTime())
        return null
    const consented = new Set(consentScopes.flat())
    return input.tokenScopes.filter(scope => consented.has(scope))
}

/** Verify the request's access token and its live grant. */
export async function resolveMcpPrincipal(
    headers: Headers,
): Promise<PrincipalResult> {
    const token = extractBearerToken(headers)
    if (!token) {
        return {
            ok: false,
            error: 'invalid_request',
            description: 'Missing Bearer access token.',
        }
    }

    let payload: JWTPayload
    try {
        payload = await verifyJwsAccessToken(token, {
            jwksFetch: readJwks,
            jwksCacheKey: JWKS_CACHE_KEY,
            verifyOptions: {
                issuer: await authIssuer(),
                audience: MCP_RESOURCE,
                typ: 'at+jwt',
                requiredClaims: ['azp', 'sub'],
            },
        })
    } catch {
        // An expired, forged, foreign or malformed token: the client's problem,
        // answered with the standard challenge so it refreshes or reconnects.
        return {
            ok: false,
            error: 'invalid_token',
            description: 'The access token is invalid or expired.',
        }
    }

    if (payload.cnf !== undefined) {
        return {
            ok: false,
            error: 'invalid_token',
            description: 'Sender-constrained (DPoP) tokens are not accepted.',
        }
    }

    const userId = payload.sub
    const clientId = typeof payload.azp === 'string' ? payload.azp : null
    const issuedAt = issuedAtOf(payload)
    if (!userId || !clientId || !issuedAt || typeof payload.exp !== 'number') {
        return {
            ok: false,
            error: 'invalid_token',
            description: 'The access token is missing required claims.',
        }
    }

    let scopes: string[] | null
    try {
        scopes = await liveGrantScopes({
            userId,
            clientId,
            tokenScopes: scopesOf(payload),
            issuedAt,
        })
    } catch (error) {
        // Fail closed and loud: this is the check that makes Disconnect real.
        Sentry.captureException(error, {
            tags: { surface: 'mcp-grant-check' },
            extra: { clientId },
        })
        throw error
    }
    if (!scopes) {
        return {
            ok: false,
            error: 'invalid_token',
            description:
                'This connection was disconnected. Connect Caramel again.',
        }
    }

    const expiresAt = new Date(payload.exp * 1000)
    const session = await loadBridgedSession({
        userId,
        clientId,
        expiresAt,
        issuedAt,
    })
    if (!session) {
        return {
            ok: false,
            error: 'invalid_token',
            description: 'This Caramel account no longer exists.',
        }
    }

    return {
        ok: true,
        principal: {
            userId,
            clientId,
            scopes,
            tiers: tiersFromScopes(scopes),
            issuedAt,
            expiresAt,
            session,
        },
    }
}
