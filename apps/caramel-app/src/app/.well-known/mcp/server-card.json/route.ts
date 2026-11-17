// MCP server card: how an agent that only knows the domain finds the MCP
// endpoint, its transport and its OAuth metadata in one fetch.
// src/lib/mcp/discovery.ts.
import { APP_VERSION } from '@/lib/env.client'
import { buildMcpServerCard, DISCOVERY_HEADERS } from '@/lib/mcp/discovery'

export const dynamic = 'force-dynamic'

export function GET(): Response {
    return Response.json(buildMcpServerCard(APP_VERSION), {
        headers: DISCOVERY_HEADERS,
    })
}
