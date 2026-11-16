// src/lib/mcp/oauthConfig.ts
//
// The ONE source of the Caramel MCP OAuth vocabulary: the protected resource
// (the MCP endpoint, which is also the JWT `aud`), the permission tiers, the
// scope string each tier is granted under and the plain-language label the
// consent screen and the connected-apps list show for it.
//
// Read by: the better-auth `oauthProvider` plugin config (auth.ts), the
// RFC 9728 resource metadata, the token verifier (principal.ts), the tool
// registry (every tool names exactly one tier) and the consent page. Never
// write a second literal for any of these.
import { BASE_URL } from '@/lib/env.client'

const origin = BASE_URL.replace(/\/+$/, '')

/** Canonical casing everywhere: serverInfo, the server card, snippets. */
export const MCP_SERVER_NAME = 'Caramel'

/** The MCP endpoint and RFC 8707 resource identifier. */
export const MCP_RESOURCE = `${origin}/api/mcp`

/** Where the RFC 9728 protected-resource metadata lives. */
export const PROTECTED_RESOURCE_METADATA_URL = `${origin}/.well-known/oauth-protected-resource`

/**
 * Fleet permission tiers (MCP parity contract section 3.2), the subset Caramel
 * has: no billing (Caramel is free), no teams, no API keys.
 */
export const MCP_TIERS = [
    'read',
    'write',
    'destructive',
    'account',
    'connections',
    'support',
] as const
export type McpTier = (typeof MCP_TIERS)[number]

/** The OAuth scope each tier is granted under. */
export const TIER_SCOPE: Record<McpTier, string> = {
    read: 'caramel:read',
    write: 'caramel:write',
    destructive: 'caramel:delete',
    account: 'caramel:account',
    connections: 'caramel:connections',
    support: 'caramel:support',
}

export const MCP_SCOPES = MCP_TIERS.map(tier => TIER_SCOPE[tier])

/**
 * OIDC base scopes. `offline_access` must stay: the provider only issues a
 * refresh token when it was requested and granted.
 */
export const OIDC_SCOPES = [
    'openid',
    'profile',
    'email',
    'offline_access',
] as const

/** Consent-screen row for each tier, in display order. */
export const TIER_CONSENT_ROWS: readonly {
    tier: McpTier
    label: string
    detail: string
    /** A warning line under the row (contract section 3.3). */
    warning?: string
}[] = [
    {
        tier: 'read',
        label: 'See your Caramel account and coupons',
        detail: 'Coupon and deal search, your saved stores, savings and settings.',
    },
    {
        tier: 'write',
        label: 'Make changes for you',
        detail: 'Save stores, change your settings and profile, submit or rate codes, request stores.',
    },
    {
        tier: 'destructive',
        label: 'Delete things (asks each time)',
        detail: 'Remove your saved data. Your AI asks you before every delete.',
        warning: 'Can delete data.',
    },
    {
        tier: 'account',
        label: 'Manage your account',
        detail: 'Export your data and close your account (asks each time).',
        warning: 'Can delete this account.',
    },
    {
        tier: 'connections',
        label: 'See and disconnect AI apps',
        detail: 'List the AI apps connected to Caramel and disconnect them.',
    },
    {
        tier: 'support',
        label: 'Contact Caramel support for you',
        detail: 'Send a question or a problem report to the Caramel team.',
    },
]

const SCOPE_TO_TIER = new Map<string, McpTier>(
    MCP_TIERS.map(tier => [TIER_SCOPE[tier], tier]),
)

/** The tiers a granted scope list carries. Unknown scopes are ignored. */
export function tiersFromScopes(scopes: readonly string[]): McpTier[] {
    const tiers = new Set<McpTier>()
    for (const scope of scopes) {
        const tier = SCOPE_TO_TIER.get(scope)
        if (tier) tiers.add(tier)
    }
    return MCP_TIERS.filter(tier => tiers.has(tier))
}

/** Label for any scope a consent may carry, for the connected-apps list. */
export function scopeLabel(scope: string): string {
    const tier = SCOPE_TO_TIER.get(scope)
    if (tier) {
        return TIER_CONSENT_ROWS.find(row => row.tier === tier)?.label ?? scope
    }
    switch (scope) {
        case 'openid':
            return 'Confirm who you are'
        case 'profile':
            return 'See your name'
        case 'email':
            return 'See your email address'
        case 'offline_access':
            return 'Stay connected while you are away'
        default:
            return scope
    }
}

/**
 * MCP access-token lifetimes (fleet auth window): 30-day access JWT, 365-day
 * refresh. A long stateless access token is safe only because every MCP call
 * re-checks the grant behind it (principal.ts: live consent + revocation
 * watermark). The authorization code stays at 10 minutes.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
export const REFRESH_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60
export const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60

/**
 * Millisecond issue time stamped into every MCP access token. `iat` has
 * one-second resolution and cannot order a token against a Disconnect in the
 * same second; the watermark check needs better than that.
 */
export const ACCESS_TOKEN_ISSUED_AT_MS_CLAIM = 'caramel_iat_ms'
