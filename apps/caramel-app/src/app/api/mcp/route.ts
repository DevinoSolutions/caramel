// src/app/api/mcp/route.ts
//
// The Caramel MCP endpoint (remote Streamable HTTP, OAuth 2.1 bearer).
//
//   POST /api/mcp                  Code Mode: search_tools + execute_typescript
//   POST /api/mcp?tools=directory  every granted tool by name (directories)
//
// Every request is self-contained (the server runs `legacy: 'stateless'`):
// verify the access token and the live grant behind it (principal.ts), pick
// the cached MCPServer for the surface and the granted tiers (server.ts), and
// hand it the request as Node req/res through fetch-to-node. A missing or
// rejected token answers 401 with the RFC 9728 challenge that starts the OAuth
// flow in every MCP client.
//
// withRoute adds Sentry error handling; it declares no rate limit because the
// AI vendors call from shared egress IPs (a per-IP bucket would throttle every
// Claude user together). The operations the tools reach are rate-limited per
// user inside the route bridge (routeBridge.ts, `mcp:<userId>` key).
import { withRoute } from '@/lib/api/withRoute'
import { PRINCIPAL_EXTRA_KEY } from '@/lib/mcp/guard'
import {
    MCP_RESOURCE,
    PROTECTED_RESOURCE_METADATA_URL,
} from '@/lib/mcp/oauthConfig'
import { resolveMcpPrincipal, type McpPrincipal } from '@/lib/mcp/principal'
import { mcpServerFor, type McpSurface } from '@/lib/mcp/server'
import type { MCPServer } from '@mastra/mcp'
import { toFetchResponse, toReqRes } from 'fetch-to-node'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** One JSON-RPC message; an execute_typescript program is the largest. */
const MCP_MAX_BODY_BYTES = 256 * 1024

const MCP_PATH = '/api/mcp'

function challenge(
    error: 'invalid_request' | 'invalid_token',
    description: string,
): NextResponse {
    const params = [
        `resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`,
        // RFC 6750 §3.1: a request with no credential carries no error code.
        ...(error === 'invalid_request'
            ? []
            : [
                  `error="${error}"`,
                  `error_description="${description.replace(/"/g, "'")}"`,
              ]),
    ]
    return NextResponse.json(
        { error, error_description: description },
        {
            status: 401,
            headers: { 'WWW-Authenticate': `Bearer ${params.join(', ')}` },
        },
    )
}

function jsonRpcError(status: number, code: number, message: string) {
    return NextResponse.json(
        { jsonrpc: '2.0', error: { code, message }, id: null },
        { status },
    )
}

/** The surface a URL asks for. Anything but `tools=directory` is Code Mode. */
function surfaceOf(url: URL): McpSurface {
    return url.searchParams.get('tools') === 'directory'
        ? 'directory'
        : 'code_mode'
}

/** The tool a single `tools/call` names, or undefined. */
function toolCallName(body: unknown): string | undefined {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return
    const { method, params } = body as {
        method?: unknown
        params?: { name?: unknown }
    }
    if (method !== 'tools/call') return
    return typeof params?.name === 'string' ? params.name : undefined
}

/**
 * Under Code Mode a client may still call a granted tool by name (some send
 * a cached tool name): that one call runs on the directory server for the
 * same tiers, through the same guard. tools/list and everything else stay on
 * the Code Mode server.
 */
async function serverForRequest(
    surface: McpSurface,
    principal: McpPrincipal,
    body: unknown,
): Promise<MCPServer> {
    const configured = mcpServerFor(surface, principal.tiers)
    const name = toolCallName(body)
    if (surface !== 'code_mode' || !name) return configured
    if (name === 'search_tools' || name === 'execute_typescript') {
        return configured
    }
    const directory = mcpServerFor('directory', principal.tiers)
    const listed = await directory.getToolListInfo()
    return listed.tools.some(tool => tool.name === name || tool.id === name)
        ? directory
        : configured
}

async function readJsonBody(
    req: NextRequest,
): Promise<{ ok: true; body: unknown } | { ok: false; res: NextResponse }> {
    const text = await req.text()
    if (Buffer.byteLength(text, 'utf8') > MCP_MAX_BODY_BYTES) {
        return {
            ok: false,
            res: jsonRpcError(
                413,
                -32600,
                `Request body is larger than ${MCP_MAX_BODY_BYTES} bytes.`,
            ),
        }
    }
    try {
        return { ok: true, body: JSON.parse(text) as unknown }
    } catch {
        return {
            ok: false,
            res: jsonRpcError(400, -32700, 'Parse error: body is not JSON.'),
        }
    }
}

async function handleMcp(req: NextRequest): Promise<NextResponse> {
    const result = await resolveMcpPrincipal(req.headers)
    if (!result.ok) {
        return challenge(result.error, result.description)
    }
    const { principal } = result
    const url = new URL(req.url)

    let body: unknown
    if (req.method === 'POST') {
        const parsed = await readJsonBody(req)
        if (!parsed.ok) return parsed.res
        body = parsed.body
    }

    const server = await serverForRequest(surfaceOf(url), principal, body)

    // fetch-to-node needs a Request whose body it can stream; the body was
    // already read above, so hand it a bodiless copy and attach the parsed
    // JSON where @mastra/mcp's startHTTP looks for it (`req.body`).
    const bodiless = new Request(req.url, {
        method: req.method,
        headers: req.headers,
    })
    const { req: nodeReq, res: nodeRes } = toReqRes(bodiless)
    Object.assign(nodeReq, {
        body,
        auth: {
            token: '[verified]',
            clientId: principal.clientId,
            scopes: [...principal.scopes],
            expiresAt: Math.floor(principal.expiresAt.getTime() / 1000),
            resource: new URL(MCP_RESOURCE),
            extra: { [PRINCIPAL_EXTRA_KEY]: principal, sub: principal.userId },
        },
    })

    await server.startHTTP({
        url: new URL(MCP_PATH + url.search, url.origin),
        httpPath: MCP_PATH,
        req: nodeReq,
        res: nodeRes,
    })
    const response = await toFetchResponse(nodeRes)
    return new NextResponse(response.body, {
        status: response.status,
        headers: response.headers,
    })
}

export const POST = withRoute(
    { method: 'POST', routeName: 'mcp' },
    async ({ req }) => handleMcp(req),
)

export const GET = withRoute(
    { method: 'GET', routeName: 'mcp' },
    async ({ req }) => handleMcp(req),
)

export const DELETE = withRoute(
    { method: 'DELETE', routeName: 'mcp' },
    async ({ req }) => handleMcp(req),
)
