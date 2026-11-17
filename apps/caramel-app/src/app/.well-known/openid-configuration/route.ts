// OpenID Connect discovery at the origin root. better-auth also answers it
// under its basePath (/api/auth/.well-known/openid-configuration); MCP
// clients that probe the root find the same document here
// (src/lib/mcp/discovery.ts).
import { openIdConfigurationHandler } from '@/lib/mcp/discovery'

export const dynamic = 'force-dynamic'

export const GET = openIdConfigurationHandler()
