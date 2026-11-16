// RFC 9728 protected-resource metadata for the MCP endpoint: the document
// the /api/mcp 401 challenge points at. src/lib/mcp/discovery.ts.
import {
    buildProtectedResourceMetadata,
    DISCOVERY_HEADERS,
} from '@/lib/mcp/discovery'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
    return Response.json(await buildProtectedResourceMetadata(), {
        headers: DISCOVERY_HEADERS,
    })
}
