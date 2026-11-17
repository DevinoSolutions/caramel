// RFC 8414 authorization-server metadata at the BARE path. The spec-correct
// location for an issuer with a path (/api/auth) is the sibling
// /.well-known/oauth-authorization-server/api/auth; some MCP clients probe
// this one directly. Both serve the plugin's document with the public-client
// revocation correction (src/lib/mcp/discovery.ts).
import { authServerMetadataHandler } from '@/lib/mcp/discovery'

export const dynamic = 'force-dynamic'

export const GET = authServerMetadataHandler()
