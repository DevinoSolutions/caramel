import { DELETE as disconnectApp } from '@/app/api/account/connected-apps/[clientId]/route'
import { POST as mcpPost } from '@/app/api/mcp/route'
import { auth } from '@/lib/auth/auth'
import { mintExtensionSessionForUser } from '@/lib/auth/extensionOAuthSession'
import { BASE_URL } from '@/lib/env.client'
import { MCP_RESOURCE } from '@/lib/mcp/oauthConfig'
import prisma from '@/lib/prisma'
import { NextRequest } from 'next/server'
import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The Caramel MCP OAuth flow end to end on the REAL better-auth instance,
// prisma client and Postgres (no mocks), the way Claude or ChatGPT walk it:
//
//   DCR (public client, no secret) → authorize with PKCE and the MCP resource
//   → consent (the signed query echoed verbatim, scopes narrowed) → token
//   (an at+jwt for aud = /api/mcp) → MCP initialize / tools/list / a tool call
//   on /api/mcp with that bearer → Disconnect from the profile route → the
//   same, still-unexpired token is refused 401 on its next call.
//
// Everything lives in a private namespace and is deleted in afterAll.
const UNIQUE = `mcp-oauth-${Date.now()}`
const EMAIL = `${UNIQUE}@example.com`
const ORIGIN = BASE_URL.replace(/\/+$/, '')
const REDIRECT_URI = 'http://127.0.0.1:33418/callback'

let userId: string
let sessionBearer: string
let clientId: string

function base64url(buffer: Buffer): string {
    return buffer.toString('base64url')
}

async function authCall(
    path: string,
    init: RequestInit & { bearer?: string } = {},
): Promise<Response> {
    const headers = new Headers(init.headers)
    if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`)
    return auth.handler(
        new Request(`${ORIGIN}/api/auth${path}`, { ...init, headers }),
    )
}

async function mcp(
    accessToken: string,
    method: string,
    params: Record<string, unknown>,
    query = '',
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await mcpPost(
        new NextRequest(`${ORIGIN}/api/mcp${query}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: `Bearer ${accessToken}`,
                'mcp-protocol-version': '2025-06-18',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
    )
    const text = await res.text()
    const json = text.startsWith('{')
        ? text
        : (text
              .split('\n')
              .find(line => line.startsWith('data: '))
              ?.slice('data: '.length) ?? '{}')
    return { status: res.status, body: JSON.parse(json || '{}') }
}

/** Walks DCR → authorize → consent → token; returns the access token. */
async function connect(scope: string, grant: string): Promise<string> {
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const authorize = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope,
        state: 'itest-state',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: MCP_RESOURCE,
    })
    const authorizeRes = await authCall(`/oauth2/authorize?${authorize}`, {
        bearer: sessionBearer,
        redirect: 'manual',
    })
    const consentLocation =
        authorizeRes.headers.get('location') ??
        (
            (await authorizeRes
                .clone()
                .json()
                .catch(() => ({}))) as {
                url?: string
            }
        ).url
    if (!consentLocation) {
        throw new Error(
            `authorize did not redirect to consent (status ${authorizeRes.status}): ${await authorizeRes.text()}`,
        )
    }
    const consentUrl = new URL(consentLocation, ORIGIN)
    expect(consentUrl.pathname).toBe('/oauth/consent')

    const consentRes = await authCall('/oauth2/consent', {
        method: 'POST',
        bearer: sessionBearer,
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
            accept: true,
            scope: grant,
            oauth_query: consentUrl.search.replace(/^\?/, ''),
        }),
    })
    if (!consentRes.ok) {
        throw new Error(
            `consent refused (${consentRes.status}): ${await consentRes.text()}`,
        )
    }
    const consent = (await consentRes.json()) as { url?: string }
    const callback = new URL(consent.url ?? '')
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI)
    expect(callback.searchParams.get('state')).toBe('itest-state')
    const code = callback.searchParams.get('code')
    if (!code) throw new Error('consent returned no code')

    const tokenRes = await authCall('/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: clientId,
            code_verifier: verifier,
            resource: MCP_RESOURCE,
        }).toString(),
    })
    if (!tokenRes.ok) {
        throw new Error(
            `token refused (${tokenRes.status}): ${await tokenRes.text()}`,
        )
    }
    const token = (await tokenRes.json()) as {
        access_token: string
        token_type: string
        refresh_token?: string
        scope?: string
    }
    expect(token.token_type.toLowerCase()).toBe('bearer')
    return token.access_token
}

