import { withRoute } from '@/lib/api/withRoute'
import { listConnectedApps } from '@/lib/mcp/connectedApps'
import { NextResponse } from 'next/server'

// GET /api/account/connected-apps: the AI apps the signed-in user connected
// to Caramel over MCP (one entry per OAuth client), for the profile page's
// "Connected AI apps" section and the MCP list_connections tool.
export const GET = withRoute(
    {
        method: 'GET',
        routeName: 'account/connected-apps',
        rateLimit: 'read',
        origin: true,
        auth: 'session',
    },
    async ({ session }) => {
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const apps = await listConnectedApps(session.user.id)
        return NextResponse.json({ apps })
    },
)
