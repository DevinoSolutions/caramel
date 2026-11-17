// RFC 8414 authorization-server metadata at the issuer-path location
// (issuer = <origin>/api/auth). See the bare sibling route and
// src/lib/mcp/discovery.ts.
import { authServerMetadataHandler } from '@/lib/mcp/discovery'

export const dynamic = 'force-dynamic'

export const GET = authServerMetadataHandler()