beforeAll(async () => {
    const user = await prisma.user.create({
        data: { name: 'MCP Itest', email: EMAIL, emailVerified: true },
    })
    userId = user.id
    const minted = await mintExtensionSessionForUser(userId)
    if (!minted) throw new Error('could not mint a session for the test user')
    sessionBearer = minted.token

    // Unauthenticated DCR, no token_endpoint_auth_method: the hook makes it
    // a public client (dcrPublicClient.ts), exactly as Claude registers.
    const register = await authCall('/oauth2/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            client_name: `Caramel itest ${UNIQUE}`,
            redirect_uris: [REDIRECT_URI],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            scope: 'openid profile email offline_access caramel:read caramel:write caramel:delete caramel:account caramel:connections caramel:support',
        }),
    })
    if (!register.ok) {
        throw new Error(
            `DCR refused (${register.status}): ${await register.text()}`,
        )
    }
    const registered = (await register.json()) as {
        client_id: string
        client_secret?: string
        token_endpoint_auth_method?: string
    }
    expect(registered.client_secret).toBeUndefined()
    expect(registered.token_endpoint_auth_method).toBe('none')
    clientId = registered.client_id
})

afterAll(async () => {
    await prisma.mcpToolCall.deleteMany({ where: { userId } })
    await prisma.mcpGrantRevocation.deleteMany({ where: { userId } })
    await prisma.oauthAccessToken.deleteMany({ where: { userId } })
    await prisma.oauthRefreshToken.deleteMany({ where: { userId } })
    await prisma.oauthConsent.deleteMany({ where: { userId } })
    if (clientId) {
        await prisma.oauthClient.deleteMany({ where: { clientId } })
    }
    await prisma.session.deleteMany({ where: { userId } })
    await prisma.account.deleteMany({ where: { userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
})

describe('Caramel MCP over OAuth 2.1 (real better-auth + Postgres)', () => {
    it('connects with PKCE, serves the granted tools, and Disconnect stops the token', async () => {
        const accessToken = await connect(
            'openid profile email offline_access caramel:read caramel:write caramel:connections',
            // The user unticks write on the consent screen.
            'openid profile email offline_access caramel:read caramel:connections',
        )

        const init = await mcp(accessToken, 'initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'itest', version: '1' },
        })
        expect(init.status).toBe(200)
        expect(
            (init.body.result as { serverInfo: { name: string } }).serverInfo
                .name,
        ).toBe('Caramel')

        const list = await mcp(
            accessToken,
            'tools/list',
            {},
            '?tools=directory',
        )
        const names = (
            list.body.result as { tools: { name: string }[] }
        ).tools.map(tool => tool.name)
        expect(names).toContain('get_profile')
        expect(names).toContain('list_connections')
        // write was not granted, so no write tool is listed.
        expect(names).not.toContain('update_settings')

        const profile = await mcp(
            accessToken,
            'tools/call',
            { name: 'get_profile', arguments: {} },
            '?tools=directory',
        )
        const profileText = (
            profile.body.result as { content: { text: string }[] }
        ).content[0]?.text
        expect(profileText).toContain(EMAIL)

        // A tool that runs a same-origin-gated route through the bridge.
        const favorites = await mcp(
            accessToken,
            'tools/call',
            { name: 'list_favorite_stores', arguments: {} },
            '?tools=directory',
        )
        const favoritesResult = favorites.body.result as {
            isError?: boolean
            content: { text: string }[]
        }
        expect(
            favoritesResult.isError,
            favoritesResult.content[0]?.text,
        ).toBeFalsy()

        const denied = await mcp(accessToken, 'tools/call', {
            name: 'execute_typescript',
            arguments: {
                code: `try { await external_update_settings({ growthPromptsEnabled: false }); return 'ran' } catch (e) { return String(e.message) }`,
            },
        })
        expect(JSON.stringify(denied.body)).toContain('SCOPE_MISSING')

        // The refusal is audited; the read is not.
        const audited = await prisma.mcpToolCall.findMany({
            where: { userId, clientId },
            select: { tool: true, ok: true, error: true },
        })
        expect(audited).toContainEqual({
            tool: 'update_settings',
            ok: false,
            error: 'SCOPE_MISSING',
        })
        expect(audited.some(row => row.tool === 'get_profile')).toBe(false)

        // Disconnect from the profile page's route.
        const res = await disconnectApp(
            new NextRequest(
                `${ORIGIN}/api/account/connected-apps/${encodeURIComponent(clientId)}`,
                {
                    method: 'DELETE',
                    headers: {
                        authorization: `Bearer ${sessionBearer}`,
                        origin: ORIGIN,
                        host: new URL(ORIGIN).host,
                    },
                },
            ),
        )
        expect(res.status).toBe(200)

        const after = await mcp(accessToken, 'tools/list', {})
        expect(after.status).toBe(401)
    })

    it('runs the account and coupon tools against the real database, and a confirmed delete across two programs', async () => {
        const accessToken = await connect(
            'openid profile email offline_access caramel:read caramel:write caramel:delete caramel:account',
            'openid profile email offline_access caramel:read caramel:write caramel:delete caramel:account',
        )
        const program = `const calls = {
  search_coupons: () => external_search_coupons({ store: 'nike.com', limit: 3 }),
  get_store_deals: () => external_get_store_deals({ store: 'nike.com' }),
  search_stores: () => external_search_stores({ query: 'nik' }),
  list_top_stores: () => external_list_top_stores({}),
  list_recently_worked_coupons: () => external_list_recently_worked_coupons({}),
  get_catalog_overview: () => external_get_catalog_overview({}),
  list_coupon_sources: () => external_list_coupon_sources({}),
  get_account_overview: () => external_get_account_overview({}),
  get_settings: () => external_get_settings({}),
  update_settings: () => external_update_settings({ showTipsAndPrompts: false }),
  update_profile: () => external_update_profile({ firstName: 'Ada' }),
  add_favorite_store: () => external_add_favorite_store({ store: 'nike.com' }),
  list_favorite_stores: () => external_list_favorite_stores({}),
  remove_favorite_store: () => external_remove_favorite_store({ store: 'nike.com' }),
  export_data: () => external_export_data({}),
  billing_status: () => external_billing_status({}),
}
const failures = {}
for (const [name, run] of Object.entries(calls)) {
  try { await run() } catch (error) { failures[name] = String(error.message) }
}
let token = null
try { await external_delete_my_data({}) } catch (error) {
  const message = String(error.message)
  token = JSON.parse(message.slice(message.indexOf('{'))).next.args.confirmToken
}
return { failures, token }`
        const first = await mcp(accessToken, 'tools/call', {
            name: 'execute_typescript',
            arguments: { code: program },
        })
        const firstText =
            (first.body.result as { content: { text: string }[] }).content[0]
                ?.text ?? ''
        const parsed = JSON.parse(firstText) as {
            result?: { failures: Record<string, string>; token: string | null }
        }
        expect(parsed.result?.failures).toEqual({})
        const token = parsed.result?.token
        expect(token).toMatch(/^\d+\./)

        const settings = await prisma.user.findUnique({
            where: { id: userId },
            select: { firstName: true },
        })
        expect(settings?.firstName).toBe('Ada')

        // The user confirmed: a NEW program spends the token once.
        const second = await mcp(accessToken, 'tools/call', {
            name: 'execute_typescript',
            arguments: {
                code: `return await external_delete_my_data({ confirmToken: ${JSON.stringify(token)} })`,
            },
        })
        const secondText = JSON.stringify(second.body)
        expect(secondText).not.toContain('CONFIRMATION_REQUIRED')
        expect(secondText).not.toContain('TOOL_FAILED')

        const audited = await prisma.mcpToolCall.findFirst({
            where: { userId, tool: 'delete_my_data', ok: true },
            select: { confirmNonce: true },
        })
        expect(audited?.confirmNonce).toBeTruthy()
    })

    it('refuses a token minted for another audience', async () => {
        const { status } = await mcp('not-a-jwt', 'tools/list', {})
        expect(status).toBe(401)
    })
})
