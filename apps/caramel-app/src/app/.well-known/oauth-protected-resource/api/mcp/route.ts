// RFC 9728 §3.1: the metadata URL for resource <origin>/api/mcp, with the
// resource path appended. Same document as the bare route.
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
