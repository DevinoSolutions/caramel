import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/mcp over the wire (JSON-RPC through fetch-to-node and
// @mastra/mcp's Streamable HTTP handler), with the token check mocked:
//
//   - a missing or rejected token is a 401 carrying the RFC 9728 challenge;
//   - tools/list on ?tools=directory is EXACTLY the registry's reachable tools
//     with their annotations (MCP parity: what the server lists is what the
//     registry declares, and nothing outside the grant);
//   - the default surface is Code Mode (search_tools + execute_typescript), and
//     a program's external_* calls run through the same guard;
//   - a granted tool called by name on the Code Mode URL still runs;
//   - a destructive call answers isError with the CONFIRMATION_REQUIRED text.
//
// tests/integration/mcp-oauth.itest.ts runs the same route behind a real
// OAuth token and database.

const { resolveMock, auditMock } = vi.hoisted(() => ({
    resolveMock: vi.fn(),
    auditMock: vi.fn(async () => undefined),
}))
vi.mock('@/lib/mcp/principal', () => ({ resolveMcpPrincipal: resolveMock }))
vi.mock('@/lib/mcp/audit', () => ({ recordMcpCall: auditMock }))
vi.mock('@/lib/prisma', () => ({
    default: {
        mcpConfirmNonce: {
            create: vi.fn(async () => ({})),
            deleteMany: vi.fn(async () => ({ count: 0 })),
        },
    },
}))

import { POST } from '@/app/api/mcp/route'
import { BASE_URL } from '@/lib/env.client'
import { isReachable } from '@/lib/mcp/guard'
import { MCP_TIERS, TIER_SCOPE, type McpTier } from '@/lib/mcp/oauthConfig'
import { CARAMEL_TOOLS } from '@/lib/mcp/tools/registry'

const origin = BASE_URL.replace(/\/+$/, '')

function principal(tiers: readonly McpTier[]) {
    return {
        userId: 'user-1',
        clientId: 'client-1',
        scopes: tiers.map(tier => TIER_SCOPE[tier]),
        tiers,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        session: {
            user: {
                id: 'user-1',
                name: 'Ada Shopper',
                email: 'ada@example.com',
                emailVerified: true,
                createdAt: new Date('2026-01-02T00:00:00Z'),
            },
            session: { id: 'mcp-session', userId: 'user-1' },
        },
    }
}

let nextId = 1
async function rpc(
    method: string,
    params: Record<string, unknown>,
    query = '',
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await POST(
        new NextRequest(`${origin}/api/mcp${query}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: 'Bearer test-token',
                'mcp-protocol-version': '2025-06-18',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: nextId++,
                method,
                params,
            }),
        }),
    )
    const text = await res.text()
    // A streamable-HTTP answer may come as one SSE event.
    const json = text.startsWith('{')
        ? text
        : (text
              .split('\n')
              .find(line => line.startsWith('data: '))
              ?.slice('data: '.length) ?? '{}')
    return { status: res.status, body: JSON.parse(json) }
}

type ToolsList = {
    tools: { name: string; annotations?: Record<string, unknown> }[]
}
type CallResult = { isError?: boolean; content: { text: string }[] }

beforeEach(() => {
    resolveMock.mockReset()
    resolveMock.mockResolvedValue({ ok: true, principal: principal(MCP_TIERS) })
})

describe('POST /api/mcp', () => {
    it('answers 401 with the protected-resource challenge without a token', async () => {
        resolveMock.mockResolvedValue({
            ok: false,
            error: 'invalid_request',
            description: 'Missing Bearer access token.',
        })
        const res = await POST(
            new NextRequest(`${origin}/api/mcp`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}',
            }),
        )
        expect(res.status).toBe(401)
        expect(res.headers.get('www-authenticate')).toBe(
            `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        )
    })

    it('names invalid_token in the challenge for a rejected token', async () => {
        resolveMock.mockResolvedValue({
            ok: false,
            error: 'invalid_token',
            description: 'The access token is invalid or expired.',
        })
        const { status } = await rpc('tools/list', {})
        expect(status).toBe(401)
    })

    it('initializes as Caramel', async () => {
        const { status, body } = await rpc('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'vitest', version: '1' },
        })
        expect(status).toBe(200)
        const result = body.result as {
            serverInfo: { name: string }
            instructions?: string
        }
        expect(result.serverInfo.name).toBe('Caramel')
        expect(result.instructions).toContain('Caramel')
    })

    it.each([
        [['read'] as McpTier[]],
        [['read', 'write'] as McpTier[]],
        [[...MCP_TIERS]],
        [['support'] as McpTier[]],
    ])(
        '?tools=directory lists exactly the registry tools %j reaches',
        async tiers => {
            resolveMock.mockResolvedValue({
                ok: true,
                principal: principal(tiers),
            })
            const { body } = await rpc('tools/list', {}, '?tools=directory')
            const listed = (body.result as ToolsList).tools
            const expected = CARAMEL_TOOLS.filter(tool =>
                isReachable(tool, tiers),
            )
            expect(listed.map(tool => tool.name).sort()).toEqual(
                expected.map(tool => tool.id).sort(),
            )
            for (const tool of expected) {
                const wire = listed.find(t => t.name === tool.id)
                expect(wire?.annotations).toMatchObject({
                    title: tool.title,
                    readOnlyHint: tool.annotations.readOnlyHint,
                    destructiveHint: tool.annotations.destructiveHint,
                })
            }
        },
    )

    it('serves Code Mode by default', async () => {
        const { body } = await rpc('tools/list', {})
        expect(
            (body.result as ToolsList).tools.map(t => t.name).sort(),
        ).toEqual(['execute_typescript', 'search_tools'])
    })

    it('search_tools declares only reachable tools', async () => {
        resolveMock.mockResolvedValue({
            ok: true,
            principal: principal(['read']),
        })
        const { body } = await rpc('tools/call', {
            name: 'search_tools',
            arguments: {},
        })
        const result = body.result as CallResult & {
            structuredContent?: { tools: { id: string }[] }
        }
        const text = result.content[0]?.text ?? ''
        expect(text).toContain('external_get_profile')
        expect(text).not.toContain('external_delete_account')
    })

    it('runs a program whose external_* calls go through the guard', async () => {
        resolveMock.mockResolvedValue({
            ok: true,
            principal: principal(['read']),
        })
        const { body } = await rpc('tools/call', {
            name: 'execute_typescript',
            arguments: {
                code: `const profile = await external_get_profile({});
let refused = '';
try { await external_update_settings({ growthPromptsEnabled: false }); }
catch (error) { refused = String(error.message).split(':')[0]; }
return { name: profile.name, refused };`,
            },
        })
        const text = (body.result as CallResult).content[0]?.text ?? ''
        expect(text).toContain('Ada Shopper')
        expect(text).toContain('SCOPE_MISSING')
    })

    it('runs a granted tool called by name on the Code Mode URL', async () => {
        const { body } = await rpc('tools/call', {
            name: 'get_profile',
            arguments: {},
        })
        const result = body.result as CallResult
        expect(result.isError).toBeFalsy()
        expect(result.content[0]?.text).toContain('ada@example.com')
    })

    it('answers a destructive first call with CONFIRMATION_REQUIRED', async () => {
        const { body } = await rpc(
            'tools/call',
            { name: 'delete_account', arguments: {} },
            '?tools=directory',
        )
        const result = body.result as CallResult
        expect(result.isError).toBe(true)
        expect(result.content[0]?.text).toMatch(/^CONFIRMATION_REQUIRED: /)
    })

    it('answers a named call with bad arguments with VALIDATION_ERROR', async () => {
        const { body } = await rpc(
            'tools/call',
            { name: 'request_scopes', arguments: { tiers: ['nope'] } },
            '?tools=directory',
        )
        const result = body.result as CallResult
        expect(result.isError).toBe(true)
        expect(result.content[0]?.text).toMatch(/^VALIDATION_ERROR: tiers/)
    })
})
