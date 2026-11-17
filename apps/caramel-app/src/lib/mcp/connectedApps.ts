// src/lib/mcp/connectedApps.ts
//
// The AI apps a user connected to Caramel over MCP (one per OAuth consent),
// and the two ways a grant ends: the user disconnects one app (profile page
// or the MCP `disconnect` tool), or the account is deleted.
//
// Revocation must reach tokens already issued: access tokens are 30-day
// stateless JWTs, so deleting rows alone cannot stop them. Disconnect also
// writes the grant's watermark (mcp_grant_revocations), and every MCP call
// refuses a token issued at or before it (principal.ts).
import { matchKnownMcpClient } from '@/lib/mcp/knownMcpClients'
import { scopeLabel } from '@/lib/mcp/oauthConfig'
import prisma from '@/lib/prisma'

export type ConnectedApp = {
    clientId: string
    /** Our name for a known client, else the name it registered with. */
    name: string
    /** verified / recognized / unverified, from the stored registration. */
    trust: 'verified' | 'recognized' | 'unverified'
    scopes: { scope: string; label: string }[]
    connectedAt: string
}

export async function listConnectedApps(
    userId: string,
): Promise<ConnectedApp[]> {
    const consents = await prisma.oauthConsent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { clientId: true, scopes: true, createdAt: true },
    })
    if (consents.length === 0) return []

    // A client re-consented (scope upgrade) can hold several rows: one entry
    // per client, newest first, with the union of what it was granted.
    const byClientId = new Map<
        string,
        { scopes: Set<string>; createdAt: Date }
    >()
    for (const consent of consents) {
        const seen = byClientId.get(consent.clientId)
        if (seen) {
            for (const scope of consent.scopes) seen.scopes.add(scope)
        } else {
            byClientId.set(consent.clientId, {
                scopes: new Set(consent.scopes),
                createdAt: consent.createdAt,
            })
        }
    }

    const clients = await prisma.oauthClient.findMany({
        where: { clientId: { in: [...byClientId.keys()] } },
        select: { clientId: true, name: true, redirectUris: true },
    })
    const clientById = new Map(clients.map(c => [c.clientId, c]))

    return [...byClientId.entries()].map(([clientId, consent]) => {
        const client = clientById.get(clientId)
        const match = matchKnownMcpClient({
            clientName: client?.name ?? null,
            redirectUris: client?.redirectUris ?? [],
        })
        return {
            clientId,
            name: match.client?.name ?? (client?.name?.trim() || 'Unnamed app'),
            trust: match.tier,
            scopes: [...consent.scopes].map(scope => ({
                scope,
                label: scopeLabel(scope),
            })),
            connectedAt: consent.createdAt.toISOString(),
        }
    })
}

/**
 * Disconnect one AI app for one user, in one transaction: the consent (the
 * live-consent check refuses further calls), stored access tokens, refresh
 * tokens (marked revoked, kept as evidence for reuse detection) and the
 * watermark. Idempotent. Returns whether the app was connected.
 */
export async function revokeConnectedApp(args: {
    userId: string
    clientId: string
}): Promise<{ wasConnected: boolean }> {
    const { userId, clientId } = args
    const revokedAt = new Date()
    const [consents] = await prisma.$transaction([
        prisma.oauthConsent.deleteMany({ where: { userId, clientId } }),
        prisma.oauthAccessToken.deleteMany({ where: { userId, clientId } }),
        prisma.oauthRefreshToken.updateMany({
            where: { userId, clientId, revoked: null },
            data: { revoked: revokedAt },
        }),
        prisma.mcpGrantRevocation.upsert({
            where: { userId_clientId: { userId, clientId } },
            create: { userId, clientId, revokedAt },
            update: { revokedAt },
        }),
    ])
    return { wasConnected: consents.count > 0 }
}

/**
 * The deletes that remove every MCP OAuth trace of a user, for the account
 * deletion transaction (src/app/api/account/delete/route.ts). Returned
 * unawaited so they run in the caller's $transaction.
 */
export function accountOAuthCleanup(userId: string) {
    return [
        prisma.oauthConsent.deleteMany({ where: { userId } }),
        prisma.oauthAccessToken.deleteMany({ where: { userId } }),
        prisma.oauthRefreshToken.deleteMany({ where: { userId } }),
        prisma.mcpGrantRevocation.deleteMany({ where: { userId } }),
        prisma.mcpToolCall.deleteMany({ where: { userId } }),
    ] as const
}
