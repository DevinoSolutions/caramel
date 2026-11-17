// src/lib/mcp/discovery.ts
//
// The documents an MCP client reads before its first call:
//
//   /.well-known/oauth-protected-resource[/api/mcp]   RFC 9728 (the 401 points here)
//   /.well-known/oauth-authorization-server[/api/auth] RFC 8414
//   /.well-known/openid-configuration                 OIDC discovery alias
//   /.well-known/mcp/server-card.json                  MCP server card
//
// The OAuth documents come from the better-auth plugin's own factories, never
// hand-rolled, with two corrections:
//   - authorization server: "none" is appended to
//     revocation_endpoint_auth_methods_supported. Every AI client registers as
//     a public client (DCR, no secret); without "none" a spec-abiding client
//     concludes it cannot revoke, and Disconnect in the client leaves the
//     grant standing here. The endpoint itself accepts public clients.
//   - protected resource: authorization_servers is the real issuer (it
//     includes /api/auth; the plugin's default drops the basePath), and
//     dpop_signing_alg_values_supported is removed: principal.ts refuses
//     sender-constrained tokens, so advertising DPoP would invite clients
//     into tokens this resource rejects.
import { auth } from '@/lib/auth/auth'
import { BASE_URL } from '@/lib/env.client'
import {
    oauthProviderAuthServerMetadata,
    oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider'
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client'
import * as Sentry from '@sentry/nextjs'
import { MCP_RESOURCE, MCP_SCOPES, MCP_SERVER_NAME } from './oauthConfig'
import { authIssuer } from './principal'

const origin = BASE_URL.replace(/\/+$/, '')

/** The /docs section that explains connecting an AI app (docsContent.ts). */
export const MCP_DOCS_URL = `${origin}/docs#mcp`
const PROTECTED_RESOURCE_URL = `${origin}/.well-known/oauth-protected-resource`

/** The token_endpoint_auth_method every DCR-registered AI client uses. */
export const PUBLIC_CLIENT_AUTH_METHOD = 'none'
const REVOCATION_AUTH_METHODS_KEY = 'revocation_endpoint_auth_methods_supported'

/** Append "none" to the advertised revocation methods, idempotently. */
export function withPublicClientRevocation(
    metadata: Record<string, unknown>,
): Record<string, unknown> {
    const advertised = metadata[REVOCATION_AUTH_METHODS_KEY]
    if (!Array.isArray(advertised)) return metadata
    if (advertised.includes(PUBLIC_CLIENT_AUTH_METHOD)) return metadata
    return {
        ...metadata,
        [REVOCATION_AUTH_METHODS_KEY]: [
            ...advertised,
            PUBLIC_CLIENT_AUTH_METHOD,
        ],
    }
}

type MetadataHandler = (request: Request) => Promise<Response>

/** A plugin metadata handler with `transform` applied to its JSON body. */
function transformJson(
    base: MetadataHandler,
    document: string,
    transform: (metadata: Record<string, unknown>) => Record<string, unknown>,
): MetadataHandler {
    return async request => {
        const response = await base(request)
        const contentType = response.headers.get('content-type') ?? ''
        if (!response.ok || !contentType.includes('json')) return response
        let metadata: Record<string, unknown>
        try {
            metadata = (await response.clone().json()) as Record<
                string,
                unknown
            >
        } catch (error) {
            // Loud, never silent; the client still gets the plugin's answer.
            Sentry.captureException(error, {
                tags: { surface: 'oauth-discovery', document },
            })
            return response
        }
        return new Response(JSON.stringify(transform(metadata)), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        })
    }
}

export function authServerMetadataHandler(): MetadataHandler {
    return transformJson(
        oauthProviderAuthServerMetadata(auth) as MetadataHandler,
        'oauth-authorization-server',
        withPublicClientRevocation,
    )
}

export function openIdConfigurationHandler(): MetadataHandler {
    return transformJson(
        oauthProviderOpenIdConfigMetadata(auth) as MetadataHandler,
        'openid-configuration',
        withPublicClientRevocation,
    )
}

// Built lazily: the resource client reads auth.options at construction.
let resourceClient: ReturnType<typeof oauthProviderResourceClient> | null = null

export async function buildProtectedResourceMetadata() {
    resourceClient ??= oauthProviderResourceClient(auth)
    const metadata = await resourceClient
        .getActions()
        .getProtectedResourceMetadata({
            resource: MCP_RESOURCE,
            authorization_servers: [await authIssuer()],
            // offline_access must be listed: DCR clients register the scopes
            // they read here, and better-auth refuses an authorize-time scope
            // the client did not register (no refresh token otherwise).
            scopes_supported: [...MCP_SCOPES, 'offline_access'],
            bearer_methods_supported: ['header'],
            resource_name: MCP_SERVER_NAME,
            resource_documentation: MCP_DOCS_URL,
        })
    const { dpop_signing_alg_values_supported: _dpop, ...rest } = metadata
    return rest
}

/** Same shape the rest of the Devino fleet serves. */
export function buildMcpServerCard(version: string) {
    return {
        name: 'com.grabcaramel/caramel',
        title: MCP_SERVER_NAME,
        description:
            'Official MCP server for Caramel, the free coupon finder. Search coupon codes and the best deals for any supported store, see which codes shoppers confirmed recently, submit or rate codes, request stores, and manage your Caramel account: profile, settings, saved stores, savings, data export and account deletion. OAuth 2.1; you choose the permission groups, and destructive actions ask for confirmation.',
        version,
        websiteUrl: origin,
        documentationUrl: MCP_DOCS_URL,
        serverInfo: { name: MCP_SERVER_NAME, title: MCP_SERVER_NAME, version },
        endpoint: MCP_RESOURCE,
        transport: { type: 'streamable-http', endpoint: MCP_RESOURCE },
        remotes: [
            {
                type: 'streamable-http',
                url: MCP_RESOURCE,
                authentication: {
                    type: 'oauth2',
                    resourceMetadata: PROTECTED_RESOURCE_URL,
                },
            },
            {
                type: 'streamable-http',
                url: `${MCP_RESOURCE}?tools=directory`,
                authentication: {
                    type: 'oauth2',
                    resourceMetadata: PROTECTED_RESOURCE_URL,
                },
            },
        ],
        capabilities: { tools: { listChanged: false } },
    }
}

/** Headers for a public discovery document. */
export const DISCOVERY_HEADERS = {
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
} as const
