// src/lib/auth/dcrPublicClient.ts
//
// Dynamic client registration (RFC 7591) for the MCP OAuth server.
//
// @better-auth/oauth-provider 1.7 follows RFC 7591 and registers a request
// that OMITS `token_endpoint_auth_method` as client_secret_basic, minting a
// secret the client never asked for and may not store. Claude Code, Cursor and
// most MCP clients leave the field out and then authenticate at /oauth2/token
// as public PKCE clients, which that secret would break.
//
// This `before` hook rewrites an omitted method to "none" so those clients stay
// public PKCE clients. An explicit method (Microsoft 365 Copilot asks for
// client_secret_post) is never touched: the provider mints and returns that
// secret itself. PKCE stays required for every client.
import type { BetterAuthPlugin } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'

const OAUTH_REGISTER_PATH = '/oauth2/register'

export function dynamicRegistrationDefaultsToPublicClient() {
    return {
        id: 'caramel-dcr-defaults-to-public-client',
        hooks: {
            before: [
                {
                    matcher: context => context.path === OAUTH_REGISTER_PATH,
                    handler: createAuthMiddleware(async context => {
                        const body = context.body as
                            { token_endpoint_auth_method?: unknown } | undefined
                        if (
                            !body ||
                            body.token_endpoint_auth_method !== undefined
                        )
                            return
                        return {
                            context: {
                                body: {
                                    ...body,
                                    token_endpoint_auth_method: 'none',
                                },
                            },
                        }
                    }),
                },
            ],
        },
    } satisfies BetterAuthPlugin
}
