// /oauth/consent: where an AI app connecting to Caramel over MCP asks the
// signed-in user for access (better-auth oauthProvider `consentPage`).
//
// better-auth redirects here with a SIGNED query (the original authorize
// params + exp + sig). The form echoes that query back VERBATIM to
// POST /api/auth/oauth2/consent; re-encoding it would break the signature.
//
// Server-rendered so the screen never names the app one way and then
// another: the session, the stored client registration and the known-client
// match (knownMcpClients.ts) are settled before the first paint. A signed-out
// visitor goes to /login with the whole signed query, and the login page's
// continuation (authorizeContinuation.ts) resumes the authorize request.
import { auth } from '@/lib/auth/auth'
import { matchKnownMcpClient } from '@/lib/mcp/knownMcpClients'
import {
    OIDC_SCOPES,
    TIER_CONSENT_ROWS,
    tiersFromScopes,
} from '@/lib/mcp/oauthConfig'
import prisma from '@/lib/prisma'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import ConsentForm, { type ConsentTierRow } from './ConsentForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
    title: 'Connect an AI app to Caramel',
    robots: { index: false, follow: false },
}

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string {
    return (Array.isArray(value) ? value[0] : value) ?? ''
}

function toQueryString(params: SearchParams): string {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
        for (const v of Array.isArray(value) ? value : [value]) {
            if (v !== undefined) query.append(key, v)
        }
    }
    return query.toString()
}

/**
 * Control, zero-width and bidirectional-override characters: a registered
 * client name carrying them could hide or reorder text on the consent screen.
 */
function isInvisibleOrControl(codePoint: number): boolean {
    return (
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0x200b && codePoint <= 0x200f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069) ||
        codePoint === 0xfeff
    )
}

/** Self-reported registration text, made safe to quote on this page. */
function safeClientName(raw: string | null | undefined): string {
    const cleaned = Array.from(raw ?? '')
        .filter(ch => !isInvisibleOrControl(ch.codePointAt(0) ?? 0))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
    return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned
}

export default async function OAuthConsentPage({
    searchParams,
}: {
    searchParams: Promise<SearchParams>
}) {
    const params = await searchParams
    const clientId = first(params.client_id)
    if (!clientId) {
        return (
            <ConsentForm
                invalid
                heading="This connection link is incomplete"
                appName=""
                trust="unverified"
                accountEmail=""
                redirectUri=""
                identityScopes={[]}
                rows={[]}
            />
        )
    }

    const session = await auth.api.getSession({ headers: await headers() })
    if (!session) redirect(`/login?${toQueryString(params)}`)

    const client = await prisma.oauthClient.findUnique({
        where: { clientId },
        select: { name: true, redirectUris: true },
    })
    const match = matchKnownMcpClient({
        clientName: client?.name,
        redirectUris: client?.redirectUris ?? [],
    })
    const registeredName = safeClientName(client?.name)
    const appName = match.client?.name ?? registeredName
    // A known client is named under OUR name, unquoted; anything else keeps
    // quotes, because that name is only its own claim.
    const heading = match.client
        ? `${appName} wants to access your Caramel account`
        : appName
          ? `“${appName}” wants to access your Caramel account`
          : 'An app wants to access your Caramel account'

    const requestedScopes = first(params.scope).split(' ').filter(Boolean)
    const requestedTiers = tiersFromScopes(requestedScopes)
    const rows: ConsentTierRow[] = TIER_CONSENT_ROWS.filter(row =>
        requestedTiers.includes(row.tier),
    ).map(row => ({
        ...row,
        // A known client starts with every requested row ticked; one we do
        // not recognize starts with read only. The user can change either.
        checked: match.client ? true : row.tier === 'read',
    }))

    return (
        <ConsentForm
            heading={heading}
            appName={appName}
            trust={match.tier}
            accountEmail={session.user.email}
            redirectUri={first(params.redirect_uri)}
            identityScopes={requestedScopes.filter(scope =>
                (OIDC_SCOPES as readonly string[]).includes(scope),
            )}
            rows={rows}
        />
    )
}
